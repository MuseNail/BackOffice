// node --test tests/i2g-cashflow.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCashflow, buildCashflowImport, cashflowPaymentTxnId, cashflowPayoutTxnId } from '../js/app/lib/i2g-cashflow.js';
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
