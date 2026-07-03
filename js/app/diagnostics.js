// ── diagnostics.js — Settings → Diagnostics (error log + bug-alert opt-in) ────
// The viewing end of the reporter (js/app/reporter.js). Two Settings cards:
// drawErrorLog (server-captured errors, newest first) and drawBugAlerts (per-device
// push opt-in). Both are wired into settings.js as the 'set_diagnostics' section.
import { el, clear, toast } from './ui.js';
import { api } from './sync.js';
import { VAPID_PUBLIC_KEY } from './config.js';

const _fmtWhen = ms => { try { return new Date(ms).toLocaleString(); } catch (e) { return '—'; } };
const _alertsOn = () => { try { return localStorage.getItem('bo_error_alerts') === '1'; } catch (e) { return false; } };

function urlB64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ── Error log card ────────────────────────────────────────────────────────────
export function drawErrorLog(card, biz) {
  const body = el('div', {}, el('p', { class: 'sub' }, 'Loading…'));
  clear(card).append(
    el('div', { class: 'cardtitle' }, 'Error log'),
    el('p', { class: 'sub' }, 'Failures the app captured automatically — even ones that didn’t interrupt you — newest first, with how many times each happened. Clearing only removes this diagnostic log; it never changes any books data.'),
    el('div', { style: 'display:flex;gap:8px;margin-bottom:10px' },
      el('button', { class: 'btn sm', onclick: () => drawErrorLog(card, biz) }, 'Refresh'),
      el('button', { class: 'btn sm ghost', onclick: () => clearErrorLog(card, biz) }, 'Clear log')),
    body);
  loadErrors(body);
}

async function loadErrors(body) {
  let errors = null;
  try {
    const res = await api('/report');
    if (res.ok) errors = (await res.json()).errors || [];
  } catch (e) { /* fall through */ }
  if (errors === null) {
    clear(body).append(el('p', { class: 'sub', style: 'color:#c0392b' }, 'Couldn’t load the error log (offline, or the server is unreachable). Try Refresh in a moment.'));
    return;
  }
  if (!errors.length) { clear(body).append(el('p', { class: 'sub' }, 'No errors logged. 🎉 If something misbehaves it will show up here.')); return; }
  clear(body).append(...errors.map(errorRow));
}

function errorRow(e) {
  const detail = el('div', { style: 'display:none;margin-top:6px' },
    el('pre', { style: 'white-space:pre-wrap;font-size:11px;max-height:200px;overflow:auto;background:var(--fill,#f5f6f8);border:1px solid var(--line-2,#e2e5ec);border-radius:8px;padding:8px;margin:0' }, e.stack || '(no stack captured)'),
    (e.breadcrumbs && e.breadcrumbs.length) ? el('pre', { style: 'white-space:pre-wrap;font-size:10px;margin:6px 0 0;opacity:.8' }, e.breadcrumbs.join('\n')) : null,
    el('div', { class: 'sub', style: 'font-size:10px;margin-top:4px' }, [e.device, e.ua].filter(Boolean).join(' · ')));
  return el('div', { style: 'padding:10px 12px;margin-bottom:6px;border-radius:10px;border:1px solid ' + (e.serious ? '#e0a3a3' : 'var(--line-2,#e2e5ec)') },
    el('div', { style: 'display:flex;justify-content:space-between;gap:8px;align-items:baseline' },
      el('b', {}, (e.serious ? '⚠️ ' : '') + (e.context || 'error')),
      el('span', { class: 'sub', style: 'white-space:nowrap' }, `${e.count > 1 ? e.count + '× · ' : ''}${_fmtWhen(e.lastAt)}`)),
    el('div', { style: 'font-size:13px;margin-top:2px;word-break:break-word' }, e.message || ''),
    el('div', { class: 'sub', style: 'font-size:11px;margin-top:2px' }, [e.version, e.view, e.user, (e.online === false ? 'offline' : '')].filter(Boolean).join(' · ')),
    el('button', { class: 'linklike', style: 'font-size:11px;margin-top:4px', onclick: () => { detail.style.display = detail.style.display === 'none' ? 'block' : 'none'; } }, 'Details'),
    detail);
}

async function clearErrorLog(card, biz) {
  if (!confirm('Clear the whole error log? This only removes the saved reports — it doesn’t change any books data.')) return;
  try { const res = await api('/report/clear', { method: 'POST' }); toast(res.ok ? 'Error log cleared' : 'Couldn’t clear — try again'); }
  catch (e) { toast('Couldn’t clear — try again'); }
  drawErrorLog(card, biz);
}

// ── Bug-alert push opt-in card ──────────────────────────────────────────────────
export function drawBugAlerts(card, biz) {
  const on = _alertsOn();
  clear(card).append(
    el('div', { class: 'cardtitle' }, 'Bug alerts on this device'),
    el('p', { class: 'sub' }, on
      ? 'On — this device gets a push notification when something new or serious fails.'
      : 'Get a push notification the moment something fails (deduped so one bug can’t spam you). Requires this site’s notifications to be allowed.'),
    el('button', { class: on ? 'btn sm ghost' : 'btn sm', onclick: () => (on ? disableBugAlerts(card, biz) : enableBugAlerts(card, biz)) }, on ? 'Turn off' : 'Turn on alerts'));
}

async function enableBugAlerts(card, biz) {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { toast('This device can’t receive push notifications'); return; }
    if (Notification.permission === 'denied') { toast('Notifications are blocked — allow them in the browser’s site settings, then try again'); return; }
    let perm = Notification.permission;
    if (perm !== 'granted') { try { perm = await Notification.requestPermission(); } catch (e) {} }
    if (perm !== 'granted') { toast('Notifications not turned on'); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(VAPID_PUBLIC_KEY) });
    const res = await api('/push/subscribe', { method: 'POST', body: JSON.stringify({ techId: 'errors', subscription: sub.toJSON() }) });
    if (res.ok) { try { localStorage.setItem('bo_error_alerts', '1'); } catch (e) {} toast('Bug alerts on ✓'); drawBugAlerts(card, biz); }
    else toast('Allowed, but couldn’t reach the server — try again');
  } catch (e) { toast('Couldn’t turn on bug alerts — try again'); }
}

async function disableBugAlerts(card, biz) {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await api('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ techId: 'errors', endpoint: sub.endpoint }) });
  } catch (e) {}
  try { localStorage.removeItem('bo_error_alerts'); } catch (e) {}
  toast('Bug alerts off'); drawBugAlerts(card, biz);
}
