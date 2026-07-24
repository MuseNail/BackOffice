# BackOffice — cross-tab stale-rejection + edit-modal "null" — build brief

**Status: NOT STARTED. This is a grounded problem statement + candidate fixes from a live debugging
session — the next session must run the full rigorous-build pipeline (plan → adversarial plan review →
owner sign-off → TDD → 3-lens code review → senior review → report) and write its own plan before coding.**

Repo: `backoffice` (main-only). Live app: musenail.github.io/BackOffice, currently **v0.71.11**. Cloudflare
Worker: `backoffice.musenailandspa.workers.dev` (account info@musenailandspa.com). Money = integer cents;
double-entry ledger; the owner runs real books on it — treat the sync path as HIGH-RISK.

---

## The incident (diagnosed live, 2026-07-23)

The owner had a permanent **"Unsynced · 1"** badge that "Sync now" could never clear. Investigation (read the
owner's real `bo_failed_ops` + a fresh server fetch):

- It was **not** in the outbox — it was a **dead-lettered rejection**: TIE Corp txn `t-imp-mqhkaao1-r87`
  (2026-04-21, "Zelle to ShinyPawPrints", $1,588.00), `reason: 'stale'`.
- The owner had edited that txn to **attach invoice #4066 (Lavish Weddings)**. That edit **DID save** — the
  server copy carries `invoiceId` and a newer `updatedAt`; confirmed by a live `/b/tie-corp/state` fetch AND
  in the UI. Nothing was lost.
- The stuck copy was **byte-identical to the server copy in every field except `updatedAt`** (45 ms older).
  The same edit dispatched **twice, ~45 ms apart, out of order**; the newer landed, the older was correctly
  refused as `stale` and dead-lettered.
- The badge counts dead-lettered writes, so it showed "Unsynced · 1"; tapping **Sync now** re-queues the same
  stale copy → server refuses again → back to the log. A permanent loop. (The existing self-heal only covers
  `kind:'staged'` rows, not ledger `txn`s — see sync.js:259.)
- **Resolved manually** by deleting that one `bo_failed_ops` entry in the owner's browser (verified redundant
  first). Books untouched; badge back to green "Synced".

**Root cause of the duplicate out-of-order send: two BackOffice tabs both flushing the ONE shared outbox.**
`flushOutbox` guards with a per-tab module boolean `flushing` (sync.js:225) over the shared `bo_outbox`
localStorage key — so two tabs each pass their own guard and POST concurrently, out of order. v0.71.10's
`shiftIfHead` (sync.js:216) stopped this race from *losing* writes, but not from producing a redundant
out-of-order send that the server rejects as stale.

---

## The three fixes (candidate — the next session designs + reviews them properly)

### Fix 1 — cross-tab flush lock (ROOT fix; client-only)
`flushOutbox` (sync.js:224) must serialize across tabs, not just within a tab. Use the **Web Locks API**:
wrap the drain in `navigator.locks.request('bo-outbox-flush', async () => { … })` so only one tab per origin
flushes at a time. Keep the in-tab `flushing` boolean as a cheap re-entrancy guard, or fold it in.
- **Fallback:** browsers without `navigator.locks` (very old) keep today's per-tab guard — feature-detect.
  (Chrome + iPad Safari 15.4+ support it; the owner is covered.)
- **Care:** `flushOutbox` is called from `dispatch`, `syncNow`, `saveOrphanTo`, `openBusiness`, `resync`,
  reconnect — the lock must wrap the whole drain and always release (the callback-scoped lock does this
  automatically). Do NOT hold the lock across the `await api()` in a way that can deadlock a second tab
  forever — the lock is released when the callback promise settles, so a normal drain is fine; just ensure
  the function still returns/settles on every path (offline `return`, etc.).
- Client-only (sync.js). No Worker change.

### Fix 2 — auto-resolve a REDUNDANT stale rejection (safety net; client + Worker)
When a write is refused `stale` but is a **content no-op** vs what the server already holds, DROP it silently
instead of dead-lettering it (which strands a permanent, un-clearable badge). **Only when provably identical.**
- The client can't currently prove content-identity: the 409 body returns only `storedUpdatedAt`
  (business.js apply() stale path), not the stored value. And the client's own store holds the OPTIMISTIC copy,
  so comparing against it is unsafe.
- **Design:** on the stale rejection, the DO returns the stored entity (or a content signature) so the client
  can compare. Worker: `business.js` apply() stale branch →
  `return { rejected:true, reason:'stale', storedUpdatedAt: existing.updatedAt, stored: existing }`. Client:
  in `flushOutbox`'s 409 `reason==='stale'` branch (sync.js:250-283, AFTER the staged self-heal), if a pure
  `isRedundantWrite(op.value, body.stored)` — deep-equal **ignoring `updatedAt`/`updatedBy`** — is true, drop
  the item (shiftIfHead + continue, no deadLetter, no alarm). Else dead-letter as today.
- **Safety (non-negotiable):** drop ONLY a provably-identical no-op. Anything that differs in any real field is
  a genuine conflict and is preserved exactly as today. NEVER force-apply a stale txn by re-stamping it — for a
  ledger txn a stale rejection can legitimately mean *another device's newer edit should win*; the staged
  self-heal's re-stamp trick is safe only because staged rows carry no ledger lines. Do not extend it to txns.
- Pure helper `isRedundantWrite(a, b)` → node-tested. Worker change ⇒ needs `wrangler deploy` (owner OK).
- Consider: does the DO also need to return `stored` on the `entity.bulkUpsert` skip path? Probably out of
  scope (bulk is sync/import machinery); decide + record.

### Fix 3 — stray "null" in the Edit-transaction dialog (client-only; tiny)
`editTxnModal` (ledger.js) builds the modal with `m.body.append(isRecon ? el('p',…) : null, …)`. `m.body` is a
real DOM node, and **native `Node.append(null)` coerces to the text node "null"** — visible above the Date
field whenever a txn isn't reconciled (almost always). The same `m.body.append(cond ? x : null)` pattern
appears several times in that append list (and possibly other modals). **Fix:** don't pass falsy to native
`.append` — filter (`[...].filter(Boolean)` then spread), or use `''`/`el('span')`, or route through an
`el(...)` wrapper (the `el` helper already drops null children). **Grep `m.body.append(` across the app** for
the same `: null` pattern and fix them together (or fix `modal`/append centrally). Cosmetic, no data impact.

---

## Sequencing + release
- Fixes 1 & 3 are **client-only**; Fix 2 touches the **Worker** (needs `wrangler deploy`).
- Fix 1 is the root fix and highest value — the reviewers may want it first/standalone. Fix 2 is the belt so a
  stuck badge can never recur even if a race slips through. Fix 3 rides along.
- One version bump (next after 0.71.11 — check `js/app/config.js`) across the trio (`config.js` APP_VERSION +
  `version.json` + `sw.js` CACHE_NAME) + a plain-English `changelog.js` entry. New pure lib files → add to the
  `sw.js` precache list.
- `git push` and `wrangler deploy` each need the owner's explicit OK.

## Test plan (TDD)
- `isRedundantWrite` pure helper — truth table (identical-except-timestamps ⇒ true; any real field differs ⇒
  false; missing/junk ⇒ false/safe).
- Flush-lock: hard to unit-test the Web Lock directly; extract any pure decision if possible, else a
  browser/manual two-tab check. Do NOT regress the existing sync tests.
- The stale-redundant drop path: a small test that a redundant stale 409 drops the item and a
  genuinely-different stale 409 still dead-letters (extract the 409-decision into a testable seam if feasible).
- All existing test files stay green (⚠️ Windows: `node --test --test-force-exit tests/<f>` per file; globs hang).

## Guardrails
- The sync path already carries the wrong-business (Layer 1-3) + stale-guard + shiftIfHead machinery — read
  `SYNC-MISROUTE-PLAN.md` before touching `sync.js`/`business.js`. Don't regress any of it.
- Live-verify safely: never post a test txn to the real ledger; compare/read-only where possible; the owner can
  drive a two-tab reproduction if needed.
