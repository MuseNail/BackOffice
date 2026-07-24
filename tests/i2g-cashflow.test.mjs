// node --test tests/i2g-cashflow.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCashflow, buildCashflowImport, cashflowPaymentTxnId, cashflowPayoutTxnId, parseBundleInvoices } from '../js/app/lib/i2g-cashflow.js';
import { validateTxn } from '../js/app/lib/posting.js';

const mapping = { incomeId: 'inc', clearingId: 'clr', feePassedId: 'passed', feeAbsorbedId: 'cogs', payoutFeeId: 'payout' };
const accountsById = new Map([
  ['inc', { id: 'inc', type: 'income', active: true }],
  ['clr', { id: 'clr', type: 'asset', active: true }],
  ['passed', { id: 'passed', type: 'income', active: true }],
  ['cogs', { id: 'cogs', type: 'cogs', active: true }],
  ['payout', { id: 'payout', type: 'expense', active: true }],
]);
const ctx = { accountsById, locks: new Set() };
const byAcct = (t) => Object.fromEntries(t.lines.map(l => [l.accountId, l.amountCents]));

// non-fpt (absorbed): total_fee_charged carries the fee, fee_paid_by_c2 = 0
const absorbedPay = { id: 'p1', type: 'payment', status: 'succeeded', created_date: '2026-03-01T00:00:00Z',
  payment: { payment_method: 'credit_card', amount_paid: 210000, total_fee_charged: 6090, fee_paid_by_c2: 0, total_received: 203910 },
  document: { document_type: 'estimate', document_number: '3503', document_id: 'doc-3503' } };
// fpt (passed): total_fee_charged = 0, fee_paid_by_c2 carries the surcharge
const passedPay = { id: 'p2', type: 'payment', status: 'succeeded', created_date: '2026-03-02T00:00:00Z',
  payment: { payment_method: 'credit_card', amount_paid: 412461, total_fee_charged: 0, fee_paid_by_c2: 11961, total_received: 400500 },
  document: { document_type: 'invoice', document_number: '3972', document_id: 'doc-3972' } };
const bankPay = { id: 'p3', type: 'payment', status: 'succeeded', created_date: '2026-03-03T00:00:00Z',
  payment: { payment_method: 'bank_transfer', amount_paid: 269500, total_fee_charged: 0, fee_paid_by_c2: 0, total_received: 269500 },
  document: { document_type: 'invoice', document_number: '3967', document_id: 'doc-3967' } };
const instantPayout = { id: 'po1', type: 'payout', status: 'succeeded', created_date: '2026-03-02T00:00:00Z',
  payout: { amount: -400500, fee_amount: 4005, method: 'rtp' } }; // 1% of the 400500 net (passedPay) → tags to 3972
const achPayout = { id: 'po2', type: 'payout', status: 'succeeded', created_date: '2026-03-03T00:00:00Z',
  payout: { amount: -269500, fee_amount: 0, method: 'same_day_ach' } }; // free

const raw = [absorbedPay, passedPay, bankPay, instantPayout, achPayout, { id: 'x', type: 'payment', status: 'failed', payment: {} }];
const invoices = [{ id: 'i3503', number: '3503' }, { id: 'i3972', number: '3972', sourceId: 'doc-3972' }, { id: 'i3967', number: '3967' }];

test('parseCashflow keeps succeeded payments/payouts, drops failed', () => {
  const { payments, payouts } = parseCashflow(raw);
  assert.equal(payments.length, 3);
  assert.equal(payouts.length, 2);
});

test('absorbed payment → fee to COGS, income at gross, all balanced', () => {
  const r = buildCashflowImport([absorbedPay], { existingInvoices: invoices, mapping });
  const t = r.txns.find(x => x.id === cashflowPaymentTxnId('p1'));
  const b = byAcct(t);
  assert.equal(b.inc, -210000);
  assert.equal(b.cogs, 6090);
  assert.equal(b.clr, 203910);
  assert.equal(b.passed, undefined);
  assert.equal(t.lines.reduce((s, l) => s + l.amountCents, 0), 0);
  assert.equal(t.invoiceId, 'i3503');
  assert.ok(validateTxn(t, ctx).ok);
});

test('passed (fpt) payment → fee to contra-income, none to COGS', () => {
  const r = buildCashflowImport([passedPay], { existingInvoices: invoices, mapping });
  const t = r.txns[0]; const b = byAcct(t);
  assert.equal(b.inc, -412461);
  assert.equal(b.passed, 11961);
  assert.equal(b.cogs, undefined);
  assert.equal(b.clr, 400500);
  assert.equal(t.lines.reduce((s, l) => s + l.amountCents, 0), 0);
  assert.equal(t.invoiceId, 'i3972'); // matched by document_id → sourceId
  assert.ok(validateTxn(t, ctx).ok);
});

test('bank transfer → no fee, 2-line', () => {
  const r = buildCashflowImport([bankPay], { existingInvoices: invoices, mapping });
  assert.equal(r.txns[0].lines.length, 2);
});

test('payout entities capture every payout (incl. free ACH) with net-to-bank = amount − fee', () => {
  const r = buildCashflowImport([passedPay, instantPayout, achPayout], { existingInvoices: invoices, mapping });
  const pe = r.payoutEntities;
  assert.equal(pe.length, 2); // rtp + ach (both are bank deposits to reconcile)
  const rtp = pe.find(p => p.id === 'i2gpay-po1');
  assert.equal(rtp.amountCents, 400500);
  assert.equal(rtp.feeCents, 4005);
  assert.equal(rtp.netToBankCents, 396495); // amount − fee = what hits the bank
  assert.equal(rtp.invoiceId, 'i3972');      // 1:1 net match → tagged
  const ach = pe.find(p => p.id === 'i2gpay-po2');
  assert.equal(ach.feeCents, 0);
  assert.equal(ach.netToBankCents, 269500);  // free payout → full amount hits the bank
});

test('instant payout fee → expense + clearing relief, tagged 1:1 to its invoice', () => {
  const r = buildCashflowImport([passedPay, instantPayout, achPayout], { existingInvoices: invoices, mapping });
  const po = r.txns.find(x => x.id === cashflowPayoutTxnId('po1'));
  const b = byAcct(po);
  assert.equal(b.payout, 4005);
  assert.equal(b.clr, -4005);
  assert.equal(po.invoiceId, 'i3972', 'payout net 400500 matches passedPay → invoice 3972');
  assert.ok(validateTxn(po, ctx).ok);
  // the free ach payout produces no txn
  assert.equal(r.txns.find(x => x.id === cashflowPayoutTxnId('po2')), undefined);
});

test('totals tie out and idempotency skips already-posted', () => {
  const r = buildCashflowImport(raw, { existingInvoices: invoices, mapping });
  const p = r.preview;
  assert.equal(p.income, 210000 + 412461 + 269500);
  assert.equal(p.absorbed, 6090);
  assert.equal(p.passed, 11961);
  assert.equal(p.net, 203910 + 400500 + 269500);
  assert.equal(p.payoutFees, 4005);
  // income − absorbed − passed === net
  assert.equal(p.income - p.absorbed - p.passed, p.net);
  // re-run with everything already posted → nothing to post
  const ids = new Set(r.allTxns.map(t => t.id));
  const r2 = buildCashflowImport(raw, { existingInvoices: invoices, mapping, existingTxnIds: ids });
  assert.equal(r2.txns.length, 0);
});

test('parseCashflow accepts the one-click bundle { cashflow: [...] }', () => {
  const { payments, payouts } = parseCashflow({ invoices: [], cashflow: [absorbedPay, instantPayout] });
  assert.equal(payments.length, 1);
  assert.equal(payouts.length, 1);
});

const bundleInv = {
  id: '267d2440-uuid', header: { type: 'invoice', created_date: '2026-06-10T17:52:50Z' },
  content: { doc_number: '4196', doc_date: '2026-06-15', billing: { name: 'Hangar 21', email: 'mike@h21.com' } },
  states: { list_category: 'sent', overall: 'sent', due_date: '2026-06-20', date_paid: '2026-06-18' },
  latest_calculation_results: { total: 322000, total_payable: 322000, payments: { is_fully_paid: false, outstanding_balance: 122000 } },
};

test('parseBundleInvoices maps money/identity/dates, leaves line items empty, marks bundle-owned', () => {
  const [inv] = parseBundleInvoices({ invoices: [bundleInv] }, 999);
  assert.equal(inv.id, '267d2440-uuid');
  assert.equal(inv.number, '4196');
  assert.equal(inv.clientName, 'Hangar 21');
  assert.equal(inv.totalCents, 322000);
  assert.equal(inv.balanceCents, 122000);
  assert.equal(inv.paidCents, 200000);          // total − outstanding
  assert.equal(inv.docStatus, 'partially_paid'); // paid > 0 but not fully paid
  assert.equal(inv.date, '2026-06-15');         // invoice date (doc_date)
  assert.equal(inv.createdDate, '2026-06-10');  // header.created_date, day only
  assert.equal(inv.dueDate, '2026-06-20');
  assert.equal(inv.datePaid, '2026-06-18');
  assert.deepEqual(inv.lineItems, []);
  assert.equal(inv.source.app, 'invoice2go-api');
  assert.equal(inv.updatedAt, 999);
});

test('parseBundleInvoices: fully paid + unsent statuses', () => {
  const paid = { ...bundleInv, latest_calculation_results: { total: 5000, payments: { is_fully_paid: true, outstanding_balance: 0 } } };
  const unsent = { ...bundleInv, states: { list_category: 'unsent', overall: 'unsent' }, latest_calculation_results: { total: 5000, payments: { is_fully_paid: false, outstanding_balance: 5000 } } };
  assert.equal(parseBundleInvoices({ invoices: [paid] })[0].docStatus, 'fully_paid');
  assert.equal(parseBundleInvoices({ invoices: [unsent] })[0].docStatus, 'unsent');
});

test('parseBundleInvoices returns null for a non-bundle file', () => {
  assert.equal(parseBundleInvoices([absorbedPay]), null);
  assert.equal(parseBundleInvoices({ cashflow: [] }), null);
});

test('cutoff drops a pre-cutoff PARTIALLY-paid/unpaid invoice + pre-cutoff cashflow (avoids double-counting QB)', () => {
  // bundleInv is partially paid (outstanding_balance 122000 < total 322000 but NOT fully paid) → a
  // back-dated copy stays DROPPED: it's QuickBooks-era, and importing it would inject stale open A/R.
  const old = { ...bundleInv, id: 'old-uuid', content: { ...bundleInv.content, doc_date: '2025-09-15' } };
  const invs = parseBundleInvoices({ invoices: [old, bundleInv] }, 0, '2025-10-01');
  assert.equal(invs.length, 1);
  assert.equal(invs[0].id, '267d2440-uuid'); // the 2026 one kept, the partially-paid Sept-2025 one dropped
  assert.equal(invs.skippedPreCutoff, 1, 'the pre-cutoff not-fully-paid invoice is counted as skipped');
  // cashflow: absorbedPay is 2026-03-01 (kept); a pre-cutoff payment is dropped
  const oldPay = { ...absorbedPay, id: 'pOld', created_date: '2025-08-01T00:00:00Z' };
  const r = buildCashflowImport([oldPay, absorbedPay], { existingInvoices: invoices, mapping, cutoff: '2025-10-01' });
  assert.equal(r.preview.payments, 1);
  assert.equal(r.txns.find(t => t.id === cashflowPaymentTxnId('pOld')), undefined);
});

test('a FULLY-PAID back-dated invoice is KEPT (the #3930 case: dated pre-cutoff, paid after)', () => {
  // #3930 shape: converted from an estimate so it keeps the OLD creation date (2025-09), but it is paid
  // in full in 2026 — must import (income posting is separate + unchanged; a $0-balance card adds no A/R).
  const paidOld = { ...bundleInv, id: 'paid-old', content: { ...bundleInv.content, doc_date: '2025-09-09' },
    states: { ...bundleInv.states, date_paid: '2026-03-31' },
    latest_calculation_results: { total: 754000, payments: { is_fully_paid: true, outstanding_balance: 0 } } };
  const invs = parseBundleInvoices({ invoices: [paidOld] }, 0, '2025-10-01');
  assert.equal(invs.length, 1, 'a fully-paid back-dated invoice imports');
  assert.equal(invs[0].id, 'paid-old');
  assert.equal(invs[0].docStatus, 'fully_paid');
  assert.equal(invs[0].balanceCents, 0);
  assert.equal(invs.skippedPreCutoff, 0);
});

test('balance<=0 counts as fully paid even without the is_fully_paid flag; a pre-cutoff UNPAID invoice drops', () => {
  const paidByBalance = { ...bundleInv, id: 'paid-bal', content: { ...bundleInv.content, doc_date: '2025-09-09' },
    latest_calculation_results: { total: 500000, payments: { outstanding_balance: 0 } } }; // no is_fully_paid flag
  const unpaidOld = { ...bundleInv, id: 'unpaid-old', content: { ...bundleInv.content, doc_date: '2025-09-09' },
    latest_calculation_results: { total: 500000, payments: { is_fully_paid: false, outstanding_balance: 500000 } } };
  const zeroTotal = { ...bundleInv, id: 'zero-old', content: { ...bundleInv.content, doc_date: '2025-09-09' },
    latest_calculation_results: { total: 0, payments: { outstanding_balance: 0 } } }; // $0 draft: no real money → dropped
  const invs = parseBundleInvoices({ invoices: [paidByBalance, unpaidOld, zeroTotal] }, 0, '2025-10-01');
  assert.deepEqual(invs.map(i => i.id), ['paid-bal'], 'paid-by-balance kept; unpaid + $0-total pre-cutoff dropped');
  assert.equal(invs[0].docStatus, 'fully_paid', 'kept-by-balance invoice is labeled fully paid, not partial');
  assert.equal(invs.skippedPreCutoff, 2);
});

test('no cutoff → every invoice kept and skippedPreCutoff is 0', () => {
  const old = { ...bundleInv, id: 'old-uuid', content: { ...bundleInv.content, doc_date: '2025-09-15' } };
  const invs = parseBundleInvoices({ invoices: [old, bundleInv] }, 0, '');
  assert.equal(invs.length, 2);
  assert.equal(invs.skippedPreCutoff, 0);
});

test('is_fully_paid flag with a still-owed balance is NOT admitted (no stale A/R resurrected)', () => {
  const flagButOwed = { ...bundleInv, id: 'flag-owed', content: { ...bundleInv.content, doc_date: '2025-09-09' },
    latest_calculation_results: { total: 500000, payments: { is_fully_paid: true, outstanding_balance: 200000 } } };
  const invs = parseBundleInvoices({ invoices: [flagButOwed] }, 0, '2025-10-01');
  assert.equal(invs.length, 0, 'a pre-cutoff invoice with a nonzero balance is dropped even if is_fully_paid is set');
  assert.equal(invs.skippedPreCutoff, 1);
});

test('SAFETY: importing more (fully-paid) invoice cards changes NO cashflow income or txn count', () => {
  const base = buildCashflowImport(raw, { existingInvoices: invoices, mapping });
  const extraCard = { id: 'i-extra', number: '9999', sourceId: 'doc-9999', totalCents: 100000, paidCents: 100000, balanceCents: 0 };
  const withCard = buildCashflowImport(raw, { existingInvoices: [...invoices, extraCard], mapping });
  assert.equal(withCard.txns.length, base.txns.length, 'same number of income txns — a card posts nothing');
  assert.equal(withCard.preview.income, base.preview.income, 'same gross income');
  assert.equal(withCard.preview.net, base.preview.net, 'same net to clearing');
});
