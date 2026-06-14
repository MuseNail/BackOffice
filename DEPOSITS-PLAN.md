# Deposits & 3-way reconciliation — locked plan (2026-06-13)

A dedicated **Deposits** tab that proves, for any date range, that **what Muse
recorded** = **what Helcim processed** = **what hit the bank**, and flags any day
or deposit where they don't.

## Locked decisions
1. **Add the Helcim `card-batches` API** for exact settlement matching (not fee-inference).
2. **New "Deposits" tab, build it all** (comparison + deposit matching + flags + clearing trend).
3. **"Muse recorded" = approved + not-yet-approved** staged sync rows (pending rows marked, fall back to posted clearing numbers once approved).
4. **Fee/surcharge pulled directly from Helcim** — no configured rate. `fee = batch gross − batch net`.

## Why it's not "compare 3 numbers" (do not overlook)
- **Fee Saver:** customer pays **bill + surcharge**. Muse records the **bill**; Helcim transaction `amount` = **bill + surcharge**; bank deposit ≈ **bill** (Helcim keeps the surcharge as its fee). A correct day = Helcim ≈ Muse + surcharge, deposit ≈ Muse.
- **Timing/batching:** deposits land 1–4 business days later; weekends batch into one deposit. `matchDeposit` already does 1–3 day windows, lookback 6.
- **Gift cards ride the card:** card money/day = **`sales_card` + `gift_sold`** (gift books to a liability, but the money is in the card deposit).
- **Tips:** `sales_card` already includes tips (memo notes the total) — rides through consistently.
- **Refund timing:** a refund can post in Muse a different day than Helcim processes it (cross-batch).
- **Timezones:** Helcim = Mountain Time; Muse = salon local; bank = its own. Window search absorbs ±1 day.

## Data sources (verified shapes)
| Source | Where | Per-day number |
|---|---|---|
| Muse recorded | staged sync rows + clearing-account debits (`sales_card`+`gift_sold`) | the bill (incl. tips), `pending` until approved |
| Helcim processed | `GET /v2/card-transactions` (have it: `helcimDayTotals`) | gross = bill + surcharge; APPROVED only, refunds subtract |
| Helcim settled (NEW) | `GET /v2/card-batches` (+ `/{id}`) | net payout per batch = what the bank receives |
| Bank deposit | imported bank rows / posted deposit txns | the payout; match by batch (exact) or window |

Muse push payload (musedashboard `features/backoffice-sync.js`): daily rows
`sales_cash/sales_card/sales_zelle/sales_other/gift_sold/gift_redeemed`, cents,
`sourceId=<date>:<type>`. Card-relevant = `sales_card` + `gift_sold`.

Helcim card-transaction object: `{ transactionId, dateCreated (MT), type
(purchase|refund), amount ($, = bill+surcharge), status (APPROVED|…),
invoiceNumber, customerCode, cardBatchId }`. `cardBatchId` ties a txn to its
settlement batch — the join key for exact deposit matching.

## Reconciliation model (two comparisons)
- **A. Sales accuracy (same day): Muse vs Helcim.** `Helcim gross − Muse card` should ≈ surcharge. The expected surcharge is learned from batch (gross−net); outside band → flag.
- **B. Settlement: vs Bank.** `Bank deposit` = Helcim **batch net** (exact, via `cardBatchId`) ≈ Muse card for the covered day(s). Fall back to the window matcher when batch data isn't available.

## UI (new Deposits tab)
- Date-range picker.
- **Per-day table:** Date · Muse card (pending?/posted) · Helcim gross · Δ vs surcharge · Deposit · Status.
- **Deposits list:** each bank deposit → batch, day(s) covered, fee (gross−net), one-click **Post** (reuse `matchDeposit` + posting).
- **Clearing-account balance trend** (should trend to $0).
- **Drill-down:** day → individual Helcim txns + Muse breakdown.

## Flags (the "nothing overlooked" alerts)
- Muse vs Helcim off by more than the surcharge band → missed/extra sale or refund mismatch
- Helcim activity but no Muse sale → not recorded in Muse
- Muse sale but no Helcim activity → recorded but never charged
- Bank deposit no day explains → unmatched deposit
- Sales older than N days, no deposit → missing payout
- Fee % outside expected range → pricing/processor issue
- Gift-card & refund lines called out so they don't look like discrepancies

## Worker changes
- **NEW** `GET /b/:biz/processor/helcim/batches` (+ optional `/batches/:id`) mirroring the transactions route (`HELCIM_API_TOKEN`, 501 if unset). ⚠️ **Best-guess `card-batches` response shape — must be verified on the live token** (same way the transactions route was), before the exact-match path is trusted.
- Reuse the transactions route. Needs `HELCIM_API_TOKEN` on the BO worker.

## Build order / status
1. ✅ **DONE (commit `4ffd67c`, committed NOT pushed):** Worker `GET /b/:biz/processor/helcim/batches` (`routes/processors.js` `handleHelcimBatches` + wired in `index.js`) + `lib/processor-match` helpers `helcimBatchTotals(txns, batches)` and `matchDepositToBatch(deposit, batchTotals, {lookbackDays:4, feeCapPct:6})` + 6/6 tests (`tests/processor-match.test.mjs`). **Worker route NOT deployed yet** (the live BO worker has the token + taxsetting but not this route); `git push` pending.
2. ✅ **DONE — Phase 2 (read-only Deposits tab).** New view `js/app/views/deposits.js` + nav item (`index.html` sidebar, between Reconcile & Inventory) + router entry (`js/app/main.js` import + VIEWS). Date-range picker (defaults to last 14 days). Per-DAY table: Date · Muse recorded (`sales_card`+`gift_sold` summed from the synced **staged** rows — pending OR approved, since approved rows keep their `syncType`/amount; a "pending" pill shows when any contributing row is unapproved) · Helcim gross (`/processor/helcim/transactions` → `helcimDayTotals`, tolerates bare-array OR `{value:[]}`) · Δ surcharge (Helcim−Muse) · Status pill. **Surcharge learned from the data** (median Helcim-over-Muse ratio on days with both sides — no configured rate); flags: No-Helcim-activity (amber), Not-in-Muse (red), Helcim-under-Muse (red), Surcharge-off-band (amber, ±$1 or 1%). KPIs: total Muse, total Helcim, typical surcharge %, days flagged. Owner/manager gated (`roleFor`). Pure comparison extracted to `js/app/lib/deposits-compare.js` (`summarizeDeposits`) + `tests/deposits.test.mjs` (4 tests; **42/42 suite green**). Boot-verified in preview, no console errors. **NOTHING writes — matching/posting is Phase 3.**
3. Deposit matching: deposits (bank rows) ↔ batches via `helcimBatchTotals` + `matchDepositToBatch`; show fee (gross−net); one-click post (reuse the existing posting from `review.js` matchDepositModal). Use `invoiceNumber` (`tkt-<id>-<cents>`) for per-ticket drill-down.
4. Flags panel + clearing-account balance trend + day/batch drill-down.

**Before Phase 3 deposit-matching is trusted live:** `wrangler deploy` the BO worker (for the batches route) — the token is already set.

## Open external dependency — RESOLVED 2026-06-13 (live token verified)
The `card-batches` shape is now confirmed (real responses pulled). External dep closed.

## Verified Helcim API findings (2026-06-13) — CORRECTS decision #4
- `GET /v2/card-batches` and `/v2/card-batches/{id}` return **metadata only**:
  `{ id, dateCreated, dateUpdated, dateClosed, closed, terminalId, batchNumber }`,
  wrapped `{ "value": [...], "Count": N }`. **No net/gross/fee amounts.** Batches
  close ~daily (~5pm MT); `dateClosed` ≈ settlement; **one batch ≈ one business day**.
- `GET /v2/card-transactions?cardBatchId=<id>` → the batch's transactions:
  `{ transactionId, dateCreated, cardBatchId, status (APPROVED|DECLINED),
  type (purchase|refund), amount ($), cardType, invoiceNumber, customerCode,
  approvalCode, cardToken, cardNumber }`. **DECLINED rows appear — filter to APPROVED.**
- **Revised decision #4 (Helcim does NOT expose net):**
  - **batch gross** = Σ APPROVED `amount` grouped by `cardBatchId`.
  - **net** = the **matched bank deposit** (not from the API).
  - **fee = batch gross − bank deposit**, exact once matched.
  - The batch's value = the EXACT settlement grouping + `dateClosed` (beats day-window guessing). Match deposit ↔ batch by amount≈gross (within fee band) + deposit date ≈ `dateClosed` + 1–2 days.
- **Bonus:** `invoiceNumber` = Muse's `tkt-<id>-<cents>` → individual Helcim txns join straight back to Muse tickets (per-ticket drill-down/reconcile).
- **Worker:** `GET /processor/helcim/batches` proxies the list (for `dateClosed` per batch). Gross-per-batch comes from grouping the existing transactions feed by `cardBatchId` — no per-batch detail call needed. `HELCIM_API_TOKEN` is now set + deployed on the BO worker.
