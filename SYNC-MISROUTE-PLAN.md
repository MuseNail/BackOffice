# Wrong-business writes — fix plan (re-grounded to v0.71.7)

**Origin:** a $4,000 TIE Corp txn sat POSTED in Muse's books for a month (removed 2026-07-17). Root cause
diagnosed + a 3-layer fix twice-adversarially-reviewed in a prior session (notes: [[bo-wrong-business-writes]]).
This doc re-grounds that plan to the current code (repo now at v0.71.7; the prior plan said 0.71.6 and the
line numbers shifted 0 — `sync.js` is unchanged) and scopes **Layer 1** for build now.

## Root cause (plain English)
When BackOffice has a write it couldn't stamp with a business (an "orphan" — e.g. queued while signed out, or
a legacy pre-v0.70.1 row), the app **guesses** which business's books it belongs to — it sends it to whatever
business happens to be open. With two tabs open on different businesses, the guess can land a write in the wrong
company's ledger. That's how a TIE transaction ended up a second copy inside Muse.

## Technical root (verified against current code)
- The **guess** lives in two places: `flushOutbox` (`sync.js:144-147` — `!item.biz` → re-route to
  `wsBiz || getActiveBiz()`) and `syncNow` (`sync.js:106,111` — `biz: f.biz || b`).
- The vector is **cross-tab**: `flushing` is a per-tab guard (`sync.js:13,133`) but `bo_outbox` is ONE global
  localStorage key (`config.js:23`), so two tabs read the same queue head and each guesses its own destination.
- `dispatch` (`sync.js:73`) stamps `wsBiz || getActiveBiz()` at QUEUE time — that's the acting context, correct;
  it is NOT the guess. `wsBiz` is per-tab so it protects the stamp once set (Layer 2 hardens the load-window gap).

## The reviewed 3-layer fix (re-numbered — 0.71.7 is taken by the bank-feed UI)
- **Layer 1 — v0.71.8 (THIS build): never guess + fix the recovery UI.** Stop guessing an orphan's business;
  preserve it in the dead-letter log and let the owner route it by hand. Ships WITH the recovery UI (below) —
  shipping the "never guess" half alone is a REGRESSION (orphans would pile into a log that can't recover them
  and whose Clear-all deletes them).
- **Layer 2 — v0.71.9 (next): route by data.** A `getStateBiz()` (the business the loaded state actually belongs
  to) becomes the routing authority (`getStateBiz() || getActiveBiz() || wsBiz`), plus the empty-store stamp at
  `openBusiness`, a `ws.onmessage` business check, the `sync.js:170` self-heal guard, and — **the worst LIVE hole
  — Plaid.** Plaid connect/map/sync route by the shared `getActiveBiz()` and write server-side directly (no
  outbox, no stamp), so a wrong-tab connect binds a bank feed to the wrong business PERMANENTLY. Interim
  mitigation in force: **connect Plaid with only one BO tab open.**
- **Layer 3 — v0.71.10 (last): server stamp.** Client stamps `getStateBiz()` on each op; the Worker sets an
  unspoofable `X-Bo-Biz` header (beside `X-Bo-Role`/`X-Bo-User`, `index.js`); the DO's `apply()` rejects when
  both are present and differ → 409 → dead-letter. Belt-and-suspenders; a no-op without Layer 2.

## Layer 1 — concrete changes (this release)

### A. `sync.js` — never guess (dead-letter instead)
1. `flushOutbox` (:144-147): an orphan (`!item.biz`) is **dead-lettered** (`deadLetter(item, 'no-business')` +
   shift + continue) — delete the `wsBiz || getActiveBiz()` re-route. It still unjams the queue (it shifts), it
   just never guesses a destination.
2. `syncNow` (:105-117): **do not re-queue orphans.** Split the failed log — re-queue only entries WITH a `biz`
   (real rejections the owner may retry); leave `!biz` orphans in the failed log for the recovery UI. This closes
   the "syncNow re-queues an orphan → flush dead-letters it → loop + a `{serious:true}` push per tap" spam.
3. New export `saveOrphanTo(biz, op)`: push `{biz, op}` onto `bo_outbox` and `flushOutbox()` — the recovery UI's
   per-row "Save to these books" action calls it. (dispatch can't be reused — it re-stamps its own biz.)

### B. `views/settings.js drawFailedOps` — a recovery UI that can actually recover (non-negotiable with A)
1. **Readable rows.** Replace `fmtWhat` ("entity.upsert txn t-imp-…") with a human summary: for a txn
   (`op.value` with `payee`/`date`/`lines`) show **date · payee · amount** (sum the bank-side line via existing
   money formatting); fall back to `op.op kind` for non-txn ops.
2. **Per-row "Save to these books" for orphans.** An entry with `!e.biz` renders a small business picker (from
   `getBusinesses()`) + a "Save" button → `saveOrphanTo(chosenBiz, e.op)` + remove that entry from `LS.failed` +
   redraw. Entries WITH a `biz` stay view-only (a server rejection re-rejects on retry; that's not this bug).
   Orphans are visually flagged ("⚠️ not saved yet — choose its business").
3. **Clear-all refuses orphans.** Change `kept = log.filter(e => e.biz && e.biz !== biz)` (which DROPS orphans)
   to `kept = log.filter(e => !e.biz || e.biz !== biz)` (keeps orphans + other-biz; clears only THIS business's
   stamped diagnostic rejections). Update the copy to say orphans are kept ("un-saved writes stay until you file
   them").

### C. Money-derivation helper
Reuse `ui.js fmtMoney`/`acctAmount` + `lib/posting.js` (bank-line sum) for the row amount — no new money math.

## Testing (TDD)
Pure/unit where possible: a `syncNow`-splits-orphans-from-routable test and a `saveOrphanTo` round-trip
(orphan in failed → picked business → lands in outbox with that biz, gone from failed). The `flushOutbox`
dead-letter-orphan path and `drawFailedOps` rendering are covered by a small harness / manual owner check
(login-gated). ⚠️ Windows: `node --test --test-force-exit tests/<f>` per file. Do NOT regress `features.test.mjs`
(has 10 no-arg `setSnapshot` calls — Layer 1 doesn't touch `setSnapshot`, so they stay green).

## Out of scope for Layer 1 (recorded)
Plaid direct-write routing, `getStateBiz()`/route-by-data, `ws.onmessage` biz check, the `sync.js:170` guard,
server `X-Bo-Biz` stamp — all Layer 2/3. Also recorded, not fixed: `/ai/categorize` + `/suggest` cross-business
routing (a confidentiality concern), `deadLetter` `slice(0,100)` dropping entry #101.

## Release
Client-only (Layer 1 touches no Worker code). Version trio → 0.71.8 + a `changelog.js` entry. Push needs owner OK.

**Layer 1 SHIPPED** — v0.71.8, pushed `37ad19f`, Pages live 2026-07-17.

---

# Layer 2 — concrete build spec (v0.71.9) — route by the loaded business + Plaid

**The root fix.** Writes route by the **per-tab loaded business**, not the **shared** active-biz marker. A new
`getStateBiz()` — the business the current tab actually loaded, client-tracked from the `bizId` `openBusiness`
fetched for — becomes the routing authority. The shared `bo_active_biz` is last-tab-wins (`main.js:133`
`setActiveBiz(biz)`), so two tabs on different companies share it; `stateBiz` is per-tab module state, so each
tab routes to its OWN company. Client-only, no Worker change. (Grounded: `setSnapshot` stores only
`{meta,entities,seq}` — the DO can't know its own id, `meta` has the business NAME not its id (setup.js:111) —
so `stateBiz` is client-tracked, never derived from snapshot content.)

### A. store.js — the state-biz authority
- `let stateBiz = '';` · `export function getStateBiz(){ return stateBiz; }` · `export function setStateBiz(b){ stateBiz = b || ''; }`
- `setSnapshot(snap, biz)` sets `stateBiz = biz || ''` **unconditionally** — a no-arg call clears to `''` so routing
  falls back safely (never a stale-truthy WRONG value). `features.test.mjs`'s 10 no-arg `setSnapshot` calls stay green.

Also: `clearSession()` (session.js) calls `setStateBiz('')` — the idle path re-routes to login WITHOUT a reload, and
`stateBiz` is now the TOP routing authority, so a sign-out must clear it or it survives into the next user's session.

### B. sync.js — route by getStateBiz, close the load window
- import `getStateBiz, setStateBiz` from store.js.
- `openBusiness(bizId)`: synchronously `setStateBiz(bizId)` at the TOP. Empty-store stamp on BOTH cache-miss cases
  (wrong `_biz` AND `cached===null`): `if (cached && parsed._biz===bizId) setSnapshot(parsed, bizId); else
  setSnapshot({meta:null,entities:{},seq:0}, bizId)` — so the previous business's data is never shown/read during the
  fetch. **⚠️ BLOCKER GUARD (the fix the review caught):** after `await api('/b/'+bizId+'/state')`, apply ONLY when
  `getStateBiz()===bizId` — otherwise DISCARD the reply entirely (no `setSnapshot`, no cache write, no
  `replayOutboxLocal`, no `connectWS`). `openBusiness` is fired fire-and-forget + re-entrant from `main.js:133`, and
  `wsBiz`/`connectWS` are set only AFTER the await — so without this guard a slow business-A reply resolving after the
  user clicked business B re-stamps `stateBiz='A'` and the next txn routes to A. This REGRESSES today's fast-switch
  behavior; the guard is mandatory. Same guard in `resync(bizId)` (a late old-socket reply must not re-stamp/rewrite).
- `dispatch` (:73): `const biz = getStateBiz() || getActiveBiz() || wsBiz;` — per-tab first; `getActiveBiz` is
  synchronous but SHARED (could be another tab's); `wsBiz` is set only after an await, so LAST.
- `ws.onmessage`: **capture the socket's business in the closure** — in `connectWS` add `const socketBiz = bizId;`
  and gate `msg.op?.device!==deviceId() && socketBiz===getStateBiz()`. (A module-level `wsBiz===getStateBiz()` guard
  is a NO-OP — `connectWS` overwrites `wsBiz` to the new business on switch, so the old socket's closure reads the new
  value and passes; only a per-socket capture blocks a switched-away socket's still-queued frames.)
- 409 self-heal (:170): `if (item.biz===getStateBiz()) applyChange(item.op)` — healing a queued op for a DIFFERENT
  business than the one loaded must not corrupt the loaded state.
- `saveOrphanTo` (:135, from Layer 1): gate the optimistic apply on `biz===getStateBiz()` (was `wsBiz`) for
  consistency with the above (low priority; it self-corrects, but align the authority).

### C. Plaid + confidentiality sweep (drive by GREP, not a line list)
- **Plaid (the worst hole):** grep `banking.js` + `plaid-connect.js` for EVERY `getActiveBiz()` Plaid site — a fixed
  line list already missed one. Confirmed sites → `getStateBiz()`: `plaid-connect.js:154` (disconnect), `:206`
  (openPlaidLink), `:276` (linkExistingAccount), `:300` (connectedModal sync); **`banking.js:123` (`syncPlaid` "Sync
  now" — the load-bearing miss)** + `maybeLoadFeedIntel`. Evaluate `banking.js:114` (ledger href) / `:385` (post-import
  redirect) per-site. **`map`/`exchange` (206/276) are the permanent-misbind class** (bind a feed to the wrong
  company forever — Plaid has NO Layer-3 server backstop, it routes by URL path); `syncPlaid` (123) is B→B
  annoyance-grade (syncs the wrong-but-own business + mislabels the toast), still swept.
- **OAuth resume is SAFE (confirmed):** connect-time `{linkToken,bankacctId,biz,startDate}` is stashed in
  `sessionStorage`; `resumePlaidOAuth` threads `saved.biz` through `onConnected`/`map`/`exchange` — never re-reads the
  marker. The empty-store stamp intentionally does NOT cover the resume window (map write is safe; only a post-connect
  row count can read a stale store — a pre-existing cosmetic issue).
- **Confidentiality sweep:** add `invoices.js:243` + `:1057` (`/ai/match-invoices`) alongside `review.js`
  `/ai/categorize` → `getStateBiz()` (both POST this business's payments/invoices to an AI endpoint keyed by the shared
  marker → a two-tab cross-tenant leak). **Do NOT bare-swap `client.js:265` `/suggest`** — the client app is
  single-business (`getStateBiz()===getActiveBiz()` always), so a bare swap is zero-benefit and adds a `/b//suggest`
  failure surface; leave `getActiveBiz()`. Deferred + recorded (read-only, lower risk): Helcim `/processor/helcim/
  transactions` GETs (`review.js:1017`, `deposits.js:63`, `search.js`).

### D. setup.js — no change needed
`create()` POSTs raw to the explicit new `id` (not a guess), then `#/b/<id>/dashboard` → `openBusiness(id)` stamps
`stateBiz`; the empty-store stamp (B) closes the post-create window.

### Testing (TDD)
- Pure `routeBiz({stateBiz, activeBiz, wsBiz})` (`stateBiz || activeBiz || wsBiz`, blanks skipped) + test.
- **Blocker regression test:** an `openBusiness(A)` reply arriving after `setStateBiz(B)` must NOT change
  `getStateBiz()` nor write B's store (needs a testable seam — extract the guarded-apply into a pure/injectable unit,
  or a browser harness). This is the highest-value test.
- `setSnapshot(snap, biz)` set/clear of `stateBiz` (if store.js loads under node; else browser harness). ws-guard +
  Plaid routing = browser/manual. No `features.test.mjs` regression. ⚠️ Windows: `node --test --test-force-exit tests/<f>` per file.

### Out of scope → Layer 3 (v0.71.10): server `X-Bo-Biz` unspoofable stamp. Deferred polish: a loading spinner during
the empty-store window (safety covered by the empty clear); Helcim processor-read confidentiality sweep.

### Deferred to Layer 3 (display/nav only — server-enforced, not book-writes)
Left on the shared `getActiveBiz()` deliberately: `canEdit(...)` display gates in accounts/customers/vendors/ledger/
reconcile/inventory (fail-closed + server-enforced; each view's content is also getActiveBiz-derived, so internally
consistent), in-view navigation hrefs (`invoices.js:136/749/1129`, ledger/settings back-links), and the reports CSV
export filename. These are UI/nav affordances (they self-correct on `route()`), not cross-business writes. A Layer-3
pass can converge them on `getStateBiz()` for full per-tab consistency.

### Review record (Layer 2)
PLAN review (4-lens, ready-with-edits): 1 BLOCKER (stale-reply guard → B), 1 must (Plaid grep vs line-list → C), 5
should — all folded in. CODE review (3-lens + senior, ship-after-fixes): 1 HIGH — **`settings.js` `/registry` user/
device admin WRITES (create/update/reset-PIN/delete/revoke) were still on `getActiveBiz()`** (a real cross-business
write path + roster PII read; app-owner is a member of every business so no server backstop) → FIXED (`:49/:77` →
`getStateBiz`). Should-fixes applied: `banking.js:80` canEdit + `reports.js` tax rateKey/gate → `getStateBiz` (same-file
consistency + a device-local write). In-view nav hrefs + other canEdit gates deferred + documented (above).
