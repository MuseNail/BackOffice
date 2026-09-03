// ── session — auth token, device id, active business ────────────────
import { LS } from './config.js';
import { setStateBiz } from './store.js';
import { evictionOrder } from './lib/ls-quota.js';

export function isQuotaError(e) {
  return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
}

// Quota-resilient setItem for the SMALL critical keys (token, user, businesses, active biz, device id)
// and the offline outbox/dead-letter (via sync.js). On a full shared origin it evicts the regenerable
// state-cache mirrors (this app's other businesses + muse/turndesk), active-biz mirror LAST, retrying
// after each removal — so the tiny token write always fits while an un-synced outbox is never dropped.
// Returns true if stored, false if even after evicting every cache it still won't fit (caller decides).
export function safeSetItem(key, val) {
  try { localStorage.setItem(key, val); return true; }
  catch (e) {
    if (!isQuotaError(e)) throw e;
    let activeCache = '';
    try { activeCache = LS.cache(getActiveBiz()); } catch {}
    for (const k of evictionOrder(Object.keys(localStorage), activeCache)) {
      if (k === key) continue;
      try { localStorage.removeItem(k); } catch {}
      try { localStorage.setItem(key, val); return true; } catch (e2) { if (!isQuotaError(e2)) throw e2; }
    }
    return false;
  }
}

// Drop every regenerable state-cache mirror (all three apps) — the manual escape hatch behind the
// Settings "Clear local cache" button. Returns how many were removed.
export function clearStateCaches() {
  let n = 0;
  for (const k of evictionOrder(Object.keys(localStorage), '')) { try { localStorage.removeItem(k); n++; } catch {} }
  return n;
}

export function getToken() { return localStorage.getItem(LS.token) || ''; }
export function setToken(t) { if (!t) { localStorage.removeItem(LS.token); return true; } return safeSetItem(LS.token, t); }

export function getActiveBiz() { return localStorage.getItem(LS.activeBiz) || ''; }
export function setActiveBiz(id) { if (!id) { localStorage.removeItem(LS.activeBiz); return true; } return safeSetItem(LS.activeBiz, id); }

export function deviceId() {
  let d = localStorage.getItem(LS.device);
  if (!d) { d = 'd-' + Math.random().toString(36).slice(2, 10); safeSetItem(LS.device, d); }
  return d;
}

export function getUser() {
  try { return JSON.parse(localStorage.getItem(LS.user)) || null; } catch { return null; }
}
export function setUser(u) { if (!u) { localStorage.removeItem(LS.user); return true; } return safeSetItem(LS.user, JSON.stringify(u)); }

// The businesses this session is allowed to see — exactly what the server
// returned at login (3b: never more than the user's memberships).
export function getBusinesses() {
  try { return JSON.parse(localStorage.getItem(LS.businesses)) || []; } catch { return []; }
}
export function setBusinesses(b) { return safeSetItem(LS.businesses, JSON.stringify(b || [])); }

export function clearSession() {
  for (const k of [LS.token, LS.user, LS.businesses, LS.activeBiz]) localStorage.removeItem(k);
  setStateBiz('');   // clear the per-tab routing authority so it can't survive into the next user's session (the idle path signs out without a reload)
}

export function roleFor(bizId) {
  const u = getUser();
  if (u?.isOwner) return 'owner';
  return getBusinesses().find(b => b.id === bizId)?.role || null;
}

// Mirrors the server rule (viewer = read-only); the Worker enforces it anyway.
export function canEdit(bizId) {
  return ['owner', 'manager', 'bookkeeper'].includes(roleFor(bizId));
}
