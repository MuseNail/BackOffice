// ── lib: invoice2go-posting — turn an invoice payment into a ledger txn ─────────
// Pure (no DOM/IO). Cash-basis: each succeeded payment posts income (at the GROSS
// the customer paid) through a clearing account the bank deposit later relieves.
// The Invoice2go processing fee is split by who actually bore it:
//   • the part the customer covered (a surcharge you passed on) → a CONTRA-INCOME
//     line (debit an income account) — it nets the surcharge back out of revenue,
//     so passed-through fees don't reduce the job's profit.
//   • the part you absorbed → COGS (debit a cost-of-goods account) — so it lowers
//     the job's gross margin.
// (The 1% instant-payout fee is never passed; it's booked separately as an expense
// via the per-invoice "Payout fee" shortcut, not here.)
//
// Sign convention (posting.js, debit-positive). Lines sum to 0:
//   income    −amount               (gross collected)
//   clearing  +(amount − fee)       (net that reaches the bank)
//   passed    +passed               (debit contra-income; covered by surcharge)
//   absorbed  +absorbed             (debit COGS; your cost)        passed+absorbed = fee
//
// The txn id is derived from the payment's transaction_id so re-posting after a
// weekly re-import is idempotent — an already-posted payment is skipped.

export const paymentTxnId = (txId) => 'i2gp-' + txId;

// How much of this invoice's processing fees the customer covered: the surcharge
// they paid above the invoice total (paid − total), capped at the actual fees.
// Returns a 0..1 ratio applied per payment so the split is consistent.
function passedRatioFor(invoice) {
  const succ = (invoice?.payments || []).filter(p => p.status === 'succeeded');
  const totalFee = succ.reduce((s, p) => s + (p.feeCents | 0), 0);
  if (totalFee <= 0) return 0;
  const surcharge = Math.max(0, (invoice?.paidCents | 0) - (invoice?.totalCents | 0));
  return Math.min(1, surcharge / totalFee);
}

// mapping: { incomeId, clearingId, feePassedId, feeAbsorbedId }. Returns a txn, or
// null when it can't post (not succeeded, no id/amount, or a needed fee account
// isn't mapped). passedRatio is supplied by buildPaymentTxns (per invoice).
export function buildPaymentTxn({ invoice, payment, mapping, passedRatio = 0 }) {
  if (!payment || payment.status !== 'succeeded') return null;
  if (!payment.txId || !payment.date) return null;
  const amount = payment.amountCents | 0;
  if (amount <= 0) return null;
  if (!mapping?.incomeId || !mapping?.clearingId) return null;

  const fee = Math.max(0, payment.feeCents | 0);
  const passed = Math.round(fee * passedRatio); // covered by the customer's surcharge
  const absorbed = fee - passed;                // your cost
  if (passed > 0 && !mapping.feePassedId) return null;
  if (absorbed > 0 && !mapping.feeAbsorbedId) return null;

  const lines = [
    { accountId: mapping.incomeId, amountCents: -amount },
    { accountId: mapping.clearingId, amountCents: amount - fee },
  ];
  if (passed > 0) lines.push({ accountId: mapping.feePassedId, amountCents: passed });
  if (absorbed > 0) lines.push({ accountId: mapping.feeAbsorbedId, amountCents: absorbed });

  const who = (invoice?.clientName || 'Customer').trim();
  const num = invoice?.number ? ` — #${invoice.number}` : '';
  const method = payment.method ? ' · ' + payment.method.replace(/_/g, ' ') : '';
  const feeNote = fee > 0 ? ` · fee $${(fee / 100).toFixed(2)}${passed > 0 ? ` (${absorbed > 0 ? 'part ' : ''}passed to customer)` : ''}` : '';
  return {
    id: paymentTxnId(payment.txId),
    date: payment.date,
    payee: `${who}${num}`,
    memo: `Invoice2go payment${method}${feeNote}`,
    // tag to the invoice so the absorbed (COGS) fee counts toward this invoice's
    // profit margin, and the passed (contra-income) shows as "fee passed to customer".
    invoiceId: invoice?.id || undefined,
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
    const passedRatio = passedRatioFor(inv);
    for (const p of inv.payments || []) {
      if (p.status !== 'succeeded' || !p.txId || !p.date) continue;
      if (startDate && p.date < startDate) continue;
      eligible++;
      if (existingTxnIds.has(paymentTxnId(p.txId))) { skipped++; continue; }
      const txn = buildPaymentTxn({ invoice: inv, payment: p, mapping, passedRatio });
      if (txn) txns.push(txn);
    }
  }
  return { txns, skipped, eligible };
}
