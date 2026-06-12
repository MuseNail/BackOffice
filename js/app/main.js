// ── main — boot, hash router, view mounting ────────────────
// No window glue: views bind their own events. Routes:
//   #/login        sign in (M0: paste bootstrap token)
//   #/businesses   selector + create (owner only from M2)
//   #/b/<id>/<view>
import { APP_VERSION } from './config.js';
import { getToken, getActiveBiz, setActiveBiz } from './session.js';
import { openBusiness, setStatusListener } from './sync.js';
import * as login from './views/login.js';
import * as businesses from './views/businesses.js';
import * as dashboard from './views/dashboard.js';
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
  settings: stub('Settings', 'M2 — users/PINs/roles; M11 Muse sync; M12 IIF export'),
};

let current = null;

function route() {
  const hash = location.hash || '#/';
  const root = document.getElementById('view');
  current?.unmount?.();

  if (!getToken()) { current = mount(login, root); return; }

  const m = hash.match(/^#\/b\/([a-z0-9-]+)\/(\w+)/);
  if (m) {
    const [, biz, viewName] = m;
    if (getActiveBiz() !== biz) { setActiveBiz(biz); openBusiness(biz).catch(console.error); }
    setNav(viewName, biz);
    current = mount(VIEWS[viewName] || VIEWS.dashboard, root);
    return;
  }
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
  document.querySelectorAll('#sidebar .navitem').forEach(n => {
    n.classList.toggle('on', n.dataset.v === active);
    if (n.dataset.v !== 'businesses') n.style.display = biz ? 'flex' : 'none';
  });
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
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

boot();
