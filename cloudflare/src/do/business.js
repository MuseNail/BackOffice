// ── BusinessDO — one instance per business; all of that business's books ──
// Entities live as individual storage keys `<kind>:<id>` (kinds: user, account,
// txn, bankacct, import, staged, vendor, customer, item, purchase, recon, lock, i2gpayout, audit).
// `meta` is the business profile. `seq` is a monotonic mutation counter.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

const ENTITY_KINDS = new Set([
  'user', 'account', 'txn', 'bankacct', 'import', 'staged',
  'vendor', 'item', 'purchase', 'recon', 'lock',
  'aiusage', 'aisetting', 'taxsetting', 'invoice',
  'i2gpayout', // Invoice2go payouts — bank-deposit reconciliation targets
  'customer',  // client directory (income-side counterpart to vendors)
  'audit',     // append-only activity trail (who did what, when)
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

const periodKey = (date) => String(date).slice(0, 7); // 'YYYY-MM'
const lineSig = (t) =>
  JSON.stringify([...(t.lines || [])].sort((a, b) => a.accountId < b.accountId ? -1 : 1).map(l => [l.accountId, l.amountCents]));

// Compact audit record for a transaction change (who/what/when). `actor` is the
// user id; `before`/`after` are the txn before/after the write (either may be null).
function auditEntry(op, id, actor, before, after) {
  const t = after || before || {};
  const gross = (x) => { let s = 0; for (const l of x?.lines || []) if (l.amountCents > 0) s += l.amountCents; return s; };
  const action = op === 'delete' ? 'deleted'
    : !before ? 'created'
    : (before.status !== 'void' && after?.status === 'void') ? 'voided'
    : 'edited';
  return { at: Date.now(), op, id, by: actor || 'system', action, payee: t.payee || '', amountCents: gross(t), status: t.status || null };
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
        user: req.headers.get('X-Bo-User') || '',
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
        if (!r?.id) continue;
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

    // internal: a client's category/vendor/invoice SUGGESTION + note for a waiting row.
    // Writes ONLY the suggestion fields onto the staged entity — never amounts, status,
    // dates, etc. — so a low-privilege client can propose without altering the books.
    if (path === '/_suggest' && req.method === 'POST') {
      const { stagedId, suggestedAccountId, suggestedVendorId, suggestedInvoiceId, suggestedVendorName, suggestedAccountName, suggestedSplit, clientNote, userId } = await req.json();
      if (!stagedId) return json({ error: 'bad' }, 400);
      const existing = await this.state.storage.get(`staged:${stagedId}`);
      if (!existing) return json({ error: 'not found' }, 404);
      if (existing.status !== 'pending') return json({ error: 'not pending' }, 409);
      const now = Date.now();
      // A proposed split across several accounts: up to 20 lines of
      // { accountId? | accountName?, amountCents:+int }. Kept only when it has 2+ real
      // lines; otherwise a single-account suggestion (above) stands. The owner confirms
      // and posts it — this only records the proposal, never touches the ledger.
      const split = Array.isArray(suggestedSplit)
        ? suggestedSplit.slice(0, 20).map(l => ({
            accountId: l && l.accountId ? String(l.accountId) : '',
            accountName: l && !l.accountId && l.accountName ? String(l.accountName).slice(0, 120) : '',
            amountCents: (l && Number.isInteger(l.amountCents) && l.amountCents > 0) ? l.amountCents : 0,
          })).filter(l => (l.accountId || l.accountName) && l.amountCents > 0)
        : [];
      const merged = {
        ...existing,
        suggestedAccountId: suggestedAccountId || '',
        suggestedVendorId: suggestedVendorId || '',
        suggestedInvoiceId: suggestedInvoiceId || '',
        // A free-typed proposal for a vendor/account that doesn't exist yet — the owner
        // one-click adds it when accepting. Cleared (id wins) when a real one is picked.
        suggestedVendorName: suggestedVendorId ? '' : String(suggestedVendorName || '').slice(0, 120),
        suggestedAccountName: suggestedAccountId ? '' : String(suggestedAccountName || '').slice(0, 120),
        suggestedSplit: split.length >= 2 ? split : [],
        clientNote: String(clientNote || '').slice(0, 1000),
        suggestedBy: userId || '',
        suggestedAt: now,
        // Monotonic stamp: a suggestion only ADDS suggested* fields (never amounts, status,
        // or dates), so it must never lose the stale-write guard to a clock skew. Stamping at
        // least storedUpdatedAt+1 keeps it ≥ the stored row on every device — otherwise an
        // owner whose browser clock runs ahead of the edge would silently drop the whole
        // suggestion (Account+Vendor+Invoice+Note) at the DO and on every mirror.
        updatedAt: Math.max(now, (existing.updatedAt || 0) + 1),
        updatedBy: userId || 'client',
      };
      const res = await this.apply({ op: 'entity.upsert', kind: 'staged', value: merged, device: '' });
      if (res.rejected) return json({ error: res.reason }, 400);
      return json({ ok: true });
    }

    // ── Plaid bank feed (server-only token; never in the client snapshot) ───────
    // The access token + sync cursor live under `plaid:<itemId>`. Kind 'plaid' is
    // NOT in ENTITY_KINDS, so snapshot() skips it and it never reaches a browser.
    // internal: store/refresh the token blob for a connected Plaid item.
    if (path === '/_plaid/save-item' && req.method === 'POST') {
      const { accessToken, itemId, institution, accounts, startDate } = await req.json();
      if (!accessToken || !itemId) return json({ error: 'bad' }, 400);
      const existing = await this.state.storage.get('plaid:' + itemId);
      // Cutoff for what gets staged — keep an existing one; else the passed date; else
      // today (never re-pull an account's whole history as duplicates by default).
      const sd = existing?.startDate || (/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') ? startDate : new Date().toISOString().slice(0, 10));
      await this.state.storage.put('plaid:' + itemId, {
        accessToken, itemId, institution: institution || 'Bank',
        accounts: Array.isArray(accounts) ? accounts : [],
        cursor: existing?.cursor || null,
        startDate: sd,
        bankacctByPlaidAcct: existing?.bankacctByPlaidAcct || {},
        createdAt: existing?.createdAt || Date.now(),
        lastSyncAt: existing?.lastSyncAt || null,
      });
      return json({ ok: true, itemId });
    }

    // internal: link one Plaid account → a bank account the owner already created,
    // and stamp NON-secret connection info on that bankacct so the UI can show it.
    if (path === '/_plaid/map' && req.method === 'POST') {
      const { itemId, plaidAccountId, bankacctId } = await req.json();
      const item = await this.state.storage.get('plaid:' + itemId);
      const bankacct = await this.state.storage.get('bankacct:' + bankacctId);
      if (!item || !bankacct) return json({ error: 'not found' }, 404);
      item.bankacctByPlaidAcct = { ...(item.bankacctByPlaidAcct || {}), [plaidAccountId]: bankacctId };
      await this.state.storage.put('plaid:' + itemId, item);
      const acct = (item.accounts || []).find(a => a.plaidAccountId === plaidAccountId) || {};
      bankacct.plaid = { itemId, plaidAccountId, institution: item.institution, mask: acct.mask || '', subtype: acct.subtype || '', connectedAt: Date.now(), lastSyncAt: item.lastSyncAt || null };
      bankacct.updatedAt = Date.now();
      await this.apply({ op: 'entity.upsert', kind: 'bankacct', value: bankacct, device: '' });
      return json({ ok: true });
    }

    // internal: the sync orchestrator (routes/plaid.js) reads every item + token
    // here. Only reachable DO-internally; never proxied to a client.
    if (path === '/_plaid/items' && req.method === 'GET') {
      const items = [];
      for (const v of (await this.state.storage.list({ prefix: 'plaid:' })).values()) items.push(v);
      return json({ items });
    }

    // internal: write a sync batch. Idempotent like _sync/inbound — an already-
    // approved staged row is never reverted to pending. Advances the cursor and
    // stamps lastSyncAt on the item + its mapped bank accounts.
    if (path === '/_plaid/apply-sync' && req.method === 'POST') {
      const { itemId, values, cursor } = await req.json();
      const now = Date.now();
      const fresh = [];
      for (const r of (values || [])) {
        if (!r?.id) continue;
        const existing = await this.state.storage.get('staged:' + r.id);
        if (!existing) { fresh.push({ ...r, createdAt: now, updatedAt: now, updatedBy: 'plaid' }); continue; }
        if (existing.status === 'pending' && (existing.amountCents !== r.amountCents || existing.desc !== r.desc || existing.date !== r.date)) {
          fresh.push({ ...existing, ...r, updatedAt: now, updatedBy: 'plaid' });
        }
      }
      if (fresh.length) await this.apply({ op: 'entity.bulkUpsert', kind: 'staged', values: fresh, device: '' });
      const item = await this.state.storage.get('plaid:' + itemId);
      if (item) {
        if (cursor != null) item.cursor = cursor;
        item.lastSyncAt = now;
        await this.state.storage.put('plaid:' + itemId, item);
        for (const baId of Object.values(item.bankacctByPlaidAcct || {})) {
          const ba = await this.state.storage.get('bankacct:' + baId);
          if (ba) { ba.plaid = { ...(ba.plaid || {}), lastSyncAt: now }; ba.updatedAt = now; await this.apply({ op: 'entity.upsert', kind: 'bankacct', value: ba, device: '' }); }
        }
      }
      return json({ ok: true, created: fresh.length });
    }

    // internal: remove a Plaid feed from one bank account. Drops that account's
    // mapping; deletes the whole token blob once no accounts reference it; clears the
    // non-secret plaid info off the bankacct. Returns the token so the route can ask
    // Plaid to remove the item too. Transactions already in Review are left untouched.
    if (path === '/_plaid/disconnect' && req.method === 'POST') {
      const { bankacctId } = await req.json();
      const bankacct = await this.state.storage.get('bankacct:' + bankacctId);
      if (!bankacct || !bankacct.plaid) return json({ ok: true });
      const itemId = bankacct.plaid.itemId;
      let accessToken = null;
      const item = itemId && (await this.state.storage.get('plaid:' + itemId));
      if (item) {
        accessToken = item.accessToken;
        const map = { ...(item.bankacctByPlaidAcct || {}) };
        for (const [pa, ba] of Object.entries(map)) if (ba === bankacctId) delete map[pa];
        if (Object.keys(map).length === 0) await this.state.storage.delete('plaid:' + itemId);
        else { item.bankacctByPlaidAcct = map; await this.state.storage.put('plaid:' + itemId, item); }
      }
      delete bankacct.plaid;
      bankacct.updatedAt = Date.now();
      await this.apply({ op: 'entity.upsert', kind: 'bankacct', value: bankacct, device: '' });
      return json({ ok: true, accessToken });
    }

    if (path === '/state' && req.method === 'GET') return this.snapshot();
    if (path === '/state' && req.method === 'POST') {
      const op = await req.json();
      const result = await this.apply(op, req.headers.get('X-Bo-User') || '');
      return json(result, result.rejected ? 409 : 200);
    }
    // Audit log of transaction changes (who/what/when). Newest first; not in the
    // snapshot (audit:* isn't an ENTITY_KIND), so it never bloats client state.
    if (path === '/_audit' && req.method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
      const batch = await this.state.storage.list({ prefix: 'audit:', reverse: true, limit });
      return json({ entries: [...batch.values()] });
    }
    return json({ error: 'not found' }, 404);
  }

  async snapshot() {
    const out = { meta: null, entities: {}, seq: 0, schema_version: 1 };
    // Paginate: DO storage.list() default limit is 128 — loop until exhausted.
    let cursor;
    while (true) {
      const batch = await this.state.storage.list({ limit: 1000, ...(cursor ? { startAfter: cursor } : {}) });
      for (const [k, v] of batch) {
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
      if (batch.size < 1000) break;
      cursor = [...batch.keys()].at(-1);
    }
    return json(out);
  }

  // Period locks (closed books): a locked month rejects new postings and any
  // change to a posted entry's amounts/accounts/date/status. Metadata-only edits
  // (payee, memo, qbExportedAt, reconciledIn) still pass so re-export and recon
  // stamping keep working after close. Staged rows aren't in the ledger → not gated.
  // Mirrors the client's validateTxn() lock check (lib/posting.js).
  async periodLockBreach(next, existing) {
    if (next.status !== 'posted' && existing?.status !== 'posted') return null;
    if (existing && next.status === existing.status && next.date === existing.date && lineSig(next) === lineSig(existing)) return null;
    const periods = new Set([periodKey(next.date)]);
    if (existing) periods.add(periodKey(existing.date));
    for (const p of periods) {
      if (await this.state.storage.get(`lock:${p}`)) return `period ${p} is locked`;
    }
    return null;
  }

  // op: { op:'entity.upsert'|'entity.delete'|'meta.set', kind?, value?, id?, device? }
  // actor = the acting user's id (from X-Bo-User / the WS attachment) for the audit log.
  async apply(op, actor = '') {
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
      // EXCEPTION: a staged row advancing OUT of 'pending' (approve / skip / match) is a
      // forward status transition, never a content race — and a preceding client /suggest
      // write is stamped on the Cloudflare edge clock while the approve is stamped on the
      // owner's browser clock, so a lagging browser clock would otherwise 409 a real approval
      // as 'stale' (the row stays pending here while its txn posts). Staged rows carry no
      // ledger lines, so letting a status-advance through is safe.
      const stagedAdvance = op.kind === 'staged' && existing?.status === 'pending'
        && op.value.status && op.value.status !== 'pending';
      if (!stagedAdvance && existing?.updatedAt && op.value.updatedAt && op.value.updatedAt < existing.updatedAt) {
        return { rejected: true, reason: 'stale', storedUpdatedAt: existing.updatedAt };
      }
      // Reconciliation guard: if a txn is reconciled, its lines (amounts + accounts)
      // and status are permanent — only metadata (payee, memo) may change.
      if (op.kind === 'txn' && existing?.reconciledIn) {
        if (op.value.status !== existing.status) return { rejected: true, reason: 'reconciled: status is locked — voiding a reconciled transaction is not allowed' };
        const existingSig = JSON.stringify([...existing.lines].sort((a, b) => a.accountId < b.accountId ? -1 : 1).map(l => [l.accountId, l.amountCents]));
        const newSig = JSON.stringify([...(op.value.lines || [])].sort((a, b) => a.accountId < b.accountId ? -1 : 1).map(l => [l.accountId, l.amountCents]));
        if (existingSig !== newSig) return { rejected: true, reason: 'reconciled: amounts and accounts are locked' };
      }
      if (op.kind === 'txn') {
        const locked = await this.periodLockBreach(op.value, existing);
        if (locked) return { rejected: true, reason: locked };
      }
      await this.state.storage.put(key, op.value);
      const res = await this.commit(op);
      if (op.kind === 'txn') await this.recordAudit(res.seq, auditEntry('upsert', op.value.id, actor, existing, op.value));
      return res;
    }
    if (op.op === 'entity.bulkUpsert') {
      if (!ENTITY_KINDS.has(op.kind) || !Array.isArray(op.values) || op.values.length > 500) {
        return { rejected: true, reason: 'bad op' };
      }
      // Same txn invariants as the single-upsert path — bulk writes (e.g. the
      // M12 export stamping) must not become a side door around the ledger rules.
      if (op.kind === 'txn') {
        for (const v of op.values) {
          const bad = v && txnInvariantBreach(v);
          if (bad) return { rejected: true, reason: bad };
        }
      }
      let applied = 0;
      for (const v of op.values) {
        if (!v?.id) continue;
        const key = `${op.kind}:${v.id}`;
        const existing = await this.state.storage.get(key);
        if (existing?.updatedAt && v.updatedAt && v.updatedAt < existing.updatedAt) continue;
        // Reconciliation guard: metadata-only changes (e.g. QB export stamping) go
        // through; line/status changes on reconciled txns are silently skipped.
        if (op.kind === 'txn' && existing?.reconciledIn) {
          if (v.status !== existing.status) continue;
          const eSig = JSON.stringify([...existing.lines].sort((a, b) => a.accountId < b.accountId ? -1 : 1).map(l => [l.accountId, l.amountCents]));
          const nSig = JSON.stringify([...(v.lines || [])].sort((a, b) => a.accountId < b.accountId ? -1 : 1).map(l => [l.accountId, l.amountCents]));
          if (eSig !== nSig) continue;
        }
        if (op.kind === 'txn' && await this.periodLockBreach(v, existing)) continue;
        await this.state.storage.put(key, v);
        applied++;
      }
      return this.commit(op, { applied });
    }
    if (op.op === 'entity.delete') {
      if (!ENTITY_KINDS.has(op.kind) || !op.id) return { rejected: true, reason: 'bad op' };
      // Reconciled transactions are permanently locked — deletion would corrupt past statements.
      // A closed (locked) period is sealed too: no add, no edit, AND no delete.
      let before = null;
      if (op.kind === 'txn') {
        const t = await this.state.storage.get(`txn:${op.id}`);
        before = t;
        if (t?.reconciledIn) return { rejected: true, reason: 'reconciled: cannot delete a reconciled transaction' };
        if (t && await this.state.storage.get(`lock:${periodKey(t.date)}`)) {
          return { rejected: true, reason: `period ${periodKey(t.date)} is locked — reopen it to delete` };
        }
      }
      await this.state.storage.delete(`${op.kind}:${op.id}`);
      const res = await this.commit(op);
      if (op.kind === 'txn') await this.recordAudit(res.seq, auditEntry('delete', op.id, actor, before, null));
      return res;
    }
    return { rejected: true, reason: 'unknown op' };
  }

  async commit(op, extra = {}) {
    const seq = ((await this.state.storage.get('seq')) || 0) + 1;
    await this.state.storage.put('seq', seq);
    this.broadcast({ type: 'op', seq, op }, op.device);
    return { ok: true, seq, ...extra };
  }

  // Append an audit record keyed by zero-padded seq (sorts chronologically). Kept to
  // the most recent ~1000; pruned occasionally so the DO doesn't grow unbounded.
  async recordAudit(seq, entry) {
    await this.state.storage.put('audit:' + String(seq).padStart(12, '0'), { seq, ...entry });
    if (seq % 250 === 0) {
      const keys = [...(await this.state.storage.list({ prefix: 'audit:' })).keys()];
      if (keys.length > 1000) await this.state.storage.delete(keys.slice(0, keys.length - 1000));
    }
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
    if (typeof raw === 'string' && raw.length > 500_000) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'op' && msg.op) {
      const att = (() => { try { return ws.deserializeAttachment() || {}; } catch { return {}; } })();
      if (att.role === 'viewer') { ws.send(JSON.stringify({ type: 'ack', clientId: msg.clientId, rejected: true, reason: 'read only' })); return; }
      const result = await this.apply(msg.op, att.user || '');
      ws.send(JSON.stringify({ type: 'ack', clientId: msg.clientId, ...result }));
    }
    if (msg.type === 'ping') ws.send('{"type":"pong"}');
  }

  async webSocketClose() { /* hibernation handles cleanup */ }
  async webSocketError() { /* ditto */ }
}
