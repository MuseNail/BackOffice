// ── lib: invoice-ledger-status — is an invoice's revenue recognized in OUR ledger? (pure) ──────
// Pure (no DOM/IO), mirroring posting.js / review-source.js. Answers, per invoice: is the money
// actually recognized in the Back Office ledger (a posted txn crediting an income account, tagged
// to this invoice) — vs merely REPORTED PAID by Invoice2go. It reads existing txns; it writes,
// links, and changes NOTHING.
//
// Recognized income is measured NET: the sum of ALL income-account credits tagged to the invoice
// (the −gross line minus the +passed contra), so a linked figure equals the service revenue and
// never exceeds the invoice total by the passed surcharge. Same math as invoices.js untaggedIncome().
//
// Sign convention (posting.js): debit-positive, so an income credit is a NEGATIVE line amount;
// negating the sum yields positive recognized revenue.

// state → display metadata (the ONE place colour + default wording live; the view reads this so a
// chip and any future filter can never disagree — the review-source.js SOURCE_META pattern).
export const LEDGER_STATES = {
  'linked-full':    { cls: 'green', short: '✓ In your books',  title: 'In your Back Office books' },
  'linked-partial': { cls: 'blue',  short: 'Partly linked',    title: 'Partly in your Back Office books' },
  'pre-books':      { cls: 'gray',  short: 'Before your books', title: 'Predates your Back Office books — income isn’t tracked here' },
  'unlinked':       { cls: 'amber', short: 'Not linked',       title: 'Reported paid — not linked to a ledger entry' },
  'unpaid':         { cls: '',      short: '',                 title: '' },
};

// NET income (cents) on one txn's lines: sum of income-account credits (debit-positive → negate).
// The ONE definition of the sign convention, shared by both the per-invoice and by-invoice sums so
// the detail badge and the list dot can never drift apart.
export function txnIncomeCredits(txn, incomeIds) {
  let cents = 0;
  for (const l of (txn.lines || [])) if (incomeIds.has(l.accountId)) cents -= l.amountCents;
  return cents;
}

// NET income (cents) recognized in the ledger and tagged to invoiceId. POSTED txns only —
// "recognized" deliberately excludes staged/void rows (a staged Review deposit is not yet in the
// ledger), which is why this can differ from the all-status Collected KPI on the same screen. May
// be negative if a later refund debits income — callers treat rec <= 0 as "not recognized".
export function incomeCreditsFor(txns, invoiceId, incomeIds) {
  let cents = 0;
  for (const t of txns) {
    if (!t || t.status !== 'posted' || t.invoiceId !== invoiceId) continue;
    cents += txnIncomeCredits(t, incomeIds);
  }
  return cents;
}

// Same NET recognized income, tallied for EVERY invoice in a single O(txns) pass — for the invoice
// list (1,600+ rows), where calling incomeCreditsFor per row would be O(invoices×txns). Only
// invoices with a nonzero net are keyed (a zero net reads the same as "none"). Uses the same
// posted-only + txnIncomeCredits math as incomeCreditsFor, so the two agree per invoice.
export function incomeCreditsByInvoice(txns, incomeIds) {
  const byInv = new Map();
  for (const t of txns) {
    if (!t || t.status !== 'posted' || !t.invoiceId) continue;
    const c = txnIncomeCredits(t, incomeIds);
    if (c) byInv.set(t.invoiceId, (byInv.get(t.invoiceId) || 0) + c);
  }
  // Drop invoices whose per-txn credits summed back to exactly zero (e.g. a full refund).
  for (const [id, c] of byInv) if (c === 0) byInv.delete(id);
  return byInv;
}

// Earliest date the Back Office ledger recognizes ANY income — the boundary between "before your
// books" (older, income lives in your prior/QuickBooks records) and "in your books". Derived so it
// self-adjusts; garbage-floored at 2000-01-01 so one bad import row can't collapse the boundary.
// null when the ledger has no income at all.
export function ledgerIncomeStart(txns, incomeIds) {
  let min = null;
  for (const t of txns) {
    if (!t || t.status !== 'posted') continue;
    const d = t.date;
    if (!d || d < '2000-01-01') continue;
    if (!(t.lines || []).some(l => incomeIds.has(l.accountId))) continue;
    if (min === null || d < min) min = d;
  }
  return min;
}

// Classify one invoice. ctx: { txns, incomeIds:Set, incomeStart:string|null }.
// → { state, recognizedCents }. Scans txns once for THIS invoice — use ledgerStateFor for the list
// view, where a single O(txns) precompute of recognized-per-invoice avoids O(invoices×txns).
export function classifyInvoiceLedger(inv, { txns, incomeIds, incomeStart } = {}) {
  return ledgerStateFor(inv, incomeCreditsFor(txns || [], inv.id, incomeIds), incomeStart);
}

// The decision, given an ALREADY-computed net recognized total. Recognized income is weighed FIRST
// so an invoice with income tagged is never hidden as "unpaid" (e.g. Invoice2go reports $0 paid yet
// the ledger holds income for it).
export function ledgerStateFor(inv, rec, incomeStart) {
  const paid = inv.paidCents | 0;
  if (rec > 0) {
    // "fully" = recognized meets the paid amount within a small tolerance ($2 or 2%); more
    // recognized than paid still reads full (the income is genuinely there).
    const tol = Math.max(200, Math.round(paid * 0.02));
    const state = (paid <= 0 || rec >= paid - tol) ? 'linked-full' : 'linked-partial';
    return { state, recognizedCents: rec };
  }
  if (paid <= 0) return { state: 'unpaid', recognizedCents: 0 };
  const paidWhen = inv.datePaid || inv.date || '';
  if (incomeStart && paidWhen && paidWhen < incomeStart) return { state: 'pre-books', recognizedCents: 0 };
  return { state: 'unlinked', recognizedCents: 0 };
}
