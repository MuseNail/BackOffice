// ── reporter.js — automatic error / bug reporting ────────────────────────────
// Captures uncaught errors and explicit reportError() calls and POSTs them to the
// Worker's /report endpoint, where they're deduped, capped, and (for new/serious ones)
// pushed to opted-in owner devices. See Settings → Diagnostics for the log + opt-in.
//
// Rules: NEVER throws (a reporter bug must not create the failures it reports), NEVER
// recurses (reporting a failure must not itself report), and survives offline (reports
// queue in localStorage and flush on reconnect). Import it early in the entry point.
import { APP_VERSION, REPORT_PROXY } from './config.js';

const APP     = 'backoffice';
const QKEY    = 'bo_error_queue';
const MAX_Q   = 30;
const crumbs  = [];
let   sending = false;
let   installed = false;

export function breadcrumb(msg) {
  try {
    const t = new Date().toISOString().slice(11, 19);
    crumbs.push(t + ' ' + String(msg).slice(0, 120));
    if (crumbs.length > 20) crumbs.shift();
  } catch (e) {}
}

function activeContext() {
  let user = '', view = '', biz = '';
  try { user = (JSON.parse(localStorage.getItem('bo_user') || 'null') || {}).name || ''; } catch (e) {}
  try { view = (location.hash || '').slice(0, 80); } catch (e) {}
  try { biz = localStorage.getItem('bo_active_biz') || ''; } catch (e) {}
  return { user, view, biz };
}

function fingerprintOf(message, stack, context) {
  let frame = '';
  try { frame = (String(stack).split('\n').find(l => /\.js/.test(l)) || '').trim().slice(0, 120); } catch (e) {}
  const s = String(context || '') + '|' + String(message).slice(0, 140) + '|' + frame;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return APP + ':' + (h >>> 0).toString(36);
}

function loadQ() { try { return JSON.parse(localStorage.getItem(QKEY) || '[]') || []; } catch (e) { return []; } }
function saveQ(q) { try { localStorage.setItem(QKEY, JSON.stringify(q.slice(-MAX_Q))); } catch (e) {} }

// `context` = where it happened; `err` = Error or string; `opts.serious` = always alert.
export function reportError(context, err, opts) {
  try {
    const message = String((err && (err.message || err)) || 'unknown error').slice(0, 500);
    const stack   = String((err && err.stack) || '').slice(0, 4000);
    const { user, view, biz } = activeContext();
    let device = ''; try { device = localStorage.getItem('bo_device_id') || ''; } catch (e) {}
    const rep = {
      app: APP,
      version: APP_VERSION,
      context: String(context || '').slice(0, 120),
      message, stack, view, user, device, biz,
      ua: (navigator.userAgent || '').slice(0, 200),
      online: navigator.onLine !== false,
      breadcrumbs: crumbs.slice(-20),
      fingerprint: fingerprintOf(message, stack, context),
      serious: !!(opts && opts.serious),
      ts: Date.now(),
    };
    const q = loadQ();
    q.push(rep);
    saveQ(q);
    flush();
  } catch (e) {}
}

async function flush() {
  if (sending) return;
  if (!loadQ().length) return;
  sending = true;
  try {
    let guard = 0;
    while (loadQ().length && guard++ < MAX_Q + 5) {
      const rep = loadQ()[0];
      let ok = false;
      try {
        const r = await fetch(REPORT_PROXY, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rep),
          keepalive: true,
        });
        ok = !!(r && r.ok);
      } catch (e) { ok = false; }
      if (!ok) break;
      const q = loadQ(); q.shift(); saveQ(q);
    }
  } catch (e) {}
  sending = false;
}

// Arm: install global handlers (BO has none of its own), flush leftovers, re-flush online.
export function initReporter() {
  if (installed) return;
  installed = true;
  try {
    window.addEventListener('error', e => { try { reportError('window.error', (e && (e.error || e.message)) || 'error'); } catch (x) {} });
    window.addEventListener('unhandledrejection', e => { try { reportError('unhandledrejection', (e && e.reason) || 'rejection'); } catch (x) {} });
    window.addEventListener('online', () => { try { flush(); } catch (e) {} });
    flush();
  } catch (e) {}
}
