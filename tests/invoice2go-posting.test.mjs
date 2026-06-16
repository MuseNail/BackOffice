// node --test tests/invoice2go-posting.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentTxn, buildPaymentTxns, paymentTxnId, DEFAULT_CARD_RATE } from '../js/app/lib/invoice2go-posting.js';
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

test('default card rate is 2.9%', () => assert.equal(DEFAULT_CARD_RATE, 0.029));

test('card payment, no surcharge → fee DERIVED at 2.9% and booked to COGS', () => {
  // $4,095 card payment, no surcharge passed (feeCents 0) → absorbed = round(409500*0.029)=11876
  const p = { txId: 'tx1', date: '2026-06-11', amountCents: 409500, feeCents: 0, method: 'credit_card', status: 'succeeded' };
  const txn = buildPaymentTxn({ invoice: inv, payment: p, mapping });
  const byAcct = Object.fromEntries(txn.lines.map(l => [l.accountId, l.amountCents]));
  assert.equal(byAcct.inc, -409500, 'income at gross');
  assert.equal(byAcct.cogs, 11876, 'derived 2.9% → COGS (absorbed)');
  assert.equal(byAcct.clr, 409500 - 11876, 'net to clearing');
  assert.equal(byAcct.passed, undefined, 'nothing passed');
  assert.equal(txn.lines.reduce((s, l) => s + l.amountCents, 0), 0);
  assert.ok(validateTxn(txn, ctx).ok);
  assert.match(txn.memo, /est\. 2\.9%/);
});

test('card payment with surcharge = fee → fully PASSED (contra-income), none absorbed', () => {
  // 4064-style: $1,446.45 card payment, surcharge feeCents 4195; derived 2.9% = 4195 → all passed
  const p = { txId: 'tx2', date: '2026-03-31', amountCents: 144645, feeCents: 4195, method: 'credit_card', status: 'succeeded' };
  const txn = buildPaymentTxn({ invoice: inv, payment: p, mapping });
  const byAcct = Object.fromEntries(txn.lines.map(l => [l.accountId, l.amountCents]));
  assert.equal(byAcct.passed, 4195, 'surcharge → contra-income');
  assert.equal(byAcct.cogs, undefined, 'nothing absorbed (customer covered it)');
  assert.equal(byAcct.clr, 144645 - 4195, 'net to clearing = gross − derived fee');
  assert.equal(txn.lines.reduce((s, l) => s + l.amountCents, 0), 0);
  assert.ok(validateTxn(txn, ctx).ok);
});

test('non-card payment → no Invoice2go fee derived (2-line txn)', () => {
  const p = { txId: 'tx3', date: '2026-06-07', amountCents: 236000, feeCents: 0, method: 'manual_payment', status: 'succeeded' };
  const txn = buildPaymentTxn({ invoice: inv, payment: p, mapping });
  assert.equal(txn.lines.length, 2, 'income + clearing only');
  assert.ok(validateTxn(txn, ctx).ok);
});

test('configurable rate (3%) is honored', () => {
  const p = { txId: 'tx4', date: '2026-06-01', amountCents: 100000, feeCents: 0, method: 'credit_card', status: 'succeeded' };
  const txn = buildPaymentTxn({ invoice: inv, payment: p, mapping: { ...mapping, cardRate: 0.03 } });
  const byAcct = Object.fromEntries(txn.lines.map(l => [l.accountId, l.amountCents]));
  assert.equal(byAcct.cogs, 3000, '3% of $1000');
});

test('non-postable payments return null', () => {
  const base = { txId: 'x', date: '2026-04-09', amountCents: 1000, status: 'succeeded' };
  assert.equal(buildPaymentTxn({ invoice: inv, payment: { ...base, status: 'failed' }, mapping }), null);
  assert.equal(buildPaymentTxn({ invoice: inv, payment: { ...base, txId: '' }, mapping }), null);
  assert.equal(buildPaymentTxn({ invoice: inv, payment: { ...base, amountCents: 0 }, mapping }), null);
  // a card payment derives a fee → needs the COGS account
  assert.equal(buildPaymentTxn({ invoice: inv, payment: { ...base, method: 'credit_card' }, mapping: { incomeId: 'inc', clearingId: 'clr' } }), null, 'derived fee but no COGS account');
});

test('buildPaymentTxns applies window + idempotency skip', () => {
  const invoices = [{
    clientName: 'Acme', number: '9', payments: [
      { txId: 'a', date: '2025-09-15', amountCents: 1000, method: 'manual_payment', status: 'succeeded' }, // before cutoff
      { txId: 'b', date: '2025-11-01', amountCents: 2000, method: 'manual_payment', status: 'succeeded' }, // posted
      { txId: 'c', date: '2025-12-01', amountCents: 3000, method: 'manual_payment', status: 'succeeded' }, // new
      { txId: 'd', date: '2025-12-02', amountCents: 4000, method: 'manual_payment', status: 'failed' },    // not succeeded
    ],
  }];
  const existing = new Set([paymentTxnId('b')]);
  const { txns, skipped, eligible } = buildPaymentTxns(invoices, mapping, { startDate: '2025-10-01', existingTxnIds: existing });
  assert.equal(eligible, 2, 'b and c in-window succeeded');
  assert.equal(skipped, 1, 'b already posted');
  assert.deepEqual(txns.map(t => t.id), ['i2gp-c']);
  assert.ok(txns.every(t => validateTxn(t, ctx).ok));
});
