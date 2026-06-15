// ── lib: invoice2go-posting — turn an invoice payment into a ledger txn ─────────
// Pure (no DOM/IO). Cash-basis: each succeeded payment posts income through a
// clearing account so the bank deposit can later relieve it (reconciliation),
// with the processing/surcharge fee booked as an expense.
//
// Sign convention (posting.js, debit-positive): income credited (−), the
// clearing asset and the fee expense debited (+). Lines sum to 0:
//   income  −amount
//   clearing +(amount − fee)
//   fee      +fee            (only when fee > 0)
//
// The txn id is derived from the payment's transaction_id so re-posting after a
// weekly re-import is idempotent — an already-posted payment is skipped.

export const paymentTxnId = (txId) => 'i2gp-' + txId;

// mapping: { incomeId, clearingId, feeId }. Returns a txn object, or null when
// the payment can't/shouldn't post (not succeeded, no id, zero amount, or a fee
// with no fee account mapped).
export function buildPaymentTxn({ invoice, payment, mapping }) {
  if (!payment || payment.status !== 'succeeded') return null;
  if (!payment.txId || !payment.date) return null;
  const amount = payment.amountCents | 0;
  if (amount <= 0) return null;
  const fee = Math.max(0, payment.feeCents | 0);
  if (!mapping?.incomeId || !mapping?.clearingId) return null;
  if (fee > 0 && !mapping.feeId) return null;

  const lines = [
    { accountId: mapping.incomeId, amountCents: -amount },
    { accountId: mapping.clearingId, amountCents: amount - fee },
  ];
  if (fee > 0) lines.push({ accountId: mapping.feeId, amountCents: fee });

  const who = (invoice?.clientName || 'Customer').trim();
  const num = invoice?.number ? ` — #${invoice.number}` : '';
  const method = payment.method ? ' · ' + payment.method.replace(/_/g, ' ') : '';
  const feeNote = fee > 0 ? ` · fee $${(fee / 100).toFixed(2)}` : '';
  return {
    id: paymentTxnId(payment.txId),
    date: payment.date,
    payee: `${who}${num}`,
    memo: `Invoice2go payment${method}${feeNote}`,
    lines,
    status: 'posted',
    source: { app: 'invoice2go', sourceId: payment.txId },
  };
}

// Build all postable payment txns for a set of invoices, skipping payments
// before `startDate` and any whose txn id is already in `existingTxnIds`.
// Returns { txns, skipped, eligible } — eligible = matched the window,
// txns = newly built, skipped = already posted.
export function buildPaymentTxns(invoices, mapping, { startDate, existingTxnIds = new Set() } = {}) {
  const txns = [];
  let eligible = 0, skipped = 0;
  for (const inv of invoices || []) {
    for (const p of inv.payments || []) {
      if (p.status !== 'succeeded' || !p.txId || !p.date) continue;
      if (startDate && p.date < startDate) continue;
      eligible++;
      if (existingTxnIds.has(paymentTxnId(p.txId))) { skipped++; continue; }
      const txn = buildPaymentTxn({ invoice: inv, payment: p, mapping });
      if (txn) txns.push(txn);
    }
  }
  return { txns, skipped, eligible };
}
