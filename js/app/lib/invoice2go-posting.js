// ── lib: invoice2go-posting — turn an invoice payment into a ledger txn ─────────
// Pure (no DOM/IO). Cash-basis: each succeeded payment posts income (at the GROSS
// the customer paid) through a clearing account the bank deposit later relieves.
//
// IMPORTANT about the two different "fees":
//   • The Invoice2go EXPORT's fee field (payment.feeCents, from `fpt_fee_amount`)
//     is the surcharge PASSED to the customer ("fee pass-through") — NOT Invoice2go's
//     own cut. It is $0 when you absorbed the fee. This is real data.
//   • Invoice2go's actual card cut (≈2.9%) is NOT exported. We DERIVE it from the
//     card payment amount (rate configurable, default 2.9%) so the absorbed cost is
//     captured. Only the absorbed side is derived; the passed side is real data.
//
// Split of the derived card fee:
//   passed   = min(surcharge the customer paid, derived fee)  → CONTRA-INCOME
//   absorbed = derived fee − passed                            → COGS
// Passed-through fees net out of revenue (no profit hit); absorbed fees lower gross
// margin. The 1% instant-payout fee is booked separately (per-invoice shortcut).
//
// Sign convention (posting.js, debit-positive). Lines sum to 0:
//   income    −amount               (gross collected)
//   clearing  +(amount − derivedFee)(net that reaches the bank)
//   passed    +passed               (debit contra-income)
//   absorbed  +absorbed             (debit COGS)         passed+absorbed = derivedFee
//
// The txn id is derived from the payment's transaction_id so re-posting after a
// weekly re-import is idempotent — an already-posted payment is skipped.

export const paymentTxnId = (txId) => 'i2gp-' + txId;
export const DEFAULT_CARD_RATE = 0.029; // Invoice2go Money card fee — flat 2.9% (verified)
const isCardMethod = (m) => /card/i.test(m || ''); // credit_card / debit_card incur the fee; cash/check/transfer don't

// mapping: { incomeId, clearingId, feePassedId, feeAbsorbedId, cardRate? }. Returns a
// txn, or null when it can't post (not succeeded, no id/amount, or a needed fee
// account isn't mapped).
export function buildPaymentTxn({ invoice, payment, mapping }) {
  if (!payment || payment.status !== 'succeeded') return null;
  if (!payment.txId || !payment.date) return null;
  const amount = payment.amountCents | 0;
  if (amount <= 0) return null;
  if (!mapping?.incomeId || !mapping?.clearingId) return null;

  const rate = mapping.cardRate != null ? mapping.cardRate : DEFAULT_CARD_RATE;
  const derivedFee = isCardMethod(payment.method) ? Math.round(amount * rate) : 0; // Invoice2go's cut (estimated)
  const passed = Math.min(Math.max(0, payment.feeCents | 0), derivedFee);          // surcharge the customer covered (real)
  const absorbed = derivedFee - passed;                                            // your cost
  if (passed > 0 && !mapping.feePassedId) return null;
  if (absorbed > 0 && !mapping.feeAbsorbedId) return null;

  const lines = [
    { accountId: mapping.incomeId, amountCents: -amount },
    { accountId: mapping.clearingId, amountCents: amount - derivedFee },
  ];
  if (passed > 0) lines.push({ accountId: mapping.feePassedId, amountCents: passed });
  if (absorbed > 0) lines.push({ accountId: mapping.feeAbsorbedId, amountCents: absorbed });

  const who = (invoice?.clientName || 'Customer').trim();
  const num = invoice?.number ? ` — #${invoice.number}` : '';
  const method = payment.method ? ' · ' + payment.method.replace(/_/g, ' ') : '';
  const pct = (rate * 100).toFixed(2).replace(/\.?0+$/, '');
  // Clearly label what's real vs estimated, so the txn can be reviewed at a glance.
  const feeNote = derivedFee > 0
    ? ` · card fee $${(derivedFee / 100).toFixed(2)} (est. ${pct}%) — $${(passed / 100).toFixed(2)} passed to customer, $${(absorbed / 100).toFixed(2)} absorbed`
    : '';
  return {
    id: paymentTxnId(payment.txId),
    date: payment.date,
    payee: `${who}${num}`,
    memo: `Invoice2go payment${method}${feeNote}`,
    invoiceId: invoice?.id || undefined,
    lines,
    status: 'posted',
    source: { app: 'invoice2go', sourceId: payment.txId },
  };
}

// Build all postable payment txns for a set of invoices, skipping payments
// before `startDate` and any whose txn id is already in `existingTxnIds`.
// Returns { txns, skipped, eligible }.
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
