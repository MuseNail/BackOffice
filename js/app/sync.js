// ── sync — snapshot load, dispatch, offline outbox, WebSocket ────────────────
import { ORIGIN, LS } from './config.js';
import { getToken, deviceId, getActiveBiz, clearSession } from './session.js';
import { setSnapshot, applyChange } from './store.js';
import { reportError } from './reporter.js';   // log rejected writes to Diagnostics
import { requeueRoutable } from './lib/orphan-recovery.js';

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
  const cached = localStorage.getItem(LS.cache(bizId));
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      // Multi-tenant guard: only render a cached snapshot stamped for THIS business
      // (or an older unstamped cache, for back-compat). A mismatch means a wrong/stale
      // entry under this key — skip it; the network fetch below loads the right one.
      if (!parsed._biz || parsed._biz === bizId) setSnapshot(parsed);
    } catch { /* bad cache */ }
  }
  try {
    const res = await api(`/b/${bizId}/state`);
    if (res.ok) {
      const snap = await res.json();
      setSnapshot(snap);
      localStorage.setItem(LS.cache(bizId), JSON.stringify({ ...snap, _biz: bizId }));
    }
  } catch { /* offline — the cached snapshot (if any) stands */ }
  // Re-apply queued-but-unsynced writes on top of the snapshot so a reload never makes a
  // pending change look lost (that "looks unsaved" gap is what prompted re-entry → a duplicate).
  replayOutboxLocal(bizId);
  connectWS(bizId);
  await flushOutbox(bizId);
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
  // Route by the IN-MEMORY opened business (set by connectWS), falling back to the stored
  // marker. An idle sign-out clears the localStorage marker (bo_active_biz); a write queued
  // with an empty biz can't be routed — it used to POST to /b//state, fail, and JAM the whole
  // FIFO outbox while the pill still read "Synced". wsBiz survives the sign-out, so this is
  // the reliable source; the flusher below also re-routes any legacy business-less item.
  const biz = wsBiz || getActiveBiz();
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
  const b = wsBiz || getActiveBiz();
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
  const ob = readOutbox();
  ob.push({ biz, op });
  localStorage.setItem(LS.outbox, JSON.stringify(ob));
  // If it's going to the business open in THIS tab, apply it locally now: the server's echo
  // comes back stamped with the op's original device id and is suppressed as a self-echo
  // (connectWS onmessage), so without this the filed write wouldn't appear until a reload.
  if (biz === wsBiz) { try { applyChange(op); } catch { /* skip a bad op */ } }
  emitStatus();
  return flushOutbox();
}

// Move a write the server refused (or an unroutable one) to the dead-letter log so it's
// preserved + recoverable (Settings → Data recovery) instead of silently dropped OR left
// to jam the queue forever.
function deadLetter(item, reason) {
  try {
    const log = JSON.parse(localStorage.getItem(LS.failed) || '[]');
    log.unshift({ biz: item.biz, op: item.op, reason, rejectedAt: Date.now() });
    localStorage.setItem(LS.failed, JSON.stringify(log.slice(0, 100)));
  } catch { /* best-effort */ }
  // A rejected write is data-loss-adjacent — surface it in Diagnostics + alert the owner.
  try { reportError('sync.rejected-write', ((item.op?.op || 'write') + ' ' + (item.op?.kind || '')).trim() + ' rejected: ' + reason, { serious: true }); } catch (e) {}
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
        const c = readOutbox(); c.shift(); localStorage.setItem(LS.outbox, JSON.stringify(c));
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
            item.op._healed = true;
            item.op.value = { ...item.op.value, updatedAt: body.storedUpdatedAt + 1 };
            applyChange(item.op);   // keep optimistic state in step with the re-stamp
            const cur = readOutbox(); cur[0] = item; localStorage.setItem(LS.outbox, JSON.stringify(cur));
            continue;               // retry the head with the healed stamp
          }
          deadLetter(item, reason);   // real conflict — preserve it for recovery, don't jam
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
      // Re-read before dropping the head: a concurrent dispatch may have appended to the tail
      // while this POST was in flight, and we must not clobber it by writing back a stale array.
      const cur = readOutbox();
      cur.shift();
      localStorage.setItem(LS.outbox, JSON.stringify(cur));
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
  const url = ORIGIN.replace(/^http/, 'ws') + `/b/${bizId}/ws?device=${deviceId()}`;
  // NOTE: browser WebSocket can't set an Authorization header — the WS route is
  // gated by the Worker auth before upgrade via this token query param in M0;
  // M2 replaces it with the session model.
  ws = new WebSocket(url + `&token=${encodeURIComponent(getToken())}`);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'pong') { lastPong = Date.now(); return; }
      if (msg.type === 'op' && msg.op?.device !== deviceId()) applyChange(msg.op);
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
      setSnapshot(snap);
      localStorage.setItem(LS.cache(bizId), JSON.stringify({ ...snap, _biz: bizId }));
      replayOutboxLocal(bizId);
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
