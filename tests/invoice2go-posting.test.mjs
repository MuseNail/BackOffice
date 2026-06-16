// node --test tests/invoice2go-posting.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentTxn, buildPaymentTxns, paymentTxnId } from '../js/app/lib/invoice2go-posting.js';
import { validateTxn } from '../js/app/lib/posting.js';

const mapping = { incomeId: 'inc', clearingId: 'clr', feePassedId: 'passed', feeAbsorbedId: 'cogs' };
const accountsById = new Map([
  ['inc', { id: 'inc', name: 'Event income', type: 'income', active: true }],
  ['clr', { id: 'clr', name: 'Invoice2go clearing', type: 'asset', active: true }],
  ['passed', { id: 'passed', name: 'Processing fees passed', type: 'income', active: true }],
  ['cogs', { id: 'cogs', name: 'Card processing fees', type: 'cogs', active: true }],
]);
const ctx = { accountsById, locks: new Set() };
const inv = { clientName: 'Three Petals', number: '4131' };

test('absorbed fee (no surcharge) → fee booked to COGS, income at gross', () => {
  const p = { txId: 'tx1', date: '2026-04-09', amountCents: 100000, feeCents: 2900, method: 'credit_card', status: 'succeeded' };
  const txn = buildPaymentTxn({ invoice: inv, payment: p, mapping, passedRatio: 0 });
  assert.equal(txn.id, 'i2gp-tx1');
  const byAcct = Object.fromEntries(txn.lines.map(l => [l.accountId, l.amountCents]));
  assert.equal(byAcct.inc, -100000);
  assert.equal(byAcct.clr, 100000 - 2900);
  assert.equal(byAcct.cogs, 2900, 'absorbed fee → COGS');
  assert.equal(byAcct.passed, undefined, 'nothing passed');
  assert.equal(txn.lines.reduce((s, l) => s + l.amountCents, 0), 0);
  assert.ok(validateTxn(txn, ctx).ok);
});

test('passed fee (full surcharge) → fee booked to contra-income, none to COGS', () => {
  const p = { txId: 'tx2', date: '2026-04-09', amountCents: 103000, feeCents: 3000, method: 'credit_card', status: 'succeeded' };
  const txn = buildPaymentTxn({ invoice: inv, payment: p, mapping, passedRatio: 1 });
  const byAcct = Object.fromEntries(txn.lines.map(l => [l.accountId, l.amountCents]));
  assert.equal(byAcct.inc, -103000);
  assert.equal(byAcct.passed, 3000, 'passed fee → contra-income');
  assert.equal(byAcct.cogs, undefined, 'nothing absorbed');
  assert.equal(txn.lines.reduce((s, l) => s + l.amountCents, 0), 0);
  assert.ok(validateTxn(txn, ctx).ok);
});

test('partial pass → split across contra-income and COGS', () => {
  const p = { txId: 'tx3', date: '2026-04-09', amountCents: 100000, feeCents: 1000, status: 'succeeded' };
  const txn = buildPaymentTxn({ invoice: inv, payment: p, mapping, passedRatio: 0.4 });
  const byAcct = Object.fromEntries(txn.lines.map(l => [l.accountId, l.amountCents]));
  assert.equal(byAcct.passed, 400);
  assert.equal(byAcct.cogs, 600);
  assert.equal(txn.lines.reduce((s, l) => s + l.amountCents, 0), 0);
});

test('no fee → 2-line txn, no fee account needed', () => {
  const p = { txId: 'tx4', date: '2026-04-23', amountCents: 345800, feeCents: 0, method: 'manual_payment', status: 'succeeded' };
  const txn = buildPaymentTxn({ invoice: inv, payment: p, mapping: { incomeId: 'inc', clearingId: 'clr' } });
  assert.equal(txn.lines.length, 2);
  assert.ok(validateTxn(txn, ctx).ok);
});

test('non-postable payments return null', () => {
  const base = { txId: 'x', date: '2026-04-09', amountCents: 1000, status: 'succeeded' };
  assert.equal(buildPaymentTxn({ invoice: inv, payment: { ...base, status: 'failed' }, mapping }), null, 'failed');
  assert.equal(buildPaymentTxn({ invoice: inv, payment: { ...base, txId: '' }, mapping }), null, 'no txId');
  assert.equal(buildPaymentTxn({ invoice: inv, payment: { ...base, amountCents: 0 }, mapping }), null, 'zero amount');
  assert.equal(buildPaymentTxn({ invoice: inv, payment: { ...base, feeCents: 100 }, mapping: { incomeId: 'inc', clearingId: 'clr' }, passedRatio: 0 }), null, 'absorbed fee but no COGS account');
  assert.equal(buildPaymentTxn({ invoice: inv, payment: { ...base, feeCents: 100 }, mapping: { incomeId: 'inc', clearingId: 'clr' }, passedRatio: 1 }), null, 'passed fee but no contra-income account');
});

test('buildPaymentTxns derives the pass-ratio from invoice surcharge + applies window/idempotency', () => {
  // total 100000, paid 103000 → surcharge 3000; the in-window payment's fee is 3000 → fully passed
  const invoices = [{
    clientName: 'Acme', number: '9', totalCents: 100000, paidCents: 103000, payments: [
      { txId: 'a', date: '2025-09-15', amountCents: 50000, feeCents: 0, status: 'succeeded' }, // before cutoff
      { txId: 'b', date: '2025-11-01', amountCents: 53000, feeCents: 3000, status: 'succeeded' }, // in window, posted
      { txId: 'c', date: '2025-12-01', amountCents: 0, feeCents: 0, status: 'succeeded' },        // zero amount → skipped
    ],
  }];
  const existing = new Set([paymentTxnId('b')]);
  const r1 = buildPaymentTxns(invoices, mapping, { startDate: '2025-10-01', existingTxnIds: existing });
  assert.equal(r1.skipped, 1, 'b already posted');
  assert.deepEqual(r1.txns.map(t => t.id), [], 'b skipped (posted), a out of window, c zero');

  const r2 = buildPaymentTxns(invoices, mapping, { startDate: '2025-10-01', existingTxnIds: new Set() });
  const b = r2.txns.find(t => t.id === 'i2gp-b');
  const byAcct = Object.fromEntries(b.lines.map(l => [l.accountId, l.amountCents]));
  assert.equal(byAcct.passed, 3000, 'surcharge 3000 == fee 3000 → fully passed to contra-income');
  assert.equal(byAcct.cogs, undefined);
  assert.ok(validateTxn(b, ctx).ok);
});
