// ── sync — snapshot load, dispatch, offline outbox, WebSocket ────────────────
import { ORIGIN, LS } from './config.js';
import { getToken, deviceId, getActiveBiz, clearSession } from './session.js';
import { setSnapshot, applyChange, getStateBiz, setStateBiz } from './store.js';
import { reportError } from './reporter.js';   // log rejected writes to Diagnostics
import { requeueRoutable, orphanizeRejected, capFailedLog, describeWrite } from './lib/orphan-recovery.js';

let ws = null;
let wsBiz = '';
let hb = null;              // heartbeat interval — keeps the socket from being reaped while idle
let lastPong = 0;           // last time the DO answered a ping — stale ⇒ the socket is half-open
let reconnectTimer = null;  // backstop reconnect timer (also kicked on wake)
let wakeWired = false;      // one-time visibility/online listeners
let flushing = false;       // single-flusher guard for the outbox
let onStatus = () => {};
export function setStatusListener(fn) { onStatus = fn; }

const headers = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` });

export async function api(path, opts = {}) {
  const res = await fetch(ORIGIN + path, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
  if (res.status === 401) {
    // session expired or revoked — back to sign-in (outbox stays for next login)
    clearSession();
    location.hash = '';
    location.reload();
    throw new Error('unauthorized');
  }
  return res;
}

export async function openBusiness(bizId) {
  // Stamp the routing authority SYNCHRONOUSLY, before any await, so from the instant we start
  // opening this business every write in THIS tab routes to it — not the previously-open one.
  setStateBiz(bizId);
  let hasCache = false;
  const cached = localStorage.getItem(LS.cache(bizId));
  if (cached) {
    // Only render a cached snapshot stamped for THIS business (or an older unstamped cache).
    try { const parsed = JSON.parse(cached); if (!parsed._biz || parsed._biz === bizId) { setSnapshot(parsed, bizId); hasCache = true; } } catch { /* bad cache */ }
  }
  // No matching cache (wrong _biz OR first open) → clear the store so the PREVIOUS business's
  // data is never shown or read during the async fetch below.
  if (!hasCache) setSnapshot({ meta: null, entities: {}, seq: 0 }, bizId);
  try {
    const res = await api(`/b/${bizId}/state`);
    // ⚠️ Stale-reply guard: if the tab switched to another business while this fetch was in
    // flight, DISCARD the reply — never re-stamp stateBiz, overwrite the store, or open a socket
    // for a business the user already left. Without this, a slow business-A reply arriving after
    // a click to B re-points the tab to A and the next write routes to the wrong company.
    if (getStateBiz() !== bizId) return;
    if (res.ok) {
      const snap = await res.json();
      if (getStateBiz() !== bizId) return;
      setSnapshot(snap, bizId);
      localStorage.setItem(LS.cache(bizId), JSON.stringify({ ...snap, _biz: bizId }));
    }
  } catch { /* offline — the cached/empty snapshot stands */ }
  if (getStateBiz() !== bizId) return;   // switched away during the await → don't wire up the left business
  // Re-apply queued-but-unsynced writes on top of the snapshot so a reload never makes a
  // pending change look lost (that "looks unsaved" gap is what prompted re-entry → a duplicate).
  replayOutboxLocal(bizId);
  connectWS(bizId);
  await flushOutbox();   // drains the ONE shared outbox — every business, not just this one
}

// Replay queued (not-yet-acked) ops for this business onto local state — keeps optimistic
// changes visible after a reload/reconnect without re-queuing them. upsert is by-id and
// stamp-guarded, so replaying an op the server already has is a harmless no-op.
function replayOutboxLocal(biz) {
  for (const item of readOutbox()) {
    if (item.biz === biz) { try { applyChange(item.op); } catch { /* skip a bad op */ } }
  }
}

// The single write path: optimistic local apply → outbox → WS (HTTP fallback).
export async function dispatch(op) {
  // Route by the PER-TAB loaded business first: stateBiz is this tab's own company (module
  // state), so two tabs on different companies each route correctly. getActiveBiz is a shared
  // last-tab-wins marker (could be the OTHER tab's) so it's only a fallback; wsBiz is set only
  // after an await so it's last (it would shadow the correct answer for the whole load window).
  // If all three are empty (no business loaded), the write queues with biz='' and the flusher
  // dead-letters it for the recovery UI — it is NEVER guessed into whatever books are open.
  // ONE read feeds both the route and the Layer-3 seal, so item.biz ≡ op._sealBiz is true by
  // construction (a false server 409 is impossible). The seal is ONLY the data-derived value
  // — sealing from the fallbacks would compare the guess to itself. (`_sealBiz`, not `_biz`:
  // that name already means the snapshot-cache stamp above.) A fallback-routed write can't be
  // sealed, so it's at least made VISIBLE in Diagnostics — if this ever fires, a stateBiz gap
  // like the idle-lock hole is back.
  const sb = getStateBiz();
  const biz = sb || getActiveBiz() || wsBiz;
  if (sb) op._sealBiz = sb;
  else if (biz) reportError('sync.unsealed-route', `no loaded-business stamp; routed to '${biz}' by ${getActiveBiz() ? 'the shared active-business marker' : 'the socket business'}`);
  op.device = deviceId();
  if (op.op === 'entity.upsert') { op.value.updatedAt = Date.now(); op.value.updatedBy = op.device; }
  applyChange(op);
  const outbox = readOutbox();
  outbox.push({ biz, op });
  localStorage.setItem(LS.outbox, JSON.stringify(outbox));
  emitStatus();   // reflect the just-queued item immediately — the pill reads "unsynced" until it sends
  await flushOutbox();
}

function readOutbox() {
  try { return JSON.parse(localStorage.getItem(LS.outbox) || '[]'); } catch { return []; }
}
// The status pill must reflect server-rejected (dead-lettered) work so it can never falsely
// read "Synced" while writes were dropped — `attention` surfaces them (see flushOutbox).
function failedCount() { try { return JSON.parse(localStorage.getItem(LS.failed) || '[]').length; } catch { return 0; } }

// Compute + broadcast the sync status from the ACTUAL queue state, so the pill can never
// read "Synced" while writes are still queued (unsynced) or dead-lettered. `forced` pins
// 'offline' (network down) regardless of the counts. Listeners get the counts for a banner.
function emitStatus(forced, justSaved) {
  const pending = readOutbox().length, failed = failedCount();
  const state = forced || ((pending || failed) ? 'attention' : 'synced');
  onStatus(state, { pending, failed, justSaved: !!justSaved });
}
export function pendingCount() { return readOutbox().length; }
export function failedOpsCount() { return failedCount(); }
// Manual "Sync now" (banner button): also RETRY the dead-letter log — move refused writes back
// into the queue so a rejected batch (e.g. a read-only session) or a brief offline moment is
// one tap to recover; flush alone only re-sends the outbox. Anything still bad just returns to
// the failed log (user-initiated, so no loop). Then reconnect + flush the current business.
export function syncNow() {
  const b = getStateBiz() || getActiveBiz() || wsBiz;
  try {
    const failed = JSON.parse(localStorage.getItem(LS.failed) || '[]');
    // Re-queue ONLY writes that still know their business. An un-tagged orphan must never be
    // guessed back into the queue — flushOutbox would dead-letter it again → a loop plus a
    // serious-error push per tap. Orphans stay in the failed log for the recovery UI's
    // per-row "Save to these books" (each keeps its own biz — no `|| b` fallback guess).
    const r = requeueRoutable(failed, readOutbox());
    if (r.moved) {
      localStorage.setItem(LS.outbox, JSON.stringify(r.outbox));
      localStorage.setItem(LS.failed, JSON.stringify(r.failed));
    }
  } catch { /* best-effort */ }
  if (b) { connectWS(b, true); return flushOutbox(); }
}

// Recovery UI: file a held (dead-lettered) orphan write to the business the owner explicitly
// picks. Pushes it onto the outbox with THAT biz and flushes. Kept separate from dispatch —
// which re-stamps its own biz from the open tab — so a held write reaches exactly the books
// the owner chose, never a guess.
export function saveOrphanTo(biz, op) {
  if (!biz || !op) return;
  // The owner's explicit pick IS the write's new authority — re-seal to it. Without this, a
  // wrong-business orphan whose old seal disagrees with the picked books would 409 forever.
  op._sealBiz = biz;
  const ob = readOutbox();
  ob.push({ biz, op });
  localStorage.setItem(LS.outbox, JSON.stringify(ob));
  // If it's going to the business loaded in THIS tab, apply it locally now: the server's echo
  // comes back stamped with the op's original device id and is suppressed as a self-echo
  // (connectWS onmessage), so without this the filed write wouldn't appear until a reload.
  if (biz === getStateBiz()) { try { applyChange(op); } catch { /* skip a bad op */ } }
  emitStatus();
  return flushOutbox();
}

// Move a write the server refused (or an unroutable one) to the dead-letter log so it's
// preserved + recoverable (Settings → Data recovery) instead of silently dropped OR left
// to jam the queue forever. `orphanize` (a Layer-3 wrong-business refusal) stores it as an
// ORPHAN — biz:'' + attempted — so the recovery picker renders instead of a view-only row
// under the WRONG business. Caps are per-class (capFailedLog): routable pressure can never
// evict an orphan, and every loss path is LOUD — an evicted orphan and a quota-failed write
// each fire their own serious report, because for a never-saved write the log IS the data.
function deadLetter(item, reason, { orphanize = false } = {}) {
  const what = (op) => {
    const d = describeWrite(op);
    return d.kind === 'txn' ? `${d.date ? d.date + ' · ' : ''}${d.payee || '(no payee)'} · $${(d.cents / 100).toFixed(2)}` : (d.fallback || 'write');
  };
  try {
    // Parse in its own try: a corrupt stored log must not stop the NEW entry being held.
    let log = []; try { log = JSON.parse(localStorage.getItem(LS.failed) || '[]'); } catch { log = []; }
    log.unshift(orphanize ? orphanizeRejected(item, reason) : { biz: item.biz, op: item.op, reason, rejectedAt: Date.now() });
    const capped = capFailedLog(log);
    let saved = false;
    try {
      localStorage.setItem(LS.failed, JSON.stringify(capped.log));
      saved = true;
    } catch {
      // Storage quota — the entry could not be held. Never a bare swallow: name the write.
      try { reportError('sync.deadletter-quota', `couldn't hold a write (${what(item.op)})`, { serious: true }); } catch (e) {}
    }
    // Report evictions only when the capped log actually persisted — on a failed write the
    // old log (evicted orphans included) still stands, and a false loss alarm would land at
    // exactly the moment the owner is being told a different write was lost.
    if (saved) {
      for (const o of capped.evictedOrphans) {
        try { reportError('sync.orphan-evicted', `orphan cap evicted an un-filed write (${what(o.op)})`, { serious: true }); } catch (e) {}
      }
    }
  } catch { /* best-effort */ }
  // A rejected write is data-loss-adjacent — surface it in Diagnostics + alert the owner.
  // For a wrong-business refusal name all three businesses in the MESSAGE: the report's
  // structured `biz` field is the SHARED marker (reporter.js) — untrustworthy here.
  try {
    const detail = orphanize ? ` (made in '${item.op?._sealBiz || '?'}', sent to '${item.biz || '?'}', loaded '${getStateBiz() || 'none'}')` : '';
    reportError('sync.rejected-write', ((item.op?.op || 'write') + ' ' + (item.op?.kind || '')).trim() + ' rejected: ' + reason + detail, { serious: true });
  } catch (e) {}
}

// Drop the queue head ONLY if it is still the item this tab just processed. `flushing` is
// per-tab over the SHARED outbox, so two tabs can process the same head; a blind shift in
// the second tab would remove the NEXT item — unsent, silently lost. On a mismatch, skip:
// the duplicate send behind it is harmless (by-id upsert + stale guard), the lost write
// would not have been.
function shiftIfHead(item) {
  const cur = readOutbox();
  if (cur.length && JSON.stringify(cur[0]) === JSON.stringify(item)) {
    cur.shift();
    localStorage.setItem(LS.outbox, JSON.stringify(cur));
  }
}

async function flushOutbox() {
  if (flushing) return;   // one flusher at a time so the FIFO head stays stable across concurrent triggers
  flushing = true;
  let sent = 0;           // count of server-accepted writes this run → drives the "Saved" confirmation
  try {
    while (true) {
      const outbox = readOutbox();
      if (!outbox.length) break;
      const item = outbox[0];
      // A business-less item lost its routing tag (queued while the active-business marker was
      // cleared, e.g. after an idle sign-out, or a legacy pre-v0.70.1 orphan). NEVER guess its
      // business from whatever tab is open — that guess posted a $4k TIE txn into Muse's books.
      // Hold it in the dead-letter log for the owner to file by hand (Settings → Data &
      // maintenance → Save to these books). It still unjams the queue (it shifts).
      if (!item.biz) {
        deadLetter(item, 'no-business');
        shiftIfHead(item);
        continue;
      }
      let res;
      try {
        res = await api(`/b/${item.biz}/state`, { method: 'POST', body: JSON.stringify(item.op) });
      } catch {
        emitStatus('offline');
        return; // genuine network failure — keep the queue, retry on next dispatch/reconnect
      }
      if (!res.ok) {
        if (res.status === 409) {
          let body = {};
          try { body = await res.json(); } catch { /* best-effort */ }
          const reason = body.reason || 'rejected';
          // Self-heal: a staged row advancing out of 'pending' (approve/skip/match) that the
          // server 409'd as 'stale' is a clock-skew race (edge-clock /suggest stamp vs the
          // browser-clock approve), not a real conflict. Re-stamp once just above the server's
          // stored stamp and retry the head — the _healed flag bounds it to a single retry.
          if (reason === 'stale' && item.op.op === 'entity.upsert' && item.op.kind === 'staged'
              && item.op.value?.status && item.op.value.status !== 'pending'
              && !item.op._healed && Number.isFinite(body.storedUpdatedAt)) {
            // Snapshot BEFORE mutating: the head write-back below must be guarded like
            // shiftIfHead (another tab may have shifted while our POST was in flight — a
            // blind cur[0]=item would overwrite a DIFFERENT, unsent item). If the head
            // moved, abandon the heal: the tab that shifted already handled this write.
            const pre = JSON.stringify(item);
            item.op._healed = true;
            item.op.value = { ...item.op.value, updatedAt: body.storedUpdatedAt + 1 };
            const cur = readOutbox();
            if (cur.length && JSON.stringify(cur[0]) === pre) {
              // Keep optimistic state in step with the re-stamp — but only when THIS item belongs
              // to the loaded business; the shared outbox can hold another business's queued op, and
              // applying it here would corrupt the loaded business's store.
              if (item.biz === getStateBiz()) applyChange(item.op);
              cur[0] = item; localStorage.setItem(LS.outbox, JSON.stringify(cur));
            }
            continue;               // retry the (healed) head — or the moved head another tab installed
          }
          // Layer 3: the server refused this write because its seal names a DIFFERENT
          // business than the books it was sent to — a routing bug is back. Hold it as an
          // ORPHAN so the recovery picker (pre-pointed at its seal) can file it right.
          if (reason === 'wrong-business') deadLetter(item, reason, { orphanize: true });
          else deadLetter(item, reason);   // real conflict — preserve it for recovery, don't jam
        } else if (res.status >= 500) {
          emitStatus('offline');      // transient server error — keep + retry, never discard good work
          return;
        } else {
          // A 4xx (bad/unroutable request — e.g. the old empty-business POST) will never
          // succeed on retry, so dead-letter it and keep going. This is the fix for the jam:
          // one bad item can no longer freeze every write queued behind it.
          deadLetter(item, `http ${res.status}`);
        }
      }
      if (res.ok) sent++;   // the server accepted this write — it's durably saved
      // Re-read before dropping the head (a concurrent dispatch may have appended) and drop
      // it only if it's still OUR item (a concurrent tab may have already shifted it).
      shiftIfHead(item);
    }
    emitStatus(undefined, sent > 0);   // sent>0 → a brief "Saved" confirmation
  } finally {
    flushing = false;
  }
}

function connectWS(bizId, isReconnect = false) {
  wireWakeReconnect();
  if (ws && wsBiz === bizId && ws.readyState === WebSocket.OPEN) return;
  try { ws?.close(); } catch { /* already closed */ }
  stopHeartbeat();
  wsBiz = bizId;
  const socketBiz = bizId;   // captured per-socket: module wsBiz is overwritten on a business switch
  const url = ORIGIN.replace(/^http/, 'ws') + `/b/${bizId}/ws?device=${deviceId()}`;
  // NOTE: browser WebSocket can't set an Authorization header — the WS route is
  // gated by the Worker auth before upgrade via this token query param in M0;
  // M2 replaces it with the session model.
  ws = new WebSocket(url + `&token=${encodeURIComponent(getToken())}`);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'pong') { lastPong = Date.now(); return; }
      // Apply a broadcast only while THIS socket's business is still the loaded one — a frame
      // still queued on a socket for a just-switched-away business must not write into the new
      // business's store (module wsBiz already points at the new business, so it can't guard this).
      if (msg.type === 'op' && msg.op?.device !== deviceId() && socketBiz === getStateBiz()) applyChange(msg.op);
    } catch { /* ignore */ }
  };
  ws.onopen = () => {
    lastPong = Date.now();
    emitStatus();   // reflects queued (unsynced) work too — never a false "Synced" over a stuck queue
    startHeartbeat();
    // After a reconnect we may have missed live broadcasts while disconnected — re-pull the
    // snapshot and flush anything queued offline so both sides converge.
    if (isReconnect) resync(bizId);
  };
  ws.onclose = () => {
    stopHeartbeat();
    emitStatus('offline');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { if (wsBiz === bizId) connectWS(bizId, true); }, 4000);
  };
}

// Keep the socket warm: an idle WebSocket gets reaped by Cloudflare/proxies/NAT, which is
// what made the app "randomly go offline". The DO answers {type:'ping'} with a pong.
function startHeartbeat() {
  stopHeartbeat();
  hb = setInterval(() => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    // A half-open socket (NAT/proxy reaped it) still reports OPEN and never fires onclose, so
    // live broadcasts are silently missed and nothing re-syncs. If the DO hasn't ponged in 2+
    // heartbeats, treat the socket as dead: close it → onclose → reconnect(true) → resync, which
    // re-pulls a fresh snapshot so the client catches up on anything it missed.
    if (lastPong && Date.now() - lastPong > 60000) { try { ws.close(); } catch { /* already gone */ } return; }
    try { ws.send('{"type":"ping"}'); } catch { /* will close → reconnect */ }
  }, 25000);
}
function stopHeartbeat() { if (hb) { clearInterval(hb); hb = null; } }

// Re-pull the snapshot and replay the outbox after a reconnect.
async function resync(bizId) {
  try {
    const res = await api(`/b/${bizId}/state`);
    if (res.ok) {
      const snap = await res.json();
      // Stale-reply guard (same as openBusiness): apply only if this is STILL the loaded business
      // — a late resync for a switched-away business must not re-stamp stateBiz or overwrite the store.
      if (getStateBiz() === bizId) {
        setSnapshot(snap, bizId);
        localStorage.setItem(LS.cache(bizId), JSON.stringify({ ...snap, _biz: bizId }));
        replayOutboxLocal(bizId);
      }
    }
  } catch { /* still offline; onclose will retry */ }
  flushOutbox();
}

// A backgrounded tab throttles the 4s reconnect timer and a sleeping device pauses it, so a
// socket that died while hidden would leave the app stuck "offline" until that timer fires.
// Reconnect immediately on wake / network-restore instead.
function wireWakeReconnect() {
  if (wakeWired) return;
  wakeWired = true;
  const kick = () => {
    if (!wsBiz) return;
    const dead = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
    if (dead) {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      connectWS(wsBiz, true);
    }
  };
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
}
