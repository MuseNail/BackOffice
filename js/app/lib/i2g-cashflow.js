// ── lib: i2g-cashflow — post Invoice2go's REAL cashflow feed to the ledger ──────
// Pure (no DOM/IO). Ingests the Invoice2go "banking/adyen/transactions" JSON
// (captured from the cashflow screen) — which carries the ACTUAL fees, nets, and
// payouts, so nothing is estimated.
//
// Per payment (universal, fee-pass-through or not):
//   net (total_received) = gross (amount_paid) − total_fee_charged − fee_paid_by_c2
//   • total_fee_charged = fee you ABSORBED  → COGS  (lowers gross margin)
//   • fee_paid_by_c2    = fee the customer COVERED → CONTRA-INCOME (nets out, no profit hit)
// Balanced entry (debit-positive):
//   income   −gross
//   contra   +fee_paid_by_c2     (debit an income account)
//   COGS     +total_fee_charged
//   clearing +total_received     (net that flows to a payout → relieved by the bank deposit)
//   → sums to 0 because net = gross − absorbed − passed.
//
// Per payout: the 1% instant-payout fee (rtp). Booked as an expense relieving
// clearing; the actual bank deposit (= net − fee, from the bank statement / QB import)
// relieves the rest, so clearing nets to ZERO when every payment has landed = the
// deposit match. same_day_ach payouts are free (no fee). The bank side is NOT posted
// here (the bank statement owns it) — only the fee.

import { validateTxn } from './posting.js';

export const cashflowPaymentTxnId = (id) => 'i2gc-' + id;
export const cashflowPayoutTxnId = (id) => 'i2gpo-' + id;
export const cashflowPayoutEntityId = (id) => 'i2gpay-' + id;

export function parseCashflow(raw) {
  const arr = Array.isArray(raw) ? raw
    : (raw && Array.isArray(raw.transactions) ? raw.transactions
      : (raw && Array.isArray(raw.cashflow) ? raw.cashflow : null));
  if (!arr) return null;
  const payments = [], payouts = [];
  for (const t of arr) {
    if (!t || t.status !== 'succeeded') continue;
    if (t.type === 'payment' && t.payment) {
      const p = t.payment;
      payments.push({
        id: t.id, date: String(t.created_date || '').slice(0, 10),
        gross: p.amount_paid | 0, absorbed: p.total_fee_charged | 0, passed: p.fee_paid_by_c2 | 0, net: p.total_received | 0,
        method: p.payment_method || '', docId: t.document?.document_id || '', docNum: String(t.document?.document_number || '').trim(),
        payee: t.info?.title || '',
      });
    } else if (t.type === 'payout' && t.payout) {
      payouts.push({ id: t.id, date: String(t.created_date || '').slice(0, 10), amount: Math.abs(t.payout.amount | 0), fee: t.payout.fee_amount | 0, method: t.payout.method || '' });
    }
  }
  return { payments, payouts };
}

// Parse the bundle's API-shaped invoices ({invoices:[...]}) into BackOffice invoice
// entities. The list API gives totals/status/client but NO line items or per-payment
// rows — those live in the cashflow feed (posted as ledger txns and tagged by id).
export function parseBundleInvoices(raw, now = 0, cutoff = '') {
  const arr = raw && Array.isArray(raw.invoices) ? raw.invoices : null;
  if (!arr) return null;
  const out = [];
  for (const v of arr) {
    if (!v || !v.id) continue;
    const docDate = String(v.content?.doc_date || '').slice(0, 10);
    if (cutoff && (!docDate || docDate < cutoff)) continue; // older periods are owned by QuickBooks
    const lcr = v.latest_calculation_results || {};
    const pay = lcr.payments || {};
    const total = lcr.total | 0;
    const balance = (pay.outstanding_balance != null ? pay.outstanding_balance : total) | 0;
    const paid = Math.max(0, total - balance);
    const st = v.states || {};
    const docStatus = pay.is_fully_paid ? 'fully_paid'
      : (paid > 0 ? 'partially_paid'
        : (st.list_category === 'unsent' || st.overall === 'unsent' ? 'unsent' : 'sent'));
    out.push({
      id: v.id, sourceId: v.id,
      number: String(v.content?.doc_number || '').trim(),
      date: docDate,
      createdDate: String(v.header?.created_date || '').slice(0, 10) || undefined,
      dueDate: String(st.due_date || '').slice(0, 10) || undefined,
      datePaid: String(st.date_paid || '').slice(0, 10) || undefined,
      clientName: v.content?.billing?.name || '', clientEmail: v.content?.billing?.email || '',
      totalCents: total, subtotalCents: total, taxCents: 0, paidCents: paid, balanceCents: balance,
      docStatus, docType: v.header?.type || 'invoice',
      lineItems: [], payments: [],
      source: { app: 'invoice2go-api', sourceId: v.id }, importedAt: now, updatedAt: now,
    });
  }
  return out;
}

const cleanLines = (lines) => {
  const byAcct = new Map();
  for (const l of lines) if (l.accountId && l.amountCents) byAcct.set(l.accountId, (byAcct.get(l.accountId) || 0) + l.amountCents);
  return [...byAcct].map(([accountId, amountCents]) => ({ accountId, amountCents })).filter(l => l.amountCents !== 0);
};

// mapping: { incomeId, clearingId, feePassedId, feeAbsorbedId, payoutFeeId }
export function buildCashflowImport(raw, { existingInvoices = [], mapping = {}, existingTxnIds = new Set(), now = 0, cutoff = '' } = {}) {
  const parsed = parseCashflow(raw);
  if (!parsed) return { errors: ['That file is not an Invoice2go cashflow export (no transactions array).'] };
  // Older periods are already booked in QuickBooks — posting Invoice2go that far back
  // would double-count income. Only payments/payouts on/after the cutoff are posted.
  const payments = cutoff ? parsed.payments.filter(p => p.date >= cutoff) : parsed.payments;
  const payouts = cutoff ? parsed.payouts.filter(p => p.date >= cutoff) : parsed.payouts;
  const errors = [];
  if (!mapping.incomeId || !mapping.clearingId) errors.push('Pick the income and clearing accounts.');

  // invoice match: by Invoice2go document id (UUID) first, then by number
  const byNum = new Map(), byId = new Map();
  for (const inv of existingInvoices) {
    if (inv.number) byNum.set(String(inv.number).trim(), inv.id);
    if (inv.sourceId) byId.set(inv.sourceId, inv.id);
    if (inv.id) byId.set(inv.id, inv.id);
  }
  const resolveInv = (docId, docNum) => byId.get(docId) || byNum.get(String(docNum).trim()) || null;
  // 1:1 payout→payment by net amount, to tag a payout fee to that invoice
  const netToPayments = new Map();
  for (const p of payments) (netToPayments.get(p.net) || netToPayments.set(p.net, []).get(p.net)).push(p);

  const txns = []; const unmatched = new Map(); let tagged = 0;

  for (const p of payments) {
    const invId = resolveInv(p.docId, p.docNum);
    if (invId) tagged++; else { const u = unmatched.get(p.docNum) || { count: 0, cents: 0 }; u.count++; u.cents += p.gross; unmatched.set(p.docNum, u); }
    const lines = [{ accountId: mapping.incomeId, amountCents: -p.gross }, { accountId: mapping.clearingId, amountCents: p.net }];
    if (p.passed > 0) { if (mapping.feePassedId) lines.push({ accountId: mapping.feePassedId, amountCents: p.passed }); else errors.push('Pick the “passed to customer” (income) account.'); }
    if (p.absorbed > 0) { if (mapping.feeAbsorbedId) lines.push({ accountId: mapping.feeAbsorbedId, amountCents: p.absorbed }); else errors.push('Pick the “absorbed” (COGS) account.'); }
    txns.push({
      id: cashflowPaymentTxnId(p.id), date: p.date, payee: p.payee || ('Invoice2go ' + (p.docNum ? '#' + p.docNum : 'payment')),
      memo: `Invoice2go ${p.method.replace(/_/g, ' ')} payment` + (p.absorbed || p.passed ? ` — fee $${((p.absorbed + p.passed) / 100).toFixed(2)}: $${(p.absorbed / 100).toFixed(2)} absorbed, $${(p.passed / 100).toFixed(2)} passed` : ''),
      invoiceId: invId || undefined, lines: cleanLines(lines), status: 'posted', source: { app: 'i2g-cashflow', sourceId: p.id },
    });
  }

  let payoutFees = 0;
  // Every payout is a bank deposit to reconcile (incl. free same_day_ach ones, which
  // book no fee txn). We record them as `i2gpayout` entities — netToBankCents (= amount
  // − the 1% instant fee) is the amount that actually hits the bank, the match target.
  const payoutEntities = [];
  for (const po of payouts) {
    const hits = netToPayments.get(po.amount) || [];
    const invId = hits.length === 1 ? resolveInv(hits[0].docId, hits[0].docNum) : null; // tag only when it's clearly one invoice
    payoutEntities.push({
      id: cashflowPayoutEntityId(po.id), date: po.date,
      amountCents: po.amount, feeCents: po.fee, netToBankCents: po.amount - po.fee,
      method: po.method, invoiceId: invId || undefined,
      source: { app: 'i2g-payout', sourceId: po.id },
    });
    if (po.fee <= 0) continue;
    payoutFees += po.fee;
    if (!mapping.payoutFeeId) { errors.push('Pick a Payout Fee expense account.'); continue; }
    txns.push({
      id: cashflowPayoutTxnId(po.id), date: po.date, payee: 'Invoice2go instant payout', memo: 'Invoice2go instant-payout fee (1%)',
      invoiceId: invId || undefined,
      lines: [{ accountId: mapping.payoutFeeId, amountCents: po.fee }, { accountId: mapping.clearingId, amountCents: -po.fee }],
      status: 'posted', source: { app: 'i2g-cashflow-payout', sourceId: po.id },
    });
  }

  const fresh = txns.filter(t => !existingTxnIds.has(t.id));
  const sum = (k) => payments.reduce((s, p) => s + p[k], 0);
  return {
    errors: [...new Set(errors)],
    txns: fresh, allTxns: txns, payoutEntities,
    preview: {
      payments: payments.length, payouts: payouts.length, payoutsWithFee: payouts.filter(p => p.fee > 0).length,
      toPost: fresh.length, alreadyPosted: txns.length - fresh.length,
      income: sum('gross'), passed: sum('passed'), absorbed: sum('absorbed'), net: sum('net'), payoutFees,
      tagged, dateRange: payments.length ? [payments.reduce((m, p) => p.date < m ? p.date : m, '9999'), payments.reduce((m, p) => p.date > m ? p.date : m, '0000')] : null,
      unmatchedInvoices: [...unmatched.entries()].map(([number, u]) => ({ number, ...u })).sort((a, b) => b.count - a.count),
    },
  };
}
