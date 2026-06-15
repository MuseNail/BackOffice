// ── Back Office service worker — precache + offline fallback ──
// CACHE_NAME must always match APP_VERSION (js/app/config.js) and version.json.
const CACHE_NAME = 'backoffice-v0.29.0';
const PRECACHE = [
  './js/app/views/reconcile.js',
  './js/app/views/reports.js',
  './js/app/views/inventory.js',
  './js/app/lib/coa-templates.js',
  './js/app/lib/money.js',
  './js/app/lib/posting.js',
  './js/app/lib/csv.js',
  './js/app/lib/match.js',
  './js/app/lib/musesync.js',
  './js/app/lib/processor-match.js',
  './js/app/lib/qb-iif.js',
  './js/app/lib/qb-iif-import.js',
  './js/app/views/vendors.js',
  './js/app/register.js',
  './js/app/views/banking.js',
  './js/app/views/review.js',
  './js/app/views/invoices.js',
  './js/app/lib/invoice2go.js',
  './js/app/lib/invoice2go-posting.js',
  './js/app/views/setup.js',
  './js/app/views/settings.js',
  './js/app/views/accounts.js',
  './js/app/views/ledger.js',
  './',
  './index.html',
  './css/styles.css',
  './js/app/main.js',
  './js/app/config.js',
  './js/app/store.js',
  './js/app/sync.js',
  './js/app/session.js',
  './js/app/ui.js',
  './js/app/views/login.js',
  './js/app/views/businesses.js',
  './js/app/views/dashboard.js',
  './js/app/views/stubs.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('backoffice-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // never cache Worker/API calls
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
