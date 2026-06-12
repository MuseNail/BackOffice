// ── session — auth token, device id, active business ────────────────
import { LS } from './config.js';

export function getToken() { return localStorage.getItem(LS.token) || ''; }
export function setToken(t) { t ? localStorage.setItem(LS.token, t) : localStorage.removeItem(LS.token); }

export function getActiveBiz() { return localStorage.getItem(LS.activeBiz) || ''; }
export function setActiveBiz(id) { id ? localStorage.setItem(LS.activeBiz, id) : localStorage.removeItem(LS.activeBiz); }

export function deviceId() {
  let d = localStorage.getItem(LS.device);
  if (!d) { d = 'd-' + Math.random().toString(36).slice(2, 10); localStorage.setItem(LS.device, d); }
  return d;
}
