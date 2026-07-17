// ── session — auth token, device id, active business ────────────────
import { LS } from './config.js';
import { setStateBiz } from './store.js';

export function getToken() { return localStorage.getItem(LS.token) || ''; }
export function setToken(t) { t ? localStorage.setItem(LS.token, t) : localStorage.removeItem(LS.token); }

export function getActiveBiz() { return localStorage.getItem(LS.activeBiz) || ''; }
export function setActiveBiz(id) { id ? localStorage.setItem(LS.activeBiz, id) : localStorage.removeItem(LS.activeBiz); }

export function deviceId() {
  let d = localStorage.getItem(LS.device);
  if (!d) { d = 'd-' + Math.random().toString(36).slice(2, 10); localStorage.setItem(LS.device, d); }
  return d;
}

export function getUser() {
  try { return JSON.parse(localStorage.getItem(LS.user)) || null; } catch { return null; }
}
export function setUser(u) { u ? localStorage.setItem(LS.user, JSON.stringify(u)) : localStorage.removeItem(LS.user); }

// The businesses this session is allowed to see — exactly what the server
// returned at login (3b: never more than the user's memberships).
export function getBusinesses() {
  try { return JSON.parse(localStorage.getItem(LS.businesses)) || []; } catch { return []; }
}
export function setBusinesses(b) { localStorage.setItem(LS.businesses, JSON.stringify(b || [])); }

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
