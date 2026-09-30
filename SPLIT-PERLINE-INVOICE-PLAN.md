# Plan — Full per-line splits (client + owner) + per-line income→invoice AND income→vendor

Status: REVISED v3 (fixed the vendor back-compat blocker from review round 2) → owner sign-off. No app code yet.
Repo: `backoffice` (main-only). Feature memory: `[[project-bo-split-perline-invoice]]`.

---

## 0. Review history
- Round 1 (invoice engine): verified §4.1 correct; fixed deploy order, reconcile-clobber targeting, per-line-invoice chips, one-tap validation, typed-new-vendor carry, redraw re-seed.
- Round 2 (vendor delta): **found a BLOCKER** — the "existing vendor totals unchanged" claim was false (income would net via the txn-level vendor fallback and via payeeMatch on already-tagged/rule-matched deposits). Fixed below: **income→vendor counts via an explicit per-line `line.vendorId` only**; payeeMatch stays expense-only; a pre-ship audit quantifies the one residual shift. Also: client/owner per-line vendor must be a **freeText** combobox with a live handle; clear the whole-txn vendor/invoice on split toggle; relabel the vendor **register** ("Spent") + CSV, not just the table; don't mis-color the net.

## 1. Goal
**Plain English.** Split a bank charge — credit or debit — into lines, each with its own **account, amount, vendor, invoice, and note**, on the **client Suggest screen** and the **owner Review screen**. One deposit can pay several invoices (the books track which invoice each piece belongs to); a credit can be split across vendors (each vendor's report counts that income, **net**). Existing posted data reads the same.

**Technical.** Engine 1: income→invoice per-line (`lineInvoiceId` fallback). Engine 2: income→vendor NET via **explicit per-line `line.vendorId` only**. Plus the full per-line split data path (client + owner), a wider DO `/_suggest` whitelist (deploy **first**), approve paths that find-or-create per-line vendors, and guards so no txn-level write clobbers a per-line-tagged deposit.

## 2. Owner-confirmed decisions
Client Suggest + owner Review. Per line: account + amount + vendor + invoice + note, both directions. Vendor per-line both sides. Money-in reported per vendor, **NET** (A). Income→invoice per-line (one deposit → many invoices). B1 posted Ledger correct (safety touches only). B2 defer reconcile multi-invoice write. B3 caps 500/120/120. B4 account-first + money-in labeling.

## 3. Background — the two asymmetries
- **Invoice:** `lineInvoiceId` (posting.js:115) is used for expenses only; income recognition is txn-level (invoice-ledger-status.js:37-59), feeding the list dot (invoices.js:844/852) + detail card (:1175). Invariant `byInvoice ≡ For` (test :172-184); NET; zero-drop.
- **Vendor:** `lineVendorId` (vendor-attribution.js:9) = `line.vendorId ?? txn.vendorId`. `vendorLinesOf` (:30-34) filters to `expenseIds` (EXPENSE_TYPES, vendors.js:96). Vendor table/register show "Total paid"/"Spent" = expense lines only. **Income never counts today.** ⚠️ The fallback and the `payeeMatch` branch are exactly why naively counting income would shift existing numbers (round-2 blocker).

## 4. Design

### 4.1 Engine 1 — per-line income→invoice recognition (`invoice-ledger-status.js`) — verified correct (round 1)
```js
import { lineInvoiceId } from './posting.js';
export function incomeCreditsFor(txns, invoiceId, incomeIds) { let c = 0;
  for (const t of txns) { if (!t || t.status !== 'posted') continue;
    for (const l of (t.lines||[])) if (incomeIds.has(l.accountId) && lineInvoiceId(l,t) === invoiceId) c -= l.amountCents; } return c; }
export function incomeCreditsByInvoice(txns, incomeIds) { const m = new Map();
  for (const t of txns) { if (!t || t.status !== 'posted') continue;
    for (const l of (t.lines||[])) { if (!incomeIds.has(l.accountId)) continue; const inv = lineInvoiceId(l,t); if (!inv) continue;
      m.set(inv, (m.get(inv)||0) - l.amountCents); } }
  for (const [k,v] of m) if (v===0) m.delete(k); return m; }
```
Untagged income falls back to `t.invoiceId` → existing data identical, no migration. Retire `txnIncomeCredits`. Drop the old txn-level gates.

### 4.2 Engine 2 — per-line income→vendor attribution, NET (explicit-line-only) — **fixed**
**Rule:** an income line counts toward a vendor **only when it carries its own explicit `line.vendorId`** — never the txn-level fallback, never payeeMatch. Expense attribution is unchanged. This is what keeps existing totals from moving.
- `vendor-attribution.js` — new signature `vendorLinesOf(txn, vendorId, expenseIds, incomeIds, { payeeMatch = false })`:
  - **expense line** (`expenseIds.has`): `(payeeMatch && !hasAnyVendor(txn))` → include; else `lineVendorId(l,txn) === vendorId`.
  - **income line** (`incomeIds.has`): include **only** when `l.vendorId === vendorId` (explicit; no fallback; no payeeMatch).
  `expenseForVendor`→`activityForVendor` sums signed → NET (income credit is negative → reduces the total). Keep the old export name as an alias if a test imports it. `lineVendorId`/`txnHasVendor`/`hasAnyVendor`/`remapVendor` unchanged (merge.js/qb-iif unaffected; verified sole consumers are vendors.js).
- **Writers** put the vendor on the income **line**: the split UI + both approve paths (§4.4-4.5) write `line.vendorId`, so a split credit nets. (A NON-split single-vendor credit stays txn-level and does NOT net unless we also write the income line — see §10 open decision.)
- `views/vendors.js` — build BOTH sets (`expenseIds`, `incomeIds`) at :81/:114/:139; relabel column **"Total paid"→"Net"** (:124), drilldown **"paid"→"net"** (:161); extend `catOf` (:140) to the first income-or-expense line; update blurb (:55). **Keep the amount uncolored** (`colored:false` stays at :129/:165) — `acctAmount`'s red/green (ui.js:184) reads *inverted* for a vendor net, so the minus sign conveys "net received" without mis-coloring; the drilldown header total stays `fmtMoney` (shows the minus).
- `register.js` — the full vendor register/CSV headers say **"Spent"** (:137/:161/:163) and would show negatives; relabel to **"Net"** for the vendor route (it has no `focusAccountId`), keep uncolored.

### 4.3 Shared pure split builder — in `posting.js`
```js
// buildSplitCatLines({ lines, isExpense, fallbackInvoiceId }) -> { catLines, txnInvoiceId }
//   lines: [{ accountId, amountCents(+magnitude), invoiceId?, vendorId?(resolved by caller), note? }]
//   signs each line; keeps vendorId+invoiceId+note; touches ONLY invoiceId on collapse (resolveSplitInvoiceTags) — leaves vendor/note intact.
```
Both approve paths call it; unit-tested.

### 4.4 Owner Review (`review.js`)
- **splitModal gate (:1021):** `perLine = true` — per-line vendor + invoice + note on **both** directions (invoice still sub-gated by `useInv`). Caption (:1106) reworded. **The per-line vendor cell must be a freeText combobox carrying `inputText`** (mirror the single Review row's `vendorSelect` :351/:379, NOT the id-only `vendorCombo` — which can't seed or carry a client's typed-new vendor NAME), resolved via `findOrCreateVendor` on Post.
- **approveSuggestedSplit (:689-717):** per line resolve `vendorId = l.vendorId || findOrCreateVendor(l.vendorName)` and set it on the income/expense line; build via `buildSplitCatLines`; set `txn.invoiceId` on collapse; **do NOT set a txn.vendorId fallback for splits** (per-line only — avoids blanket-attributing untagged lines). Validate per-line invoiceIds against live invoices; gate one-tap `canApprove` (:272) on per-line invoiceId **and** vendorId resolving (else → Review split). Preserve balance/inactive (:694-703) + bankish/transfer (:699-701) refusals.
- **Seeded splitModal (makeLine :1023, seed :1055-1059):** prefill each line's vendor (id **or** typed name), invoice, note from the client's lines; Post resolves typed names via `findOrCreateVendor`.
- **splitSuggestionCard (:261-297):** show each line's vendor + invoice + note.

### 4.5 Client Suggest (`client.js`)
- **draftFor (:74-90):** seed each split line's `vendorId`/`vendorName`/`invoiceId`/`note`.
- **splitBlock (:340-369) + call (:276):** thread `vendors` + `invs` + `showInvoices` in (mirror `suggestRowFull`'s args). Two-row line: account+amount+remove / **freeText vendor combo** + invoice combo (when `showInvoices`, read-only) + note. **Keep a live per-line `l._venSel` handle** (like `l._sel` for account) and read `l._venSel.value/.inputText` in `splitPayload` — a freeText box only commits typed text on blur, so a still-focused typed-new vendor would send truncated ("perso") without the live read. **Re-seed every field's `value` on each `renderLines` rebuild.** Add new keys to the pushed line (:364) and the toggle reset (:278).
- **Split toggle (:278) + payload split branch (:305):** **CLEAR `suggestedVendorId`/`suggestedVendorName`/`suggestedInvoiceId`** (as :305 already does for account) so a whole-txn vendor picked before toggling Split can't leak in and blanket-attribute lines. Hide the whole-txn vendor + invoice fields in split mode (per-line now); keep the whole-txn note.
- **splitPayload (:169-178):** per line emit `vendorId` **or** `vendorName`, `invoiceId` (when `usesInvoices()`), `note`.

### 4.6 Server (`cloudflare/src/do/business.js`) — deploy **FIRST** (§7)
`/_suggest` split-line whitelist (:143-149): additionally keep per line `note` (≤500), `invoiceId` (String ≤120), `vendorId` (String), `vendorName` (String ≤120, cleared when `vendorId` set — mirror :157). No server-side existence check / no type gate (the DO has no account-type context — confirmed). Monotonic `updatedAt` (:168) untouched.

### 4.7 Guard every txn-level income→invoice / income→vendor WRITE surface (REQUIRED)
Predicate *"txn has a per-line income tag"* = `(t.lines||[]).some(l => (l.invoiceId||l.vendorId) && accountsById.get(l.accountId)?.type === 'income')`.
- **Reconcile "other income" (invoices.js:998 descriptor, :1041 filter):** exclude any deposit with a per-line income tag.
- **postDeposit else-branch (:1063) + postHighConf (:1084):** refuse `{...t, invoiceId}` on such a txn.
- **Inline `invoiceField` editor (txn-inline.js:122-130; register.js:99, ledger.js:241):** suppress/annotate for income deposits carrying per-line invoice tags.
- **Inline `vendorField` editor (txn-inline.js:113-119; register.js:97):** same treatment — a split deposit's real per-line vendors aren't shown by the txn-level field; show a per-line summary (mirror ledger.js:248-251 "Split — N vendors") and suppress/annotate the picker so the owner can't stamp a txn-level vendor over a split. (Lower mis-net risk now that income ignores txn-level vendor, but still a display/UX trap.)
- **confirmDeleteInvoice (:743):** per-line-aware + reword to "transactions are tagged to this invoice."
- **NOT changed (i2g-only):** untaggedIncome + linkOne/linkHighConf/auto-link; AI/1:1 auto-link stay single-invoice (the guards stop them clobbering a split).

### 4.8 Show per-line invoices + vendors on posted deposits (REQUIRED — visible deliverable)
`register.js` invoice pill is at **:85/:89** (read) with the inline editor at **:99**; `ledger.js:244/253`. Derive invoice pills from the distinct `lineInvoiceId` values across income lines (multiple chips), and show a per-line vendor summary in the register (ledger.js:248-251 already does). qb-iif (:94) now exports a per-line vendor NAME on income lines too — **intended** (vendor-refund attribution); note QB's list-type caveat (no !VEND/!CUST typing).

## 5. Scope decisions (settled)
B1 Ledger safety/display only. B2 defer reconcile multi-invoice write. B3 caps 500/120/120. B4 account-first + money-in labeling. Vendor report = NET (A).

## 6. Safety analyses
- **Contra-income (invoice):** only i2g-cashflow imports carry a passed-fee contra; mixed-sign → `splitParts` canSplit=false → never splittable; existing data correct via fallback. Test-pinned.
- **Vendor NET back-compat (fixed):** because income attributes via **explicit `line.vendorId` only** (not txn fallback, not payeeMatch), existing vendor totals are unchanged **except** posted income lines that already carry an explicit `line.vendorId` — which the **ledger split editor has written since v0.71.11** (ledger.js:474, no direction gate). §7 audit enumerates them; treat any hits as a reviewed reporting change, not "no change."
- **payeeMatch** is expense-only unconditionally.

## 7. Data safety, DEPLOY ORDER, rollback, pre-ship audit
- **Migration: none.** Additive per-line fields; fallback keeps old invoice data; vendor totals unchanged except the audited set.
- **PRE-SHIP LIVE AUDIT (gate, run before deploy — read-owner-browser technique):** over posted txns, flag any with an **income-type line carrying an explicit `line.vendorId`** (the only rows whose vendor Net changes), and any with an income line + txn-level vendorId or payee-match (to confirm the explicit-only rule keeps them at $0). Show the owner the per-vendor before/after delta. Zero ⇒ safe; non-zero ⇒ review each.
- **Deploy order (CRITICAL):** **(1) `wrangler deploy` the widened `/_suggest` whitelist FIRST**, verify live; **(2) then bump + push Pages.** Pages-first would let the old Worker strip per-line vendor/invoice/note.
- **Rollback:** revert Pages + redeploy prior Worker. During a rollback window, **do NOT one-click re-link resurfaced multi-invoice deposits** (leave untagged — account-level P&L unaffected).
- **Behavioral change to verify:** per-invoice income drops to each line's share (a shared deposit may read "partly linked"); vendor Net shifts only for the audited income-line-vendor rows.

## 8. Test plan (TDD; Windows: `node --test-force-exit --test tests/<file>.test.mjs` per file)
- **posting.test.mjs:** `buildSplitCatLines` (signs; keeps vendor/invoice/note both directions; collapse touches invoice only); `validateTxn` accepts per-line invoiceId+vendorId+note on a credit line.
- **invoice-ledger-status.test.mjs (keep 27 + invariant):** per-line income to different invoices; per-line overrides txn-level per line; fallback identical; multi-invoice + per-line contra nets gross−passed; partially-tagged; full-refund net-zero drop; `byInvoice ≡ For`.
- **vendor-attribution.test.mjs:** income line with explicit `line.vendorId` → `activityForVendor` nets (negative for a pure refund); **a txn-level-vendor income txn with NO per-line vendor does NOT change** (the blocker regression pin); **payeeMatch never pulls income** (expense-only); mixed expense+income to one vendor nets; back-compat expense totals identical; `remapVendor`/`txnHasVendor` unchanged.
- **Reconcile guard:** the per-line-income-tag predicate excludes a tagged deposit + blocks the write.
- **Worker `/_suggest`:** integration/live round-trip of per-line vendor/invoice/note (highest unproven leg).
- **Regression:** reports.js P&L/Balance/tax/`collectedCents` unaffected; qb-iif SPL MEMO/NAME still per-line.

## 9. Build & ship order
1. `posting.js` builder + tests. 2. `invoice-ledger-status.js` + tests. 3. `vendor-attribution.js` (explicit-income rule, payeeMatch expense-only) + `views/vendors.js` + `register.js` relabel + tests → suite green. 4. `review.js` (splitModal perLine=true + freeText per-line vendor, approveSuggestedSplit per-line vendor find-or-create + invoice validation + no txn vendor fallback, seeded splitModal, card) via the builder. 5. `client.js` (draft/splitBlock two-row freeText vendor + `_venSel` + clear-on-toggle/splitPayload). 6. `business.js` `/_suggest` whitelist. 7. `invoices.js` §4.7 guards + `txn-inline.js`/`register.js`/`ledger.js` invoiceField + vendorField suppression/summary. 8. §4.8 chips/summaries. 9. Version bump trio + changelog. **Run the §7 audit. Deploy Worker FIRST, verify, then push Pages.**

## 10. Open questions (sign-off)
1. **Single-vendor credit netting:** a *split* credit nets per line (the feature). Should a **non-split** money-in transaction tagged to one vendor also net? If yes, the single money-in approval writes the vendor to the income line (small add) — recommend **yes** so a whole refund from one vendor nets. If no, netting is split-only.
2. **Pre-ship audit (§7):** I'll run it and show you which vendors (if any) move before we deploy — expecting near-zero given you rarely vendor-tag income splits today.
3. Confirm the full revised scope.
