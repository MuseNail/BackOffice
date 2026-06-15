// node --test tests/invoice2go-posting.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentTxn, buildPaymentTxns, paymentTxnId } from '../js/app/lib/invoice2go-posting.js';
import { validateTxn } from '../js/app/lib/posting.js';

const mapping = { incomeId: 'inc', clearingId: 'clr', feeId: 'fee' };
const accountsById = new Map([
  ['inc', { id: 'inc', name: 'Event income', type: 'income', active: true }],
  ['clr', { id: 'clr', name: 'Invoice2go clearing', type: 'asset', active: true }],
  ['fee', { id: 'fee', name: 'Merchant fees', type: 'expense', active: true }],
]);
const ctx = { accountsById, locks: new Set() };
const inv = { clientName: 'Three Petals', number: '4131' };

test('payment with a fee → balanced 3-line txn that the engine accepts', () => {
  const p = { txId: 'tx1', date: '2026-04-09', amountCents: 152626, feeCents: 4426, method: 'credit_card', status: 'succeeded' };
  const txn = buildPaymentTxn({ invoice: inv, payment: p, mapping });
  assert.equal(txn.id, 'i2gp-tx1');
  assert.equal(txn.status, 'posted');
  // income credited full amount; clearing = amount − fee; fee expensed
  const byAcct = Object.fromEntries(txn.lines.map(l => [l.accountId, l.amountCents]));
  assert.equal(byAcct.inc, -152626);
  assert.equal(byAcct.clr, 152626 - 4426);
  assert.equal(byAcct.fee, 4426);
  assert.equal(txn.lines.reduce((s, l) => s + l.amountCents, 0), 0);
  assert.ok(validateTxn(txn, ctx).ok, 'passes the double-entry validator');
  assert.equal(txn.source.sourceId, 'tx1');
});

test('payment with no fee → 2-line txn, no fee account needed', () => {
  const p = { txId: 'tx2', date: '2026-04-23', amountCents: 345800, feeCents: 0, method: 'manual_payment', status: 'succeeded' };
  const txn = buildPaymentTxn({ invoice: inv, payment: p, mapping: { incomeId: 'inc', clearingId: 'clr' } });
  assert.equal(txn.lines.length, 2);
  assert.ok(validateTxn(txn, ctx).ok);
});

test('non-postable payments return null', () => {
  const base = { txId: 'x', date: '2026-04-09', amountCents: 1000, status: 'succeeded' };
  assert.equal(buildPaymentTxn({ invoice: inv, payment: { ...base, status: 'failed' }, mapping }), null, 'failed');
  assert.equal(buildPaymentTxn({ invoice: inv, payment: { ...base, txId: '' }, mapping }), null, 'no txId');
  assert.equal(buildPaymentTxn({ invoice: inv, payment: { ...base, amountCents: 0 }, mapping }), null, 'zero amount');
  assert.equal(buildPaymentTxn({ invoice: inv, payment: { ...base, feeCents: 100 }, mapping: { incomeId: 'inc', clearingId: 'clr' } }), null, 'fee but no fee account');
});

test('buildPaymentTxns applies window + idempotency skip', () => {
  const invoices = [{
    clientName: 'Acme', number: '9', payments: [
      { txId: 'a', date: '2025-09-15', amountCents: 1000, status: 'succeeded' }, // before cutoff
      { txId: 'b', date: '2025-11-01', amountCents: 2000, status: 'succeeded' }, // in window, already posted
      { txId: 'c', date: '2025-12-01', amountCents: 3000, status: 'succeeded' }, // in window, new
      { txId: 'd', date: '2025-12-02', amountCents: 4000, status: 'failed' },    // not succeeded
    ],
  }];
  const existing = new Set([paymentTxnId('b')]);
  const { txns, skipped, eligible } = buildPaymentTxns(invoices, mapping, { startDate: '2025-10-01', existingTxnIds: existing });
  assert.equal(eligible, 2, 'b and c are in-window succeeded; a excluded by date, d by status');
  assert.equal(skipped, 1, 'b already posted');
  assert.deepEqual(txns.map(t => t.id), ['i2gp-c'], 'only c is newly built');
  assert.ok(txns.every(t => validateTxn(t, ctx).ok));
});
