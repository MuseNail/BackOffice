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

## Build order
1. Worker `card-batches` endpoint (best-guess) + `lib/processor-match` batch helpers + tests.
2. New Deposits view: per-day Muse-vs-Helcim comparison (uses transactions + staged/ledger Muse), surcharge-aware Δ, flags. Read-only.
3. Deposit matching: deposits ↔ batches/days, fee, one-click post.
4. Flags panel + clearing-balance trend + day drill-down.
5. Live-verify the batches endpoint shape; tighten the exact-match path.

## Open external dependency
- The **`card-batches` response shape** can't be confirmed without a live Helcim token. Build defensively against the documented shape; owner verifies on the live terminal (and shares the JSON) before phase 3's exact match is relied on. Until verified, deposit matching uses the existing window matcher.
