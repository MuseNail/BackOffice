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
