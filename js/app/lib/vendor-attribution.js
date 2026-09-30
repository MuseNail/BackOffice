// ── lib: vendor-attribution — credit a txn's expense to its vendor(s) (pure) ────
// v0.71.11 splits can carry a per-line vendorId (and note). Vendor reporting must attribute
// each expense line to its own vendor, falling back to the txn-level vendorId — and a legacy
// txn matched only by payee (no vendor tag anywhere) must still attribute its WHOLE expense,
// never silently drop to $0. ONE resolution so txnsForVendor membership and the amount agree.
// No DOM/IO ⇒ testable.

// The vendor a line is credited to: its own, else the transaction's, else none.
export function lineVendorId(line, txn) {
  return (line && line.vendorId) || (txn && txn.vendorId) || null;
}

// Does this txn reference `vendorId` at the top level OR on any line?
export function txnHasVendor(txn, vendorId) {
  if (!txn) return false;
  if (txn.vendorId === vendorId) return true;
  return (txn.lines || []).some(l => l && l.vendorId === vendorId);
}

// Does this txn carry ANY vendor tag (top-level or on a line)?
export function hasAnyVendor(txn) {
  return !!(txn && (txn.vendorId || (txn.lines || []).some(l => l && l.vendorId)));
}

const EMPTY = new Set();
// The category LINES of `txn` credited to `vendorId`. `expenseIds` / `incomeIds` = Sets of expense-
// and income-type account ids.
//   • EXPENSE line: `payeeMatch` (a legacy untagged txn matched only by payee) attributes ALL expense
//     lines — the pre-per-line total; otherwise the line is credited by lineVendorId (line → txn
//     fallback). payeeMatch applies only when the txn has NO vendor tag anywhere.
//   • INCOME line: credited ONLY by its OWN explicit `line.vendorId` — never the txn-level fallback,
//     never payeeMatch. This is deliberate: it keeps existing deposits that carry only a txn-level
//     vendor (e.g. a "Square" card deposit) from retroactively netting their gross income into a vendor.
export function vendorLinesOf(txn, vendorId, expenseIds, incomeIds = EMPTY, { payeeMatch = false } = {}) {
  const out = [];
  const legacyAllExpense = payeeMatch && !hasAnyVendor(txn);
  for (const l of (txn?.lines || [])) {
    if (!l) continue;
    if (expenseIds && expenseIds.has(l.accountId)) {
      if (legacyAllExpense || lineVendorId(l, txn) === vendorId) out.push(l);
    } else if (incomeIds && incomeIds.has(l.accountId)) {
      if (l.vendorId === vendorId) out.push(l);   // explicit line tag only
    }
  }
  return out;
}

// NET activity (cents, debit-positive) credited to `vendorId`: expenses add, income (a credit, so a
// negative amount) nets down — a vendor's total is money-paid − money-received.
export function activityForVendor(txn, vendorId, expenseIds, incomeIds, opts) {
  return vendorLinesOf(txn, vendorId, expenseIds, incomeIds, opts).reduce((s, l) => s + l.amountCents, 0);
}

// Rewrite every reference to `fromId` — top-level AND per-line — onto `toId`, for a vendor
// merge. A line-only vendor tag must be rewritten too, or it dangles at the deleted vendor.
export function remapVendor(txn, fromId, toId) {
  return {
    ...txn,
    vendorId: txn.vendorId === fromId ? toId : txn.vendorId,
    lines: (txn.lines || []).map(l => (l && l.vendorId === fromId) ? { ...l, vendorId: toId } : l),
  };
}
