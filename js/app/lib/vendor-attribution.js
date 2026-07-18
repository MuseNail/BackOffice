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

// The expense LINES of `txn` credited to `vendorId`. `expenseIds` = Set of expense-type
// account ids. `payeeMatch`: the caller included this txn for the vendor ONLY via a payee
// match — a legacy untagged txn — so attribute ALL its expense lines (preserve the pre-
// per-line-vendor total). The payee-match branch applies only when the txn has NO vendor
// tag anywhere; a txn that DOES carry a vendor is always attributed by the tag.
export function vendorLinesOf(txn, vendorId, expenseIds, { payeeMatch = false } = {}) {
  const lines = (txn?.lines || []).filter(l => l && expenseIds.has(l.accountId));
  if (payeeMatch && !hasAnyVendor(txn)) return lines;
  return lines.filter(l => lineVendorId(l, txn) === vendorId);
}

// Total expense (cents) credited to `vendorId`.
export function expenseForVendor(txn, vendorId, expenseIds, opts) {
  return vendorLinesOf(txn, vendorId, expenseIds, opts).reduce((s, l) => s + l.amountCents, 0);
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
