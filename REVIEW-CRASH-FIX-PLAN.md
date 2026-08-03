# Fix plan (v2) — Review screen crash: "Assignment to constant variable"

*Revised after a 4-lens adversarial plan review (correctness / ops-safety / necessity / completeness). Changes from v1: dropped the extracted helper in favor of an inline `const` ternary; corrected the trigger/timeline; rewrote the release sequencing with exact git steps; honest test/verification section.*

## The bug (root cause, confirmed)
- **File/line:** `js/app/views/review.js:310`
- Line 301 destructures `vendPrefillText` as a **`const`** from `resolveRowSuggestion(...)`.
- Line 310 **reassigns** it: `if (!vendPreselect && row.suggestedVendorName) vendPrefillText = row.suggestedVendorName;`
- Reassigning a `const` throws **`TypeError: Assignment to constant variable`**, aborting `drawBody` (the Review list render) — which is why approvals "don't save."

## Trigger + timeline (corrected — it was NOT introduced today)
- `row.suggestedVendorName` is populated by the **client-facing app** at `client.js:277` when a client submits a transaction and types a **brand-new vendor name** instead of picking an existing vendor (`suggestedVendorName: d.vendorId ? '' : (d.vendorName||'').trim()`).
- The reassignment (line 310) was added **2026-07-01 (v0.69.27, `80b7f5a`)** as a `let` — legal then.
- The conflicting `const` destructure (line 301) landed **2026-07-17 (v0.71.11, `6bc7033`)**.
- ⇒ The crash has been **latent since 2026-07-17**. It fires only while rendering a review row that has a client-suggested **new** vendor name **and** no vendor preselected. Most batches contain no such row, so it looked fine until a batch with one showed up (Carlos, 8/3 12:22 AM, 2×, `#/b/tie-corp/review`, v0.71.13).
- ⚠️ Honesty note: I cannot read the live tie-corp Durable Object (needs the owner's device token), so I have not eyeballed the exact offending rows — but the code path that sets the field and the code path that crashes on it are both confirmed, which fully explains the symptom.

## Impact / data safety
`drawBody` throws → the Review list fails to finish rendering / re-render after an action → affected rows can't be approved. **Nothing was lost or misrouted:** sync pill is "synced"; no `sync.rejected-write`/orphan entries. Affected rows remain **pending** in Review and will approve normally once fixed.

## Fix (inline `const` ternary — root-cause, immutable, smallest honest diff)
No new helper, no new export/import. Remove the reassignment; compute the value once as a `const` after `vendPreselect` is known.

**`js/app/views/review.js`:**
- **Line 301** — rename the resolver's field so the final value can own the `vendPrefillText` name:
  `const { sug, vendorTag, vendPrefillText: resolvedPrefill, source } = resolveRowSuggestion(row, {...});`
- **Delete line 310** (the reassignment). Keep the **account**-prefill half of the 308–309 comment attached to line 311 (`acctPrefill`); it documents both — only the vendor sentence goes away.
- **After line 307** (where `vendPreselect` is computed), add:
  ```js
  // A client typed a brand-new vendor name to add (created on Approve) → prefill the field
  // with it; otherwise use the resolver's AI/rule prefill. (No reassignment — this replaces the
  // old const-reassignment that crashed the Review render on client-suggested new-vendor rows.)
  const vendPrefillText = (!vendPreselect && row.suggestedVendorName) ? row.suggestedVendorName : resolvedPrefill;
  ```
- Usages at **327** (`vendorSelect(..., vendPrefillText)`) and **340** (ai-vendor chip text) are unchanged.

### Behavior-preservation proof (verified against the code by 4 reviewers)
- `vendPrefillText` is **not read between line 301 and 307**, so computing it after 307 is safe.
- In all four `{vendPreselect}×{suggestedVendorName}` combinations the new expression yields the **exact** value the old start-then-maybe-reassign produced. Lines 327 and 340 therefore receive identical values.
- `source` is computed **inside** `resolveRowSuggestion` from the pre-override value and is untouched here, so the ai-vendor chip's branch selection at 340 is unchanged. (The chip's override×ai-vendor interaction is near-unreachable in practice — a `suggestedVendorName` row is a client suggestion, which classifies as `source:'client'`, not `'ai-vendor'` — so this is moot either way.)
- The `resolvedPrefill` value from the resolver is always a string (`''` or `aiSug.vendorName`), so no `undefined`/throw is possible; no extra `|| ''` guard is needed.

## Alternatives considered (and why rejected)
- **Extracted pure `vendorPrefill()` helper (v1 plan):** rejected. Its unit test would exercise a trivial ternary and **cannot** catch a view-layer `const`-reassignment (the actual failure mode), so the "adds regression coverage" justification was false. Adds cross-file indirection against the repo's "no premature abstraction" rule. The inline ternary is equally root-cause with a smaller diff.
- **Whole-line `const`→`let` at 301:** rejected. Fixes the crash but needlessly makes `sug`/`vendorTag`/`source` mutable and leaves the reassignment pattern in place.

## Test / verification (honest — no DOM harness exists in this repo)
- There is **no jsdom / DOM harness** here; BackOffice tests pure logic only. A `const`-reassignment is a **code-shape** bug, not a logic bug — no pure unit test meaningfully guards it, and standing up a DOM render harness for a one-line fix is disproportionate and brittle. So **no automated test is added** (adding one would be theater).
- **Regression guard = the fix itself** (the mutation is gone; there is nothing left to reassign) **+ a codebase sweep** (done: repo-wide scan for const-destructure-then-reassign; only real hit was this one; review.js otherwise clean incl. line 1208).
- **Manual verification (required before ship):** in the running app, open a Review batch containing a row with a client-suggested **new** vendor name and no preselected vendor (the exact trigger), and confirm: (1) the Review list renders with **no `TypeError` in the console**, (2) the vendor field is prefilled with that name, (3) **Approve saves** the row. Given I can't reach the owner's live books, this step is the owner's (or done together) — I will not claim "verified/live" without it.
- Full test suite still run (`node --test --test-force-exit tests/<file>.test.mjs` per file — Windows globs hang) to prove **no regression** in the pure modules.

## Release sequencing (tightened — main-only tree with WIP in the 0.71.14 slot)
`main` has **uncommitted WIP** (invoice-ledger-status): tracked edits to `invoices.js` + the version trio + `changelog.js` (already a `{ v:'0.71.14' … }` invoice entry), **plus two UNTRACKED files** (`js/app/lib/invoice-ledger-status.js`, `tests/invoice-ledger-status.test.mjs`). The crash fix must ship **isolated** from this unfinished feature.

**Sequence (Option A, corrected):**
1. `git stash push -u -m "invoice-ledger WIP"` — **`-u` includes the untracked files** so the hotfix tree is pristine at committed `0.71.13`. (Plain `git stash` would leave the untracked WIP behind → risk of it leaking into the hotfix.)
2. Apply the review.js fix. Bump the **trio together** to **0.71.14**: `config.js` APP_VERSION, `version.json`, `sw.js` CACHE_NAME (`backoffice-v0.71.14`). Both `review.js` **and** `review-source.js` are in `sw.js` PRECACHE, so the CACHE_NAME bump is load-bearing (without it users keep the crashing cached module).
3. Add a `changelog.js` entry for **0.71.14** (crash fix). Draft copy: **"Fixed a Review error that could stop some client‑suggested transactions from saving."**
4. Run the test suite (no regressions) + do the manual verification above.
5. **Stage by explicit path only** (never `git add -A`): `review.js config.js version.json sw.js changelog.js`. Commit the hotfix.
6. **With the owner's explicit OK:** `git push` (GitHub Pages auto-deploys `main`). No `wrangler deploy` — the Worker is untouched.
7. `git stash pop` — **expect conflicts on exactly 4 files**: `config.js`, `version.json`, `sw.js`, `changelog.js`. Resolve by setting the whole trio to **0.71.15** (same number in all three) and **renumbering the WIP changelog entry `0.71.14`→`0.71.15`**. Then `grep 0.71.1 config.js version.json sw.js` to confirm all three match. The invoice WIP continues as 0.71.15.

**Rollback:** single-commit revert of the hotfix; no data/op/schema/Worker change, nothing to migrate.

## Owner decisions needed at the sign-off gate
1. **Fix approach:** inline `const` ternary (recommended) — OK?
2. **Test approach:** manual verification only (recommended, proportionate) vs. invest in a DOM render harness for a true automated red→green? (Recommend manual.)
3. **WIP:** OK to `git stash -u` your invoice-ledger WIP, ship the isolated 0.71.14 hotfix, then restore it as 0.71.15? (Is that WIP safe to set aside briefly?)
4. **Push:** confirm I have your OK to `git push` to `main` (auto-deploys) once tests + manual verification pass — or hold for your review of the diff first.

## Files touched
- `js/app/views/review.js` (lines 301 / delete 310 / new const after 307)
- version trio (`config.js`, `version.json`, `sw.js`) + `changelog.js` — on release, per the sequence above
- *(no test file; no lib change; no Worker change)*
