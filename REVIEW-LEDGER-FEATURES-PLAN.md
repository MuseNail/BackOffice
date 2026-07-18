# Review + Ledger features (v0.71.11) — build plan (v2, rewritten from the 4-lens committee)

Four owner-requested features + two cheap L3 follow-ups, one release, each a separate commit.
Owner answered scoping questions (2026-07-18). This v2 folds in the adversarial plan review (4 lenses, all
"needs-rework"; every must/blocker addressed below). Grounded in reads of the actual code.

Repo rules (CLAUDE.md): money = integer cents; ledger append-only / double-entry (`lines[]` sum 0); NO window
glue, NO inline onclick; pure logic → `js/app/lib/` with tests; stale-write guard symmetry (store.js + DO apply);
version trio bump together; comments say WHY.

**★ Committee-driven headline change: the WHOLE release is now CLIENT-ONLY — no `wrangler deploy`.** Item 3's
soft-delete needs no Worker change once we (a) keep deleted rows counted in the dedup budget (no `stagedIndex`
guard) and (b) do NOT stamp `updatedAt` on the status flip (so the stale-guard never fires). Only `git push`.

---

## Item 1 — Timezone: fix evening "wrong day" bugs (owner: "Fix the wrong-day bugs", no TZ setting)

**Root cause.** No tz configured; most date math is browser-local (correct for PST) but several spots derive the
calendar day/month in **UTC** (`new Date().toISOString().slice(0,10|7)`) → read *tomorrow*/*next month* from
~4–5pm Pacific. Plaid already got a local-day fix (`plaid-feed.js todayLocal`, tested); these didn't.

**Fix.** Add pure, `now`-injectable helpers to `js/app/daterange.js` (the browser-local date home). To avoid a
2nd local-day implementation (committee note), define `todayLocal` via the file's existing local formatter, and
have `plaid-feed.js` DELEGATE its `todayLocal` to the shared one (keeps `plaid-feed.test.mjs`'s import resolving,
same `en-CA`/local semantics):
- `export const todayLocal = (now = new Date()) => \`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}\`;` (local Y-M-D — identical output to `toLocaleDateString('en-CA')` but no locale dependence).
- `export const monthLocal = (now = new Date()) => todayLocal(now).slice(0, 7);`

Swap these UTC day/month derivations to the helper (client only; the owner-visible ones):
- **Writes a wrong DAY:** `ledger.js:554` (Add-txn default), `banking.js:168` (account open), `banking.js:233`
  (quick expense), `inventory.js:187` (stock adjustment), **`deposits.js:41`** (default reconcile-window end —
  the committee-caught miss; only `deposits.addDays` is noon-anchored/safe, the `iso(new Date())` SEED is not).
- **Wrong MONTH / "as of" on screen:** `dashboard.js:54` (this-month P&L — most visible), `dashboard.js:25,28,33`,
  `reports.js:23`, `reconcile.js:19`, `settings.js:340-341` (QB export range), `invoices.js:66` (A/R aging today),
  `search.js:63` (90-day filter).
- **Low-impact, swept for completeness:** `review.js:1017` (Helcim lookback `dateFrom` — only widens a match
  window; swap too so a future sweep isn't needed).

**Explicitly OUT (verified UTC-safe, do NOT touch):** the server AI-usage month (`business.js:88`,
`ai.js:142,269`) + its client mirror (`settings.js:248`) — client/server agree; changing one desyncs them.
Noon-anchored math (`processor-match.js:41-46`, `deposits.js:19-20 addDays/daysBetween`) — ±14h never crosses a
day. `plaid-feed.js:17,30` lookback WINDOW bounds — not display days (add a one-line WHY so a future sweep leaves
them). daterange.js + most of reports.js already local.

**Decision recorded (committee note):** calendar day/month follow the VIEWING device's local zone; a per-business
timezone setting is deferred (fine for the single PST owner; a future out-of-zone bookkeeper would bucket to
their own device zone). One-line WHY comment near `todayLocal`.

**Data/migration/rollback.** None — dates are strings; only default input values + on-screen "today" change; all
were already user-editable. Rollback = revert the swaps.

**Tests (TDD).** `tests/daterange.test.mjs`: `todayLocal(now)`/`monthLocal(now)` with `now` = a UTC instant on a
different local day (e.g. `new Date(2026,6,18,21,30)` — local 9:30pm Jul 18) return the LOCAL Y-M-D/Y-M, and a
guard asserting they differ from `now.toISOString().slice(0,10|7)` for a late-evening local time so a regression
to a UTC slice fails.

---

## Item 2 — Review: distinguish + filter by source (owner: "Filter + clearer chips")

**Committee correction.** The classifier can't be a thin helper: the chip ladder (review.js:336-346) depends on
(a) `suggestFor` THEN nulling `sug` when its account is missing/inactive (:288), (b) folding in the AI suggestion
(:290, `by:'ai'`), (c) `vendorTag = vendorForRow(...)` (:297) and (d) `vendPrefillText` from `aiSug.vendorName`
(:304). And filtering runs in `applyReviewFilter` BEFORE `rowCard` computes any of this — so the filter must
reproduce the SAME resolution or it will classify a row differently from its visible chip.

**Build.**
1. **One pure resolver** → `js/app/lib/review-source.js`:
   `resolveRowSuggestion(row, { vendors, history, accountsById, aiSug })` → `{ sug, vendorTag, vendPrefillText,
   source }` where it performs EXACTLY the row's steps: `suggestFor` → inactive/missing-account null → AI fold →
   `vendorForRow`/`aiSug.vendorName` derivation → `source` ∈ `'client'|'rule'|'ai'|'history'|'vendor-rule'|
   'ai-vendor'|'none'` (client wins on `row.suggestedAt`; then sug.by rule/ai/history; then vendorTag ⇒
   'vendor-rule'; then vendPrefillText ⇒ 'ai-vendor'; else 'none'). Split-suggestion rows ⇒ 'client'. Export
   `SOURCE_META` (icon/label/cls per source) — the ONE definition the chip + filter both read.
2. **`rowCard`** calls the resolver instead of its inline :287-306 + :336-346 ladder (removes duplication) and
   renders the chip from `SOURCE_META` — clearer/consistent: same pill shape, a visible LABEL (not icon-only),
   one colour token per source.
3. **Filter.** Add `source` to `reviewFilter` (:34, default `'all'`), a `select` in `filterBar` (:550-560):
   **All · 💬 Client · ✨ AI · ⚡ Rule · 🕘 Seen before · ◻ No suggestion**. Predicate in `applyReviewFilter`
   (:124-144) calls `resolveRowSuggestion(...).source` — the SAME resolver, so filter ≡ chip by construction.
   'rule' matches rule + vendor-rule; 'ai' matches ai + ai-vendor (the two kinds a user reads as Rule/AI).
   Accept the extra `suggestFor` per row (the same cost `rowReady`/`rowMatchesQuery` already pay); drop the
   plan's earlier "no extra cost" claim. Note: the AI bucket is empty until "Get AI suggestions" has run
   (aiSuggestions is on-demand) — acceptable; the label makes it self-evident.
4. Reset: module state, cleared on unmount (consistent with other filters).

**Tests (TDD).** `tests/review-source.test.mjs`: precedence truth table incl. the two committee-critical cases —
a rule whose account is INACTIVE folds to AI/none (not 'rule'); a client `suggestedAt` row that ALSO rule-matches
⇒ 'client'; vendor-only-rule ⇒ 'vendor-rule'; ai-vendor ⇒ 'ai-vendor'; split ⇒ 'client'. Plus: the filter
predicate over the resolver selects vendor-rule under 'rule' and ai-vendor under 'ai'.

---

## Item 3 — "Save for later" + "Delete" (remembered), multi-select restore — CLIENT-ONLY
(owner: "remembered" delete + "select multiple/all saved-for-later to restore multiple/all")

**Committee-driven redesign — simpler than v1.** Soft-delete = `status:'deleted'`, and:
- **Remembered on BOTH same-id re-sync AND bank re-link, with NO Worker change.** DROP v1's `stagedIndex`
  guard entirely: a `'deleted'` row stays in `byId` (suppresses same-id re-sync — `freshRows`
  plaid-dedup.js:44-53 & Muse `_sync/inbound` business.js:110 both only touch a `pending` existing id) AND stays
  counted in `countByAcct` (suppresses a re-linked new-id twin via the content budget — the exact Honey-8002
  re-link path). This is IDENTICAL to how a skipped row already behaves, so it's consistent, needs no
  plaid-dedup edit, and makes the confirm copy honest. (Accepted tradeoff, same as today's held rows: a later
  GENUINELY-new identical-amount txn on that account could be dedup-suppressed — the same two-$200-ATM ambiguity
  that already exists; and for a "remembered delete" that is arguably the desired behavior.)
- **No stale-guard silent drop, no `updatedAt` stamp.** A skipped→deleted (or skipped→pending restore) is NOT
  covered by the `stagedAdvance` carve-out (pending→X only). Rather than widen the DO guard (a Worker change),
  MIRROR the existing single-restore (review.js:476) and dispatch the status flip WITHOUT an `updatedAt` — the
  guard needs BOTH stamps present to fire, so an unstamped status flip always applies. Keeps item 3 client-only
  and immune to peer clock skew (matches proven existing behavior).

**Build.**
1. **"Save for later"** = current skip relabeled everywhere (action :365, bulk bar, section header "Skipped (N)"
   → "Saved for later (N)", the `pill "Skipped"` :473 → "Saved for later"). Stored status stays `'skipped'` (NO
   migration). Restore stays `{...row, status:'pending'}` (no updatedAt).
2. **"Delete" (remembered, soft)** on a pending row AND a saved row → `dispatch(entity.upsert, {...row,
   status:'deleted'})` (NO updatedAt), confirm-gated ("Delete this transaction? It's removed from Review and
   won't come back when your bank re-sends or re-links it."). Replaces the skipped-section hard `entity.delete`.
   Terminal (no restore; that's Save-for-later). Storage note: deleted rows persist (needed for dedup memory) —
   a future "purge deleted > N months" is deferred.
3. **Exclude `'deleted'` from all USER-FACING lists/counts AND financial totals; KEEP it counted for DEDUP.**
   Audited every `entities('staged')` reader (committee checklist):
   - Review view: a top-level `visibleStaged = entities('staged').filter(s => s.status !== 'deleted')` feeds the
     pending list (:197), the Saved-for-later section (:462), per-bank counts, `rowReady`, bulk, and the
     `history` matchCtx (:212 — harmless, history already needs `approved`, but keep it clean).
   - **`deposits.js:82` `museCardByDay`** — MUST add `if (r.status === 'deleted') continue;` (a deleted Muse card
     sale must not inflate the deposit-reconciliation day total — the one real cross-view FINANCIAL exposure).
   - **`review.js:1186`** rule-apply preview count — exclude `'deleted'`.
   - `plaid-connect.js:66,169,282` post-connect "N imported" counts — exclude `'deleted'` (cosmetic).
   - **KEEP counting `'deleted'` in DEDUP paths** (this is what makes Delete "remembered"): plaid `stagedIndex`
     `countByAcct` (unchanged) AND CSV/OFX re-import dedup `banking.js:350-356` (already dedups against all
     staged incl. deleted — leave it). Confirmed pending-only/safe already: `main.js:433`, `search.js:48`,
     `banking.js:108/133`, `dashboard.js:58`, `client.js:170`, `invoices.js:982`.
4. **Saved-for-later reachable with zero pending (committee bug).** `drawBody` early-returns "All caught up" when
   `pending` is empty (:200) — so after "save everything for later" the section (and its restore-all) is
   unreachable. Gate the early return on pending AND saved AND muse all empty; otherwise render the sections.
5. **Multi-select restore + delete in Saved-for-later.** A DEDICATED `savedSelected` Set (MANDATORY — the pending
   cleanup at :207-208 purges non-pending ids, so reusing `selected` would drop saved rows every redraw). Add a
   parallel cleanup (drop ids no longer `status==='skipped'`), declare at module scope, reset in `unmount`
   (:99). Section gets a checkbox column + "Select all" + "Restore selected (N)" + "Delete selected (N)". Bulk
   restore = `{...row, status:'pending'}` (no updatedAt); bulk delete = soft-delete each.
6. **Bulk on pending** (:566-574): "Skip selected" → "Save selected for later"; add "Delete selected" (soft).

**Data/migration/rollback.** Additive status value `'deleted'` (DO `txnInvariantBreach` gates only `kind:'txn'`,
NOT staged — verified — so no server allow-list change). MIXED-VERSION: a v0.71.10 client filters the pending
list by `status==='pending'` and the skipped section by `status==='skipped'`, so a `'deleted'` row shows in
NEITHER — invisible on old clients too (verified each old-client staged reader). Its ONE old-client exposure is
`deposits.js` (old code lacks the exclusion) — a deleted Muse card row would inflate that old client's deposit
total until it updates; acceptable + transient, and the new client is correct. Rollback = revert the client;
`'deleted'` rows sit inert (no old code writes/reads that value except the deposits sum). NO Worker change ⇒ no
deploy-order constraint.

**Tests (TDD).** Pure where possible: a `savedSelected` cleanup helper if one falls out; the status-flip dispatch
shapes (no updatedAt) are asserted via a small helper or a browser/manual login-gated check. `plaid-dedup` is
UNCHANGED so its tests stay green (and prove deleted rows still dedup). Add a `tests/plaid-dedup.test.mjs`
assertion that a `status:'deleted'` staged row STILL suppresses a same-content re-stage (documents the
"remembered" guarantee we rely on).

---

## Item 4 — Split: per-line vendor + note; reports & IIF attribute per line
(owner: "Full — per-split vendor + note, fix reports & export")

**Committee corrections folded in** (5 musts). Additive per-line `vendorId`/`note`; top-level `txn.vendorId`/
`txn.memo` remain the FALLBACK. Validators tolerate extra line fields; `lineSig` (business.js:40) serializes only
`[accountId, amountCents]` so per-line vendor/note edits on a reconciled txn are metadata (allowed) — verified.

**Build.**
1. **Data.** Category lines may carry optional `{vendorId?, note?}`. Bank line unchanged.
2. **ONE shared attribution** → `js/app/lib/vendor-attribution.js` (pure; the resolution BOTH `txnsForVendor`
   membership AND the amount use — the committee's core fix, they must not diverge):
   - `lineVendorId(line, txn) = line.vendorId || txn.vendorId || null`.
   - `vendorLinesOf(txn, vendorId, expenseIds, { payeeMatch })` → the expense lines to credit this vendor:
     - **Legacy special case (committee blocker):** if the txn has NO vendor anywhere (`!txn.vendorId` AND no
       line has a `vendorId`) and it qualifies for this vendor ONLY by `payeeMatch`, credit ALL its expense
       lines (preserves today's full-amount attribution — otherwise legacy vendor totals silently drop to $0).
     - Else: the expense lines whose `lineVendorId(line,txn) === vendorId`.
   - `txnsForVendor(vendor)` (vendors.js:34): include a posted txn iff `vendorLinesOf(txn, vendor.id, ids,
     {payeeMatch: !txn.vendorId && vendorMatches(vendor, txn.payee)}).length > 0`. A split can appear under
     multiple vendors; each vendor's `expenseOf` sums exactly its own lines, so the cross-vendor sum reconciles to
     the whole-txn expense.
   - `expenseOf(t, expenseIds, vendor, payeeMatch)` (vendors.js:87) → `sum(vendorLinesOf(...).amountCents)`.
3. **Vendor register drill-down (committee must — was double-counting).** `renderVendorRegister` (vendors.js:75)
   drives `register.js`, whose vendor view uses `magnitude(t)` = WHOLE txn (register.js:15,42) → a split under two
   vendors shows full amount under BOTH, and the register total wouldn't match the (now per-line) Vendors table.
   Pass a per-vendor amount resolver into `renderRegister` (an `amtOf` override using `vendorLinesOf`) so the row
   amount, the tfoot total (register.js:139), AND the CSV (register.js:160) show only THIS vendor's lines.
4. **Editor UI — BOTH `categorySplitEditor` AND the `addTxnModal` fork (committee: keep them SEPARATE).** Do NOT
   unify — the add path has a direction-aware `catPred` + live per-line option refresh + editable total the
   factory lacks; unifying is its own risky change. Add per-line vendor + note to each. **Progressive**
   (committee UX): each split line stays `[account, amount, ×]` by default with a small "＋ detail" toggle that
   reveals a vendor combo + note input for that line — keeps the common 2-way split light and fits the modal.
   The top-level Vendor/Memo fields remain (the fallback for any line without its own).
5. **Re-editable splits (committee must).** Today `canSplit` requires a 2-line txn (`isSimple`, ledger.js:468/485)
   so an already-split (3+ line) txn can't reopen the editor → per-line vendors would be one-shot. Extend
   `editTxnModal` to render `categorySplitEditor` seeded from the EXISTING category lines (with their
   `vendorId`/`note`) for a multi-line split, not only the 2-line→N conversion.
6. **`collect()`/Save threading** (categorySplitEditor :444-458 → `cats:[{accountId, amountCents, vendorId?,
   note?}]`; Save mappers ledger.js:531-545 + addModal :664-675). Omit empty per-line fields (fallback applies).
7. **`mergeVendor` (committee must — orphaned line refs).** Broaden the SELECTION filter (merge.js:14) to
   `t.vendorId === fromId || (t.lines||[]).some(l => l.vendorId === fromId)`, rewrite BOTH `t.vendorId` and each
   `l.vendorId === fromId`, and fix the moves-count (vendors.js:166) to match. (Else a line-only vendor ref
   dangles at a deleted vendor and `lineVendorId` never falls back → the line vanishes from all totals.)
8. **IIF export (committee must — no vendor map in scope).** `buildIif` (qb-iif.js:61) has no `vendors` param.
   Add `vendors = []`, build `vendorsById`, thread `entities('vendor')` from the caller (settings.js:349). Each
   SPL line's `NAME = vendorsById.get(lineVendorId(line,txn))?.name || clean(t.payee)`, `MEMO = line.note ||
   clean(t.memo)`. The TRNS header keeps top-level payee/memo. `!VEND` list (:43-51) unaffected. Line order:
   `simpleTxn`/`approveSuggestedSplit` put the bank line at `lines[0]` = TRNS, so SPL rows are the category lines
   as assumed (verified).
9. **Ledger display** (ledger.js:242): a txn with ≥2 distinct line vendors shows "Split — N vendors"; a
   single-vendor txn shows its one badge as today. `txn-inline.js` still edits the top-level `vendorId` (the
   fallback) — per-line editing lives only in the split modal (scope guard).

**Data/migration/rollback.** Additive optional line fields; no signature/idempotency key includes them (`lineSig`
= accountId+amountCents only — verified). Old clients read a per-split txn via the top-level `vendorId` fallback
(whole-txn attribution) + top-level payee/memo in IIF — degraded but never wrong. Rollback = revert client; line
fields sit inert. Reconciled-txn guard unaffected (vendor/note aren't in `lineSig`).

**Tests (TDD).** `tests/vendor-attribution.test.mjs`: `lineVendorId` fallback; `vendorLinesOf` splits a 2-vendor
txn so the sum across vendors == whole-txn expense; a MIXED split (A top-level + B on one line + one untagged)
credits the untagged line to A and reconciles; the **legacy payee-match** txn (no vendorId anywhere) attributes
ALL lines (not $0). `tests/qb-iif.test.mjs`: new `vendors` param; a split emits per-SPL NAME/MEMO from line
vendor/note with payee/memo fallback; existing no-vendors callers still pass. `tests/posting.test.mjs`:
`validateTxn` passes lines carrying `vendorId`/`note`. `tests/merge` (or a pure helper): merge selects+rewrites a
line-only vendor ref.

---

## L3 follow-ups (cheap; fold in)
- **Dedupe orphan rows** (`settings.js drawFailedOps`): collapse orphans whose `op` JSON-serializes identically
  (keep newest `rejectedAt`) so a two-tab race can't be filed to two businesses. Pure `dedupeOrphans(list)` in
  orphan-recovery.js + test.
- **Sync-banner copy** (`main.js renderSyncBanner`): when `failed>0` and EVERY failed entry is an orphan
  (`!e.biz`), show "N held for filing — open Settings → Data & maintenance" instead of "tap Sync now" (syncNow
  won't re-queue an orphan). `emitStatus` passes an `orphan` count alongside `failed`. Small plumbing + copy.
- **Sole-authority routing:** still DEFERRED (needs the unsealed-route telemetry quiet first).

---

## Release + sequencing
One version bump → **0.71.11** (`config.js` + `version.json` + `sw.js` CACHE_NAME) + `changelog.js` (one
plain-English bullet per feature). New client libs (`review-source.js`, `vendor-attribution.js`) MUST be added to
the SW precache (`sw.js`). **CLIENT-ONLY release — no `wrangler deploy`.** BO main-only; `git push` needs owner OK.

**Risk-tiered commit order (committee):** ship the SAFE client-only cosmetics first, the money one last so it
gets the most scrutiny + a live reconciliation check: (1) Item 1 tz, (2) Item 2 review filter, (3) L3 follow-ups,
(4) Item 3 save/delete, (5) **Item 4 split attribution LAST** — separate commit, verified with a live
per-vendor-total reconciliation (cross-vendor sum == whole-txn expense) before the report. If Item 4 proves more
entangled than the plan expects, surface it rather than ship half-verified.
