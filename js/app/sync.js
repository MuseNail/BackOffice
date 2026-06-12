// ── sync — snapshot load, dispatch, offline outbox, WebSocket ────────────────
import { ORIGIN, LS } from './config.js';
import { getToken, deviceId, getActiveBiz, clearSession } from './session.js';
import { setSnapshot, applyChange } from './store.js';

let ws = null;
let wsBiz = '';
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
  if (cached) { try { setSnapshot(JSON.parse(cached)); } catch { /* bad cache */ } }
  const res = await api(`/b/${bizId}/state`);
  if (res.ok) {
    const snap = await res.json();
    setSnapshot(snap);
    localStorage.setItem(LS.cache(bizId), JSON.stringify(snap));
  }
  connectWS(bizId);
  await flushOutbox(bizId);
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

async function flushOutbox(biz) {
  let outbox = readOutbox();
  while (outbox.length) {
    const item = outbox[0];
    try {
      const res = await api(`/b/${item.biz}/state`, { method: 'POST', body: JSON.stringify(item.op) });
      if (!res.ok && res.status !== 409) throw new Error('send failed'); // 409 stale = server wins, drop it
    } catch {
      onStatus('offline');
      return; // keep the outbox; retry on next dispatch/reconnect
    }
    outbox.shift();
    localStorage.setItem(LS.outbox, JSON.stringify(outbox));
  }
  onStatus('synced');
}

function connectWS(bizId) {
  if (ws && wsBiz === bizId && ws.readyState === WebSocket.OPEN) return;
  try { ws?.close(); } catch { /* already closed */ }
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
  ws.onopen = () => onStatus('synced');
  ws.onclose = () => { onStatus('offline'); setTimeout(() => { if (wsBiz === bizId) connectWS(bizId); }, 4000); };
}
