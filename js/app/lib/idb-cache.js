// ── lib: idb-cache — the per-business state-cache snapshot mirror, in IndexedDB ──────────────────────
// BackOffice's snapshot mirror (bo_state_cache_<biz>, ~7.4MB for tie-corp) moves here from the 10MB
// origin-shared localStorage so it can't fill it and block sign-in. The mirror is REGENERABLE (re-fetched
// from the Durable Object), so EVERY path here degrades to a re-fetch and the public functions NEVER reject
// and NEVER hang the boot path (timeout-bounded). Where IndexedDB is unavailable/blocked (private mode,
// disabled), the read/write transparently fall back to the old localStorage cache so offline reload still
// works. IndexedDB reports failures as ASYNC events (request.onerror, transaction.onabort, open onerror/
// onblocked), never as sync throws — every op wires those.
import { reportError } from '../reporter.js';
import { isQuotaError } from '../session.js';
import { isLegacyBoCacheKey } from './ls-quota.js';

const DB_NAME = 'bo-cache';
const STORE = 'snapshots';
const VERSION = 1;               // pinned — a later shape change bumps this with an upgrade handler
const OP_TIMEOUT = 1200;         // ms ceiling so a stalled IDB can never freeze the boot path — generous for
                                 // a healthy-but-busy open; only the first probe pays it (idbAvailable caches).

let _dbPromise = null;           // single cached connection
let _available = null;           // cached availability probe (null = unprobed)

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, VERSION); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
    req.onsuccess = () => {
      const db = req.result;
      // A version bump in another tab must not be blocked by this connection — close on demand.
      db.onversionchange = () => { try { db.close(); } catch (e) {} _dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('idb open error'));
    req.onblocked = () => reject(new Error('idb open blocked'));
  }).catch((e) => { _dbPromise = null; throw e; });   // let a later call retry a failed open
  return _dbPromise;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('idb timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// Run one request inside a transaction; resolve with its result on transaction COMPLETE, reject on the
// request's error OR the transaction's abort (a QuotaExceededError on write surfaces on the transaction).
function run(mode, make) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    let t, req;
    try { t = db.transaction(STORE, mode); req = make(t.objectStore(STORE)); }
    catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error || new Error('idb tx error'));
    t.onabort = () => reject(t.error || new Error('idb tx abort'));
    if (req) req.onerror = () => { try { t.abort(); } catch (e) {} };
  }));
}

// Async open-probe (cached): indexedDB may be present yet throw/err on open (private mode, sandboxed).
export async function idbAvailable() {
  if (_available !== null) return _available;
  if (typeof indexedDB === 'undefined' || !indexedDB) { _available = false; return false; }
  try { await withTimeout(openDb(), OP_TIMEOUT); _available = true; return true; }
  catch (e) {
    // A one-off TIMEOUT (a slow open under disk pressure) must NOT pin false for the whole session —
    // that would leave IDB inert and, after migration, blank an offline reload. Leave _available UNPROBED
    // so a later call retries (openDb's pending promise is reused). Only a definitive open FAILURE
    // (error/blocked, undefined indexedDB) disables IDB for the session.
    if (e && e.message === 'idb timeout') return false;
    _available = false;
    return false;
  }
}

// Read a cached snapshot string. NEVER rejects; timeout-bounded. Tries IDB, then falls back to a
// not-yet-migrated (or IDB-unavailable) localStorage copy, else null.
export async function idbGetCache(key) {
  try {
    const v = await withTimeout((async () => {
      if (!(await idbAvailable())) return undefined;         // signal "use localStorage"
      return await run('readonly', (s) => s.get(key));
    })(), OP_TIMEOUT);
    if (v != null) return v;                                  // IDB hit
  } catch (e) { /* timeout/error → localStorage */ }
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

// Write a cached snapshot string to IDB. NEVER rejects. Returns true ONLY when a durable IDB write
// completed (the caller uses that to lazily drop the legacy localStorage copy). On IDB unavailable/failure
// it best-effort writes localStorage (old behaviour) and returns false.
export async function idbSetCache(key, val) {
  try {
    if (await idbAvailable()) {
      await withTimeout(run('readwrite', (s) => s.put(val, key)), OP_TIMEOUT);
      return true;
    }
  } catch (e) { if (!isQuotaError(e)) reportError('idb.cache-write', e); }
  try { localStorage.setItem(key, val); } catch (e) { if (!isQuotaError(e)) reportError('sync.cache-write', e); }
  return false;
}

// One-time SAFE drain of legacy localStorage snapshot caches into IndexedDB. For each bo_state_cache_<biz>
// still in localStorage, write it to IDB and — only if that durable write confirms — remove the localStorage
// copy (migrate-then-delete; never empty in both stores). This frees the shared 10MB even for businesses not
// opened this session. Fire-and-forget at boot; a no-op (keeps localStorage) when IDB is unavailable.
// isLegacyBoCacheKey is a STRICT bo_state_cache_ prefix, so this NEVER touches muse_/td_ caches or any other key.
export async function migrateLegacyCaches() {
  if (!(await idbAvailable())) return;
  let keys = [];
  try { keys = Object.keys(localStorage).filter(isLegacyBoCacheKey); } catch (e) { return; }
  for (const key of keys) {
    let val = null;
    try { val = localStorage.getItem(key); } catch (e) { continue; }
    if (val == null) continue;
    if (await idbSetCache(key, val)) { try { localStorage.removeItem(key); } catch (e) {} }
  }
}

// Empty the IDB snapshot store (via clear(), NOT deleteDatabase — which would onblock other tabs).
// Returns the number of rows removed. NEVER rejects.
export async function idbClearCaches() {
  if (!(await idbAvailable())) return 0;
  // The clear() is the load-bearing part — the count() is only for the toast, so a count failure must
  // NEVER prevent the clear (the escape hatch has to work precisely under stalled storage).
  let n = 0;
  try { n = (await withTimeout(run('readonly', (s) => s.count()), OP_TIMEOUT)) || 0; } catch (e) { /* count is decorative */ }
  try { await withTimeout(run('readwrite', (s) => s.clear()), OP_TIMEOUT); } catch (e) { return 0; }
  return n;
}
