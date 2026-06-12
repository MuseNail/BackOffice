// ── main — boot, hash router, view mounting ────────────────
// No window glue: views bind their own events. Routes:
//   #/login        sign in (M0: paste bootstrap token)
//   #/businesses   selector + create (owner only from M2)
//   #/b/<id>/<view>
import { APP_VERSION, ORIGIN } from './config.js';
import { getToken, getActiveBiz, setActiveBiz, getUser, getBusinesses, clearSession } from './session.js';
import { openBusiness, setStatusListener } from './sync.js';
import * as login from './views/login.js';
import * as businesses from './views/businesses.js';
import * as setup from './views/setup.js';
import * as dashboard from './views/dashboard.js';
import * as settings from './views/settings.js';
import { stub } from './views/stubs.js';

const VIEWS = {
  dashboard,
  banking: stub('Banking', 'M5 — bank accounts, CSV import wizard, import history'),
  review: stub('Review', 'M5–M7 — staged rows, rule/history/AI suggestions, approve to post'),
  ledger: stub('Ledger', 'M4 — posted transactions, manual entry, journal entries'),
  accounts: stub('Accounts', 'M3 — chart of accounts CRUD on the industry template'),
  rules: stub('Vendors & Rules', 'M6 — exact/keyword matchers, usage counts'),
  reconcile: stub('Reconcile', 'M8 — statement sessions, must reach $0.00'),
  inventory: stub('Inventory', 'M10 — items, restock points, linked postings'),
  reports: stub('Reports', 'M9 — P&L, Balance Sheet, summaries, tax estimate'),
  settings,
};

let current = null;

function route() {
  const hash = location.hash || '#/';
  const root = document.getElementById('view');
  current?.unmount?.();

  if (!getToken()) { current = mount(login, root); return; }

  if (hash.startsWith('#/setup')) { setNav('businesses', ''); current = mount(setup, root); return; }

  const m = hash.match(/^#\/b\/([a-z0-9-]+)\/(\w+)/);
  if (m) {
    const [, biz, viewName] = m;
    if (getActiveBiz() !== biz) { setActiveBiz(biz); openBusiness(biz).catch(console.error); }
    setNav(viewName, biz);
    current = mount(VIEWS[viewName] || VIEWS.dashboard, root);
    return;
  }
  // 3b UI shaping: single-business users have no selector — land in their books.
  const mine = getBusinesses();
  if (!getUser()?.isOwner && mine.length === 1) { location.hash = `#/b/${mine[0].id}/dashboard`; return; }
  setNav('businesses', '');
  current = mount(businesses, root);
}

function mount(view, root) {
  root.replaceChildren();
  view.render(root);
  return view;
}

function setNav(active, biz) {
  document.getElementById('sidebar').dataset.biz = biz;
  // 3b UI shaping: the Businesses entry exists only for multi-business sessions.
  const multi = getUser()?.isOwner || getBusinesses().length > 1;
  document.querySelectorAll('#sidebar .navitem').forEach(n => {
    n.classList.toggle('on', n.dataset.v === active);
    if (n.dataset.v === 'businesses') n.style.display = multi ? 'flex' : 'none';
    else n.style.display = biz ? 'flex' : 'none';
  });
  const who = document.getElementById('userchip');
  const u = getUser();
  who.style.display = u ? 'flex' : 'none';
  if (u) who.firstChild.textContent = u.name;
}

function boot() {
  document.getElementById('ver').textContent = 'v' + APP_VERSION;
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
  document.getElementById('logoutbtn').addEventListener('click', async () => {
    try { await fetch(ORIGIN + '/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` } }); } catch { /* signing out anyway */ }
    clearSession();
    location.hash = '';
    location.reload();
  });
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

boot();
