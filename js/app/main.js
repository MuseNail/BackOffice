// ── main — boot, hash router, view mounting ────────────────
// No window glue: views bind their own events. Routes:
//   #/login        sign in (M0: paste bootstrap token)
//   #/businesses   selector + create (owner only from M2)
//   #/b/<id>/<view>
import { APP_VERSION, ORIGIN } from './config.js';
import { getToken, getActiveBiz, setActiveBiz, getUser, getBusinesses, clearSession } from './session.js';
import { openBusiness, setStatusListener } from './sync.js';
import { resumePlaidOAuth } from './plaid-connect.js';
import * as login from './views/login.js';
import * as businesses from './views/businesses.js';
import * as setup from './views/setup.js';
import * as dashboard from './views/dashboard.js';
import * as accounts from './views/accounts.js';
import * as ledger from './views/ledger.js';
import * as banking from './views/banking.js';
import * as review from './views/review.js';
import * as invoices from './views/invoices.js';
import * as vendors from './views/vendors.js';
import * as reconcile from './views/reconcile.js';
import * as deposits from './views/deposits.js';
import * as reports from './views/reports.js';
import * as inventory from './views/inventory.js';
import * as settings from './views/settings.js';
import { subscribe } from './store.js';
import { entities, usesInvoices, usesMuseSync } from './store.js';
import { openGuide, openQuickRef } from './guide.js';
import { showWhatsNew, maybeShowWhatsNew } from './changelog.js';
import { stub } from './views/stubs.js';
import { mountGlobalSearch } from './search.js';

const VIEWS = {
  dashboard,
  banking,
  review,
  invoices,
  ledger,
  accounts,
  vendors,
  rules: vendors,   // back-compat for any old #/b/<biz>/rules links
  reconcile,
  deposits,
  inventory,
  reports,
  settings,
};

let current = null;
let opened = ''; // in-memory — getActiveBiz() persists across reloads, but the
                 // store does not; a fresh page must always re-open the business

function route() {
  const hash = location.hash || '#/';
  const root = document.getElementById('view');
  current?.unmount?.();

  if (!getToken()) { current = mount(login, root); return; }

  if (hash.startsWith('#/setup')) { setNav('businesses', ''); current = mount(setup, root); return; }

  const m = hash.match(/^#\/b\/([a-z0-9-]+)\/(\w+)(?:\/(.+))?$/);
  if (m) {
    const [, biz, viewName, detail] = m;
    if (opened !== biz) { opened = biz; setActiveBiz(biz); openBusiness(biz).catch(console.error); }
    setNav(viewName, biz);
    current = mount(VIEWS[viewName] || VIEWS.dashboard, root, detail);   // detail = a drill-down target id (register views)
    return;
  }
  // 3b UI shaping: single-business users have no selector — land in their books.
  const mine = getBusinesses();
  if (!getUser()?.isOwner && mine.length === 1) { location.hash = `#/b/${mine[0].id}/dashboard`; return; }
  setNav('businesses', '');
  current = mount(businesses, root);
}

function mount(view, root, detail) {
  root.replaceChildren();
  try {
    view.render(root, detail);
  } catch (e) {
    console.error('[mount] render error', e);
    const pre = document.createElement('pre');
    pre.textContent = (e?.stack || e?.message || String(e));
    pre.style.cssText = 'white-space:pre-wrap;font-size:12px;margin:8px 0 0';
    const box = document.createElement('div');
    box.style.cssText = 'margin:40px;padding:20px;background:#fbe9e9;border:2px solid #c43a3a;border-radius:14px;font-family:monospace';
    box.innerHTML = '<b style="color:#c43a3a;font-size:14px">View render error</b><br><small style="color:#888">Report this to support — or reload the page.</small>';
    box.append(pre);
    root.append(box);
  }
  return view;
}

function setNav(active, biz) {
  document.getElementById('sidebar').dataset.biz = biz;
  const gs = document.getElementById('gsearch'); if (gs) gs.style.display = biz ? '' : 'none';
  // 3b UI shaping: the Businesses entry exists only for multi-business sessions.
  const multi = getUser()?.isOwner || getBusinesses().length > 1;
  document.querySelectorAll('#sidebar .navitem').forEach(n => {
    n.classList.toggle('on', n.dataset.v === active);
    if (n.dataset.v === 'businesses') n.style.display = multi ? 'flex' : 'none';
    else n.style.display = biz ? 'flex' : 'none';
  });
  applyFeatureNav();
  const who = document.getElementById('userchip');
  const u = getUser();
  who.style.display = u ? 'flex' : 'none';
  if (u) document.getElementById('userchip-name').textContent = u.name;
}

// Per-business feature nav: hide the Invoices/Deposits tabs for businesses that
// don't use them. Re-runs on store changes (the snapshot loads async, after the
// first setNav), so the tabs settle once the business's data arrives.
function applyFeatureNav() {
  const biz = document.getElementById('sidebar').dataset.biz;
  if (!biz) return;
  const set = (v, on) => { const n = document.querySelector(`#sidebar .navitem[data-v="${v}"]`); if (n) n.style.display = on ? 'flex' : 'none'; };
  set('invoices', usesInvoices());
  set('deposits', usesMuseSync());
}

// ── Version check ────────────────────────────────────────────────────────────
// The ver badge becomes a hard-reload button when an update is available.
// SW unregister + cache clear ensures the next load always fetches fresh files.
let _autoPromptedVersion = null;   // newest version we've already auto-popped this session
async function checkAppVersion() {
  const badge = document.getElementById('ver');
  if (!badge) return;
  try {
    const res = await fetch('./version.json?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = await res.json();
    if (version && version !== APP_VERSION) {
      badge.textContent = version + ' ↻';
      badge.title = `Update ${version} available — click to reload`;
      badge.classList.add('update');
      badge.onclick = () => showUpdatePopup(version);
      // The small badge kept getting missed — pop a prominent prompt once per new version.
      if (_autoPromptedVersion !== version) { _autoPromptedVersion = version; showUpdatePopup(version); }
    }
  } catch { /* network unavailable — stay as-is */ }
}
// Deliberately prominent so a published update is never missed. "Update now" runs the
// same SW-unregister + cache-clear + reload; no app data is touched (state lives in the DO).
function showUpdatePopup(version) {
  if (document.getElementById('app-update-popup')) return;
  const overlay = document.createElement('div');
  overlay.id = 'app-update-popup';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(20,22,30,.55);padding:20px';
  const card = document.createElement('div');
  card.style.cssText = 'background:#fff;border-radius:18px;max-width:360px;width:100%;padding:26px 24px;box-shadow:0 18px 50px rgba(0,0,0,.32);text-align:center;font-family:system-ui,-apple-system,sans-serif';
  card.innerHTML =
    '<div style="font-size:42px;line-height:1;margin-bottom:10px">🔄</div>' +
    '<div style="font-size:19px;font-weight:800;color:#1a1d27;margin-bottom:6px">Update available</div>' +
    '<div style="font-size:14px;color:#5b606e;line-height:1.5;margin-bottom:20px">Version ' + version + ' is ready. Tap Update to get the latest version.<br><b>Your data is safe</b> — nothing is deleted.</div>' +
    '<button id="app-update-now" style="display:block;width:100%;padding:14px;border:0;border-radius:12px;background:#2a7a4f;color:#fff;font-size:16px;font-weight:800;cursor:pointer;margin-bottom:9px">Update now</button>' +
    '<button id="app-update-later" style="display:block;width:100%;padding:11px;border:0;border-radius:12px;background:transparent;color:#7a7f8c;font-size:14px;font-weight:600;cursor:pointer">Later</button>';
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  card.querySelector('#app-update-now').addEventListener('click', (e) => { e.target.textContent = 'Updating…'; hardReload(); });
  card.querySelector('#app-update-later').addEventListener('click', () => overlay.remove());
}
async function hardReload() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch { /* continue anyway */ }
  location.reload();
}

function boot() {
  const ver = document.getElementById('ver');
  ver.textContent = 'v' + APP_VERSION;
  ver.title = 'Back Office v' + APP_VERSION + ' — what’s new';
  ver.onclick = () => showWhatsNew();   // checkAppVersion swaps this to a hard-reload when an update is waiting
  setStatusListener(s => {
    const pill = document.getElementById('syncpill');
    pill.textContent = s === 'synced' ? 'Synced' : 'Offline';
    pill.className = 'syncpill ' + s;
  });
  document.querySelectorAll('#sidebar .navitem').forEach(n =>
    n.addEventListener('click', () => {
      const biz = document.getElementById('sidebar').dataset.biz;
      location.hash = n.dataset.v === 'businesses' ? '#/businesses' : `#/b/${biz}/${n.dataset.v}`;
    }));
  // Account menu (top-right): guide, quick reference, what's new, hard reset, log out.
  const doLogout = async () => {
    try { await fetch(ORIGIN + '/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` } }); } catch { /* signing out anyway */ }
    clearSession();
    location.hash = '';
    location.reload();
  };
  const menu = document.getElementById('usermenu');
  document.getElementById('userchip-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener('click', (e) => { if (!document.getElementById('userchip').contains(e.target)) menu.hidden = true; });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    menu.hidden = true;
    const act = b.dataset.act;
    if (act === 'guide') openGuide();
    else if (act === 'quickref') openQuickRef();
    else if (act === 'whatsnew') showWhatsNew();
    else if (act === 'reset') promptHardReload();
    else if (act === 'logout') doLogout();
  });
  subscribe(updateReviewBadge);
  subscribe(applyFeatureNav);
  mountGlobalSearch();
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkAppVersion(); });
  setInterval(() => { if (!document.hidden) checkAppVersion(); }, 20 * 60 * 1000);   // poll so an always-open app self-updates
  route();
  checkAppVersion();
  if (getToken()) maybeShowWhatsNew();
  resumePlaidOAuth();   // finish a bank OAuth connect if we're returning from the redirect
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

function updateReviewBadge() {
  const n = entities('staged').filter(s => s.status === 'pending').length;
  const item = document.querySelector('#sidebar .navitem[data-v="review"]');
  let badge = item.querySelector('.badge');
  if (!n) { badge?.remove(); return; }
  if (!badge) { badge = document.createElement('span'); badge.className = 'badge'; item.append(badge); }
  badge.textContent = String(n);
}

boot();
