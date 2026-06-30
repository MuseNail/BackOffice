// ── sync — snapshot load, dispatch, offline outbox, WebSocket ────────────────
import { ORIGIN, LS } from './config.js';
import { getToken, deviceId, getActiveBiz, clearSession } from './session.js';
import { setSnapshot, applyChange } from './store.js';

let ws = null;
let wsBiz = '';
let hb = null;              // heartbeat interval — keeps the socket from being reaped while idle
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
  const biz = getActiveBiz();
  op.device = deviceId();
  if (op.op === 'entity.upsert') { op.value.updatedAt = Date.now(); op.value.updatedBy = op.device; }
  applyChange(op);
  const outbox = readOutbox();
  outbox.push({ biz, op });
  localStorage.setItem(LS.outbox, JSON.stringify(outbox));
  await flushOutbox(biz);
}

function readOutbox() {
  try { return JSON.parse(localStorage.getItem(LS.outbox) || '[]'); } catch { return []; }
}
// The status pill must reflect server-rejected (dead-lettered) work so it can never falsely
// read "Synced" while writes were dropped — `attention` surfaces them (see flushOutbox).
function failedCount() { try { return JSON.parse(localStorage.getItem(LS.failed) || '[]').length; } catch { return 0; } }

async function flushOutbox() {
  if (flushing) return;   // one flusher at a time so the FIFO head stays stable across concurrent triggers
  flushing = true;
  try {
    while (true) {
      const outbox = readOutbox();
      if (!outbox.length) break;
      const item = outbox[0];
      try {
        const res = await api(`/b/${item.biz}/state`, { method: 'POST', body: JSON.stringify(item.op) });
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
            // Otherwise dead-letter it so the user can inspect (Settings → Data recovery).
            try {
              const log = JSON.parse(localStorage.getItem(LS.failed) || '[]');
              log.unshift({ biz: item.biz, op: item.op, reason, rejectedAt: Date.now() });
              localStorage.setItem(LS.failed, JSON.stringify(log.slice(0, 100)));
            } catch { /* best-effort */ }
          } else {
            throw new Error('send failed');
          }
        }
      } catch {
        onStatus('offline');
        return; // keep the outbox; retry on next dispatch/reconnect
      }
      // Re-read before dropping the head: a concurrent dispatch may have appended to the tail
      // while this POST was in flight, and we must not clobber it by writing back a stale array.
      const cur = readOutbox();
      cur.shift();
      localStorage.setItem(LS.outbox, JSON.stringify(cur));
    }
    onStatus(failedCount() ? 'attention' : 'synced');
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
      if (msg.type === 'op' && msg.op?.device !== deviceId()) applyChange(msg.op);
    } catch { /* ignore */ }
  };
  ws.onopen = () => {
    onStatus(failedCount() ? 'attention' : 'synced');
    startHeartbeat();
    // After a reconnect we may have missed live broadcasts while disconnected — re-pull the
    // snapshot and flush anything queued offline so both sides converge.
    if (isReconnect) resync(bizId);
  };
  ws.onclose = () => {
    stopHeartbeat();
    onStatus('offline');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { if (wsBiz === bizId) connectWS(bizId, true); }, 4000);
  };
}

// Keep the socket warm: an idle WebSocket gets reaped by Cloudflare/proxies/NAT, which is
// what made the app "randomly go offline". The DO answers {type:'ping'} with a pong.
function startHeartbeat() {
  stopHeartbeat();
  hb = setInterval(() => {
    try { if (ws?.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}'); } catch { /* will close → reconnect */ }
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
