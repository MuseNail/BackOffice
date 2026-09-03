# Storage-quota hardening — plan & backlog

## The incident (2026)
On one shared device the owner could not sign in to BackOffice ("unable to reach the server"), while other
devices worked. Root cause: **localStorage was full at the 10 MB per-origin limit.** All three apps
(BackOffice + Muse + TurnDesk) live on `musenail.github.io` and each caches a full copy of its data there for
instant offline reload; `bo_state_cache_tie-corp` alone was **7.4 MB**. When localStorage is full, the sign-in
handler's `setToken`/`setUser`/`setBusinesses` writes throw `QuotaExceededError`, and the `catch` in
`js/app/views/login.js` mislabels it "Can't reach the server." So auth succeeds server-side but the token can't
be saved locally → the user can never get in.

Immediate fix applied (on the device): cleared the regenerable `*_state_cache_*` mirrors (freed ~9.2 MB);
they re-fetch from the DO on next load. This is temporary — the caches refill and re-block sign-in.

## ✅ Option 1 — "Never block sign-in" hardening (APPROVED, to build)
Small, contained change so a full cache can never block login again:
- A `safeSetItem(key, val)` that, on `QuotaExceededError`, **evicts other/oldest `*_state_cache_*` keys and
  retries** — used by `session.js` `setToken`/`setUser`/`setBusinesses` so the tiny token write always succeeds.
- Wrap the large state-cache write (`sync.js` `openBusiness` → `localStorage.setItem(LS.cache…)`) in try/catch so
  a full cache **fails gracefully** (the app still runs; it just re-fetches next load) instead of throwing.
- `login.js`: save the token BEFORE the big writes, and stop reporting a **storage** failure as a **network**
  failure ("Can't reach the server").
- (Optional tidy) a "Clear local cache" button in Settings for a stuck shared device, and drop non-active
  business/app caches proactively.
Keeps localStorage; removes the user-facing lockout. Full rigorous-build when built (it touches sign-in/sync).

## 🚩 Option 2 — Move the big state cache to IndexedDB (FLAGGED, near-future — owner will greenlight)
The structural long-term fix. Move the large `*_state_cache_*` mirrors out of the 10 MB localStorage into
**IndexedDB** (far larger, disk-based quota). localStorage then holds only small keys (token, outbox, device id)
and can't fill.
- Trade-off: IndexedDB is **async**, but the app reads the cached snapshot **synchronously at boot** for instant
  offline render — so the boot/hydration flow changes (async cache load, a brief pre-cache render). Higher effort
  + testing; ideally applied to all three apps (Muse + TurnDesk share the same pattern). Its own project.
- **Do NOT start until the owner says go** (they asked to be asked first).

## Order (owner, this cycle)
1. Approve speed (Review re-render coalescing) · 2. Client can suggest bank/CC transfers · 3. Option 1 above ·
4. Ask the owner before starting Option 2 (IndexedDB).
