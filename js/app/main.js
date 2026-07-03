// ── main — boot, hash router, view mounting ────────────────
// No window glue: views bind their own events. Routes:
//   #/login        sign in (M0: paste bootstrap token)
//   #/businesses   selector + create (owner only from M2)
//   #/b/<id>/<view>
import { APP_VERSION, ORIGIN } from './config.js';
import { getToken, getActiveBiz, setActiveBiz, getUser, getBusinesses, clearSession } from './session.js';
import { openBusiness, setStatusListener, syncNow } from './sync.js';
import { initLock, sessionResumable } from './lock.js';
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
import * as customers from './views/customers.js';
import * as reconcile from './views/reconcile.js';
import * as deposits from './views/deposits.js';
import * as reports from './views/reports.js';
import * as inventory from './views/inventory.js';
import * as audit from './views/audit.js';
import * as settings from './views/settings.js';
import * as windows from './windows.js';
import { subscribe } from './store.js';
import { entities, usesInvoices, usesMuseSync } from './store.js';
import { openGuide, openQuickRef, openProcedure } from './guide.js';
import { showWhatsNew, maybeShowWhatsNew } from './changelog.js';
import { stub } from './views/stubs.js';
import { mountGlobalSearch } from './search.js';
import { initAmountCalc } from './calc.js';

const VIEWS = {
  dashboard,
  banking,
  review,
  invoices,
  ledger,
  accounts,
  vendors,
  customers,
  rules: vendors,   // back-compat for any old #/b/<biz>/rules links
  reconcile,
  deposits,
  inventory,
  reports,
  audit,
  settings,
  // Settings sections — each opens as its own window (option a). Names use the route's
  // \w+ charset (underscores), and map back to the "settings" sidebar item for highlight.
  set_team: settings.setTeam,
  set_modules: settings.setModules,
  set_qb: settings.setQb,
  set_integrations: settings.setIntegrations,
  set_books: settings.setBooks,
  set_data: settings.setData,
};
// Window title + icon for views that have no sidebar item (the settings sub-windows).
const EXTRA_META = Object.fromEntries(settings.SETTINGS_NAV.map(s => [s.key, { title: s.title, icon: s.icon }]));
// A focused settings sub-window should keep the "Settings" sidebar item highlighted.
const navKeyFor = (name) => (name && name.startsWith('set_')) ? 'settings' : name;

let current = null;
let opened = ''; // in-memory — getActiveBiz() persists across reloads, but the
                 // store does not; a fresh page must always re-open the business
let workspaceMode = false; // true while the MDI windowed workspace is mounted

// The bottom sync indicator — positive by default, loud only when something's actually wrong:
//  • a write reaches the server → a brief green "Saved" confirmation (answers "did it save?");
//  • offline / refused writes → a persistent red-or-amber bar with "Sync now";
//  • work merely in-flight → debounced ~2s, so a normal post (which syncs in well under a
//    second) never flashes a warning — it just confirms "Saved".
let syncBannerTimer = null, syncSavedTimer = null;
function renderSyncBanner(state, pending, failed, justSaved) {
  const bar = () => { let b = document.getElementById('sync-banner'); if (!b) { b = document.createElement('div'); b.id = 'sync-banner'; document.body.appendChild(b); } return b; };
  const hide = () => document.getElementById('sync-banner')?.remove();
  const ic = (name) => { const s = document.createElement('span'); s.className = 'ms'; s.textContent = name; return s; };
  const tx = (str, flex) => { const s = document.createElement('span'); if (flex) s.style.flex = '1'; s.textContent = str; return s; };
  const syncBtn = () => { const b = document.createElement('button'); b.className = 'sync-banner-btn'; b.textContent = 'Sync now'; b.onclick = () => { b.disabled = true; b.textContent = 'Syncing…'; Promise.resolve(syncNow()).finally(() => setTimeout(() => { b.disabled = false; b.textContent = 'Sync now'; }, 800)); }; return b; };
  clearTimeout(syncSavedTimer);
  // A real problem shows promptly: offline, or writes the server refused (the failed log).
  if (state === 'offline' || failed) {
    clearTimeout(syncBannerTimer); syncBannerTimer = null;
    const b = bar(), n = pending + failed;
    b.className = 'sync-banner ' + (state === 'offline' ? 'offline' : 'attention');
    b.replaceChildren(ic(state === 'offline' ? 'cloud_off' : 'sync_problem'),
      tx(state === 'offline'
        ? `You’re offline — ${n} change${n === 1 ? '' : 's'} waiting to sync. They’ll save automatically when you reconnect.`
        : `${failed} change${failed === 1 ? '' : 's'} couldn’t be saved — tap Sync now to retry.`, true),
      syncBtn());
    return;
  }
  // Work queued but nothing refused → debounce; a normal post syncs first and this never shows.
  if (pending) {
    if (!syncBannerTimer) syncBannerTimer = setTimeout(() => { syncBannerTimer = null; const b = bar(); b.className = 'sync-banner attention'; b.replaceChildren(ic('sync_problem'), tx('Still saving your changes…', true), syncBtn()); }, 2200);
    return;
  }
  // Nothing pending or failed. If a save just completed, flash a brief green "Saved".
  clearTimeout(syncBannerTimer); syncBannerTimer = null;
  if (justSaved) { const b = bar(); b.className = 'sync-banner saved'; b.replaceChildren(ic('cloud_done'), tx('Saved')); syncSavedTimer = setTimeout(hide, 1600); }
  else hide();
}

function route() {
  const hash = location.hash || '#/';
  const root = document.getElementById('view');

  // Safety: a session that was closed or sat idle >30 min must re-enter the PIN.
  if (getToken() && !sessionResumable()) clearSession();

  if (!getToken()) { leaveWorkspace(); current = mount(login, root); return; }

  // A `client` belongs in the slim Suggest workspace, not the full books app.
  // (Clients are single-business by construction and never owners, so if every
  // membership is `client` this account has no business in the full app at all.)
  const u = getUser(), mineForRole = getBusinesses();
  if (u && !u.isOwner && mineForRole.length && mineForRole.every(b => b.role === 'client')) {
    location.replace('client.html');
    return;
  }

  if (hash.startsWith('#/setup')) { leaveWorkspace(); setNav('businesses', ''); current = mount(setup, root); return; }

  const m = hash.match(/^#\/b\/([a-z0-9-]+)\/(\w+)(?:\/(.+))?$/);
  if (m) {
    const [, biz, viewName, detail] = m;
    if (opened !== biz) { opened = biz; setActiveBiz(biz); windows.closeAll(); openBusiness(biz).catch(console.error); }
    setNav(viewName, biz);
    enterWorkspace(root);
    windows.openView(viewName, detail);   // opens/focuses a window; detail = drill-down/new token
    return;
  }
  // 3b UI shaping: single-business users have no selector — land in their books.
  const mine = getBusinesses();
  if (!getUser()?.isOwner && mine.length === 1) { location.hash = `#/b/${mine[0].id}/dashboard`; return; }
  leaveWorkspace();
  setNav('businesses', '');
  current = mount(businesses, root);
}

// Each business view opens as a floating window in the MDI workspace (QuickBooks
// style). Full-screen views (login / businesses / setup) replace #view directly.
function enterWorkspace(root) {
  if (workspaceMode) return;
  current?.unmount?.(); current = null;
  root.replaceChildren();
  document.body.classList.add('has-windows');
  windows.create(root);
  workspaceMode = true;
}
function leaveWorkspace() {
  if (workspaceMode) { windows.destroy(); document.body.classList.remove('has-windows'); workspaceMode = false; }
  else { current?.unmount?.(); }
}
// Per-window minimum resize width. Windows that render a fillable field row inside their
// body need a wider floor so the fields can't be crushed; everything else uses the default.
const WIN_MINW = { review: 440, set_integrations: 560 };

// Title + Material icon for a view, read from its sidebar item (single source of truth).
function viewMeta(name) {
  const nav = document.querySelector(`#sidebar .navitem[data-v="${name}"]`);
  let title = name, icon = 'tab';
  if (nav) {
    icon = nav.querySelector('.ms')?.textContent?.trim() || icon;
    nav.childNodes.forEach((n) => { if (n.nodeType === 3 && n.textContent.trim()) title = n.textContent.trim(); });
  } else if (EXTRA_META[name]) {
    title = EXTRA_META[name].title; icon = EXTRA_META[name].icon;
  }
  return { view: VIEWS[name] || VIEWS.dashboard, title, icon, minW: WIN_MINW[name] || 360 };
}
function setNavActive(name) {
  const active = navKeyFor(name);
  document.querySelectorAll('#sidebar .navitem').forEach((n) => n.classList.toggle('on', n.dataset.v === active));
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
  const cm = document.getElementById('createmenu'); if (cm) cm.style.display = biz ? '' : 'none';
  const activeKey = navKeyFor(active);
  document.querySelectorAll('#sidebar .navitem').forEach(n => {
    n.classList.toggle('on', n.dataset.v === activeKey);
    n.style.display = biz ? 'flex' : 'none';
  });
  // Switching businesses lives on the Back Office logo (top-left) now — clickable
  // only for multi-business sessions (a single-business user has nothing to switch to).
  const multi = getUser()?.isOwner || getBusinesses().length > 1;
  const logobtn = document.getElementById('logobtn');
  if (logobtn) {
    logobtn.classList.toggle('switch', !!(biz && multi));
    logobtn.title = (biz && multi) ? 'Switch business' : '';
  }
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
  setStatusListener((s, info) => {
    const pending = info?.pending || 0, failed = info?.failed || 0, n = pending + failed;
    const pill = document.getElementById('syncpill');
    if (pill) {
      pill.textContent = s === 'synced' ? 'Synced' : s === 'offline' ? (n ? `Offline · ${n}` : 'Offline') : `Unsynced · ${n}`;
      pill.className = 'syncpill ' + (s === 'synced' ? 'synced' : s === 'attention' ? 'attention' : 'offline');
    }
    renderSyncBanner(s, pending, failed, info?.justSaved);
  });
  document.querySelectorAll('#sidebar .navitem').forEach(n =>
    n.addEventListener('click', () => {
      const biz = document.getElementById('sidebar').dataset.biz;
      const target = n.dataset.v === 'businesses' ? '#/businesses' : `#/b/${biz}/${n.dataset.v}`;
      // Re-clicking the tab of the view that's already the current route doesn't change
      // the hash, so no hashchange fires — raise/restore its window directly instead of
      // doing nothing (the user expects the tab to bring its window to the front).
      if (location.hash === target && n.dataset.v !== 'businesses') windows.openView(n.dataset.v);
      else location.hash = target;
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
  // The Back Office logo doubles as the business switcher (multi-business sessions only).
  document.getElementById('logobtn').addEventListener('click', () => {
    if (getUser()?.isOwner || getBusinesses().length > 1) location.hash = '#/businesses';
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    menu.hidden = true;
    const act = b.dataset.act;
    if (act === 'guide') openGuide();
    else if (act === 'procedure') openProcedure();
    else if (act === 'quickref') openQuickRef();
    else if (act === 'whatsnew') showWhatsNew();
    else if (act === 'reset') promptHardReload();
    else if (act === 'logout') doLogout();
  });
  windows.setResolver(viewMeta);
  windows.setOnFocus(setNavActive);
  subscribe(updateReviewBadge);
  subscribe(applyFeatureNav);
  setupNavToggle();
  setupCreateMenu();
  initAmountCalc();
  mountGlobalSearch();
  window.addEventListener('hashchange', route);
  initLock(route);   // auto sign-out on app close / 30-min idle
  // Graduated Escape: close the most specific open thing first. Open dropdowns
  // (combobox) stop the event themselves; modals close via their own handler (this
  // runs first and defers while an .overlay exists). Esc inside a field cancels the
  // field / its autofill. Only with nothing else open and focus outside a field does
  // Esc close the focused window. So one Esc never closes both an autofill AND a window.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !workspaceMode) return;
    if (document.querySelector('.overlay, #app-update-popup')) return;
    if (document.querySelector('.cbx-panel:not([hidden]), .dpk-pop:not([hidden]), #gsearch-results:not([hidden])')) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    windows.closeFocused();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkAppVersion(); });
  setInterval(() => { if (!document.hidden) checkAppVersion(); }, 20 * 60 * 1000);   // poll so an always-open app self-updates
  route();
  checkAppVersion();
  if (getToken()) maybeShowWhatsNew();
  resumePlaidOAuth();   // finish a bank OAuth connect if we're returning from the redirect
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// Sidebar collapse toggle — pinned-open (default) vs collapsed icon-rail that peeks
// open on hover. Persisted per device.
function setupNavToggle() {
  const btn = document.getElementById('navtoggle');
  if (!btn) return;
  const icon = btn.querySelector('.ms');
  const apply = (collapsed) => {
    document.body.classList.toggle('nav-collapsed', collapsed);
    if (icon) icon.textContent = collapsed ? 'menu' : 'menu_open';
    btn.title = collapsed ? 'Expand & pin menu' : 'Collapse menu';
  };
  let collapsed = false;
  try { collapsed = localStorage.getItem('bo_nav_collapsed') === '1'; } catch { /* private mode */ }
  apply(collapsed);
  btn.addEventListener('click', () => {
    collapsed = !collapsed;
    apply(collapsed);
    try { localStorage.setItem('bo_nav_collapsed', collapsed ? '1' : '0'); } catch { /* private mode */ }
  });
}

// Global "+ New" create menu (top bar). Items deep-link to a view's /new (or /import)
// token, which that view reads on mount to open its existing create modal — so this
// stays a thin launcher with no knowledge of each view's internals.
const CREATE_KEYS = { t: 'ledger/new', i: 'invoices/new', c: 'customers/new', v: 'vendors/new' };
function setupCreateMenu() {
  const wrap = document.getElementById('createmenu');
  const btn = document.getElementById('createbtn');
  const pop = document.getElementById('createpop');
  if (!wrap || !btn || !pop) return;
  let armed = false;   // two-step shortcut: N arms, the next letter picks
  const bizId = () => document.getElementById('sidebar').dataset.biz;
  const visible = () => wrap.style.display !== 'none';
  const open = () => { if (!visible()) return; pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); };
  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); armed = false; };
  const go = (token) => { const b = bizId(); close(); if (b) location.hash = `#/b/${b}/${token}`; };

  btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden ? open() : close(); });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });
  pop.addEventListener('click', (e) => { const b = e.target.closest('button[data-new]'); if (b) go(b.dataset.new); });

  // The shortcut yields whenever a keystroke could mean something else: typing in a
  // field, any modal/overlay or popover open, a modifier held, or no business loaded.
  const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const busy = () => document.querySelector('.overlay, #app-update-popup, .dpk-pop:not([hidden]), .cbx-panel:not([hidden])');
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || busy() || !visible() || !bizId()) { armed = false; return; }
    const k = (e.key || '').toLowerCase();
    if (!armed) { if (k === 'n') { armed = true; open(); e.preventDefault(); } return; }
    armed = false;
    if (CREATE_KEYS[k]) { e.preventDefault(); go(CREATE_KEYS[k]); } else close();
  });
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
