// ── BusinessDO — one instance per business; all of that business's books ──
// Entities live as individual storage keys `<kind>:<id>` (kinds: user, account,
// txn, bankacct, import, staged, vendor, item, purchase, recon, lock).
// `meta` is the business profile. `seq` is a monotonic mutation counter.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

const ENTITY_KINDS = new Set([
  'user', 'account', 'txn', 'bankacct', 'import', 'staged',
  'vendor', 'item', 'purchase', 'recon', 'lock',
  'aiusage', 'aisetting',
]);

// Structural double-entry invariants, enforced server-side no matter what the
// client sends (full account/lock validation lives in lib/posting.js).
function txnInvariantBreach(t) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) return 'bad date';
  if (!['staged', 'posted', 'void'].includes(t.status)) return 'bad status';
  if (!Array.isArray(t.lines) || t.lines.length < 2) return 'needs 2+ lines';
  let sum = 0;
  for (const l of t.lines) {
    if (!l?.accountId || !Number.isInteger(l.amountCents) || l.amountCents === 0) return 'bad line';
    sum += l.amountCents;
  }
  return sum === 0 ? null : 'unbalanced lines';
}

export class BusinessDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/b\/[^/]+/, '') || '/';

    if (path === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const pair = new WebSocketPair();
      // Hibernation API — the DO sleeps between messages instead of billing
      // wall-clock duration per open socket (kickoff 0; Muse outage lesson).
      this.state.acceptWebSocket(pair[1]);
      // Role rides the attachment so viewer write-blocking survives hibernation
      // (WS messages bypass the Worker middleware after the upgrade).
      pair[1].serializeAttachment({
        device: url.searchParams.get('device') || '',
        role: req.headers.get('X-Bo-Role') || 'viewer',
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // internal gate for the AI route: current month's spend + the kill switches
    if (path === '/_ai/check' && req.method === 'GET') {
      const settings = (await this.state.storage.get('aisetting:ai')) || {};
      const month = new Date().toISOString().slice(0, 7);
      let spentMicros = 0;
      for (const v of (await this.state.storage.list({ prefix: 'aiusage:' })).values()) {
        if (v.month === month) spentMicros += v.costMicros || 0;
      }
      return json({
        paused: !!settings.paused,
        budgetMicros: (settings.monthlyBudgetCents || 0) * 10000,
        spentMicros,
      });
    }

    // internal: Muse → Back Office inbound rows (routes/sync.js, behind SYNC_TOKEN).
    // Idempotency lives HERE, atomically in the single writer: a row whose id
    // already exists in ANY status is left alone — except a still-'pending' row,
    // which takes the newer push (Muse historical edits before approval). An
    // approved/skipped row is never reverted by a re-push.
    if (path === '/_sync/inbound' && req.method === 'POST') {
      const { rows } = await req.json();
      if (!Array.isArray(rows) || rows.length > 200) return json({ error: 'bad rows' }, 400);
      const now = Date.now();
      const fresh = [];
      let updated = 0, skipped = 0;
      for (const r of rows) {
        if (!r?.id || !ENTITY_KINDS.has('staged')) continue;
        const existing = await this.state.storage.get(`staged:${r.id}`);
        if (!existing) { fresh.push({ ...r, createdAt: now, updatedAt: now, updatedBy: 'sync' }); continue; }
        if (existing.status === 'pending') {
          if (existing.amountCents !== r.amountCents || existing.desc !== r.desc || existing.date !== r.date || existing.memo !== r.memo) {
            fresh.push({ ...existing, ...r, updatedAt: now, updatedBy: 'sync' });
            updated++;
          } else skipped++;
        } else skipped++;
      }
      if (fresh.length) {
        const res = await this.apply({ op: 'entity.bulkUpsert', kind: 'staged', values: fresh, device: '' });
        if (res.rejected) return json({ error: res.reason }, 400);
      }
      return json({ ok: true, created: fresh.length - updated, updated, skipped });
    }

    if (path === '/state' && req.method === 'GET') return this.snapshot();
    if (path === '/state' && req.method === 'POST') {
      const op = await req.json();
      const result = await this.apply(op);
      return json(result, result.rejected ? 409 : 200);
    }
    return json({ error: 'not found' }, 404);
  }

  async snapshot() {
    const out = { meta: null, entities: {}, seq: 0, schema_version: 1 };
    const all = await this.state.storage.list();
    for (const [k, v] of all) {
      if (k === 'meta') out.meta = v;
      else if (k === 'seq') out.seq = v;
      else if (k === 'schema_version') out.schema_version = v;
      else {
        const i = k.indexOf(':');
        if (i > 0) {
          const kind = k.slice(0, i);
          if (ENTITY_KINDS.has(kind)) (out.entities[kind] ||= []).push(v);
        }
      }
    }
    return json(out);
  }

  // op: { op:'entity.upsert'|'entity.delete'|'meta.set', kind?, value?, id?, device? }
  async apply(op) {
    if (op.op === 'meta.set') {
      await this.state.storage.put('meta', op.value);
      return this.commit(op);
    }
    if (op.op === 'entity.upsert') {
      if (!ENTITY_KINDS.has(op.kind) || !op.value?.id) return { rejected: true, reason: 'bad op' };
      if (op.kind === 'txn') {
        const bad = txnInvariantBreach(op.value);
        if (bad) return { rejected: true, reason: bad };
      }
      const key = `${op.kind}:${op.value.id}`;
      const existing = await this.state.storage.get(key);
      // Stale-write guard (Muse pattern): an older-stamped write never clobbers
      // a newer one. Unstamped writes apply (back-compat with the guard off).
      if (existing?.updatedAt && op.value.updatedAt && op.value.updatedAt < existing.updatedAt) {
        return { rejected: true, reason: 'stale', storedUpdatedAt: existing.updatedAt };
      }
      await this.state.storage.put(key, op.value);
      return this.commit(op);
    }
    if (op.op === 'entity.bulkUpsert') {
      if (!ENTITY_KINDS.has(op.kind) || !Array.isArray(op.values) || op.values.length > 500) {
        return { rejected: true, reason: 'bad op' };
      }
      let applied = 0;
      for (const v of op.values) {
        if (!v?.id) continue;
        const key = `${op.kind}:${v.id}`;
        const existing = await this.state.storage.get(key);
        if (existing?.updatedAt && v.updatedAt && v.updatedAt < existing.updatedAt) continue;
        await this.state.storage.put(key, v);
        applied++;
      }
      return this.commit(op, { applied });
    }
    if (op.op === 'entity.delete') {
      if (!ENTITY_KINDS.has(op.kind) || !op.id) return { rejected: true, reason: 'bad op' };
      await this.state.storage.delete(`${op.kind}:${op.id}`);
      return this.commit(op);
    }
    return { rejected: true, reason: 'unknown op' };
  }

  async commit(op, extra = {}) {
    const seq = ((await this.state.storage.get('seq')) || 0) + 1;
    await this.state.storage.put('seq', seq);
    this.broadcast({ type: 'op', seq, op }, op.device);
    return { ok: true, seq, ...extra };
  }

  broadcast(msg, exceptDevice) {
    const payload = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment() || {};
        if (exceptDevice && att.device === exceptDevice) continue;
        ws.send(payload);
      } catch { /* socket already gone */ }
    }
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'op' && msg.op) {
      const att = (() => { try { return ws.deserializeAttachment() || {}; } catch { return {}; } })();
      if (att.role === 'viewer') { ws.send(JSON.stringify({ type: 'ack', clientId: msg.clientId, rejected: true, reason: 'read only' })); return; }
      const result = await this.apply(msg.op);
      ws.send(JSON.stringify({ type: 'ack', clientId: msg.clientId, ...result }));
    }
    if (msg.type === 'ping') ws.send('{"type":"pong"}');
  }

  async webSocketClose() { /* hibernation handles cleanup */ }
  async webSocketError() { /* ditto */ }
}
