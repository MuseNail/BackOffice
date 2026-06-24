// ── lock.js — auto sign-out: on app close, and after 30 min idle ──────────────
// Safety feature: the username + PIN must be re-entered whenever the app has been
// fully closed (the live-session flag lives in sessionStorage, which a tab/PWA
// close clears but a reload keeps) OR the app has sat idle for over 30 minutes.
// Shared by the full app (main.js) and the client app (client.js).
import { getToken, clearSession } from './session.js';
import { toast } from './ui.js';

const IDLE_MS = 30 * 60 * 1000;
const ACT_KEY = 'bo_last_activity';   // localStorage — survives reloads, shared across tabs
const LIVE_KEY = 'bo_session_live';   // sessionStorage — cleared when the app is fully closed

let onLock = null;
let timer = null;
let lastWrite = 0;

function arm() {
  clearTimeout(timer);
  const last = Number(localStorage.getItem(ACT_KEY) || Date.now());
  timer = setTimeout(lockNow, Math.max(1, IDLE_MS - (Date.now() - last)));
}

function touch() {
  const now = Date.now();
  if (now - lastWrite < 10000) return;   // throttle the localStorage churn; the timer is still armed
  lastWrite = now;
  try { localStorage.setItem(ACT_KEY, String(now)); } catch { /* private mode */ }
  arm();
}

function lockNow() {
  clearTimeout(timer);
  if (!getToken()) return;
  clearSession();
  try { sessionStorage.removeItem(LIVE_KEY); } catch { /* ignore */ }
  toast('Signed out after 30 minutes of inactivity');
  onLock?.();
}

// Whether the stored session may resume without re-entering the PIN. False when
// the app was closed since last sign-in (no live flag) or idle longer than 30 min.
export function sessionResumable() {
  if (!getToken()) return false;
  let live = false;
  try { live = sessionStorage.getItem(LIVE_KEY) === '1'; } catch { /* ignore */ }
  if (!live) return false;
  return Date.now() - Number(localStorage.getItem(ACT_KEY) || 0) <= IDLE_MS;
}

// Call right after a successful /auth/login — starts a fresh live session.
export function markSignedIn() {
  try { sessionStorage.setItem(LIVE_KEY, '1'); } catch { /* ignore */ }
  lastWrite = 0;
  touch();
}

// Wire up activity tracking + the idle timer. onLockCb runs after an idle lock so
// the host app can route back to its login screen.
export function initLock(onLockCb) {
  onLock = onLockCb;
  const evs = ['pointerdown', 'keydown', 'click', 'touchstart', 'wheel', 'visibilitychange'];
  for (const ev of evs) window.addEventListener(ev, () => { if (!document.hidden) touch(); }, { passive: true });
  arm();
}
