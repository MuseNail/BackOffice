// node --test tests/plaid-map.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { shapePlaidTxn, shapePlaidBatch } from '../js/app/lib/plaid-map.js';
import { dedupHash } from '../js/app/lib/csv.js';

// Plaid: amount is a NUMBER, positive = money OUT of the account.
const tx = (over = {}) => ({
  transaction_id: 'txn_abc', account_id: 'acc_1', date: '2026-06-12',
  name: 'SQ *MUSE NAILS', amount: 42.5, pending: false, ...over,
});

test('a settled purchase maps to a staged row with the sign FLIPPED', () => {
  const r = shapePlaidTxn(tx(), 'bank1');
  assert.equal(r.id, 'plaid-txn_abc');
  assert.equal(r.importId, 'plaid:acc_1');
  assert.equal(r.bankacctId, 'bank1');
  assert.equal(r.date, '2026-06-12');
  assert.equal(r.desc, 'SQ *MUSE NAILS');
  assert.equal(r.amountCents, -4250);               // Plaid +42.50 (out) -> BO -4250
  assert.equal(r.status, 'pending');
  assert.deepEqual(r.source, { app: 'plaid', sourceId: 'txn_abc' });
  assert.equal(r.dedupHash, dedupHash({ date: '2026-06-12', desc: 'SQ *MUSE NAILS', amountCents: -4250 }));
});

test('a deposit (Plaid negative = money in) becomes a positive BO amount', () => {
  const r = shapePlaidTxn(tx({ transaction_id: 't2', amount: -1830.0, name: 'HELCIM PAYMENTS DEPOSIT' }), 'bank1');
  assert.equal(r.amountCents, 183000);
});

test('pending transactions are skipped (they can still change)', () => {
  assert.equal(shapePlaidTxn(tx({ pending: true }), 'bank1'), null);
});

test('whitespace in the name is collapsed', () => {
  const r = shapePlaidTxn(tx({ name: '  SQ   *MUSE\tNAILS ' }), 'bank1');
  assert.equal(r.desc, 'SQ *MUSE NAILS');
});

test('zero amount, blank name, bad date, or missing id are skipped', () => {
  assert.equal(shapePlaidTxn(tx({ amount: 0 }), 'bank1'), null);
  assert.equal(shapePlaidTxn(tx({ name: '   ' }), 'bank1'), null);
  assert.equal(shapePlaidTxn(tx({ date: 'nope' }), 'bank1'), null);
  assert.equal(shapePlaidTxn(tx({ transaction_id: '' }), 'bank1'), null);
});

// CREDIT CARDS (2026-07). Plaid uses the same "positive = money out of the account"
// convention for credit as for depository: a charge is positive, a payment/refund is
// negative. So the existing flip is already right — these lock that in, because a sign
// error here would post every charge as a refund on a live card. The expected values
// match how the books already record Muse Ink - 7978 from CSV (charge = card line
// NEGATIVE, e.g. T J MAXX -71.07 / Repairs +71.07).
test('a card CHARGE stays a charge (negative on the card line)', () => {
  const r = shapePlaidTxn(tx({ transaction_id: 'cc1', amount: 71.07, name: 'T J MAXX #1397' }), 'ba-ink');
  assert.equal(r.amountCents, -7107);
});

test('paying the card DOWN is positive (reduces what is owed)', () => {
  const r = shapePlaidTxn(tx({ transaction_id: 'cc2', amount: -500, name: 'AUTOMATIC PAYMENT - THANK YOU' }), 'ba-ink');
  assert.equal(r.amountCents, 50000);
});

test('a refund to the card is positive, like a payment', () => {
  const r = shapePlaidTxn(tx({ transaction_id: 'cc3', amount: -133.84, name: 'THE HOME DEPOT #1013 RETURN' }), 'ba-ink');
  assert.equal(r.amountCents, 13384);
});

test('batch skips pending, dedups within the batch and against known hashes', () => {
  const dupHash = dedupHash({ date: '2026-06-12', desc: 'SQ *MUSE NAILS', amountCents: -4250 });
  const txns = [
    tx(),                                                       // -> staged
    tx({ transaction_id: 'txn_abc_again' }),                    // same content -> in-batch dup
    tx({ transaction_id: 't3', amount: 10, name: 'PEN', pending: true }), // pending -> skip
    tx({ transaction_id: 't4', amount: 99, name: 'SUPPLY CO' }),          // -> staged
  ];
  const rows = shapePlaidBatch(txns, 'bank1', new Set());
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.id).sort(), ['plaid-t4', 'plaid-txn_abc']);

  // a CSV import already staged the same first txn -> Plaid drops it (cross-source)
  const rows2 = shapePlaidBatch(txns, 'bank1', new Set([dupHash]));
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].id, 'plaid-t4');
});
