// node --test tests/teller-map.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeTellerTxn, shapeTellerBatch } from '../js/app/lib/teller-map.js';
import { dedupHash } from '../js/app/lib/csv.js';

const posted = (over = {}) => ({
  id: 'txn_abc', account_id: 'acc_1', date: '2026-06-12',
  description: 'SQ *MUSE NAILS', amount: '-42.50', status: 'posted', ...over,
});

test('a posted transaction maps to a staged row with the right shape + sign', () => {
  const r = shapeTellerTxn(posted(), 'bank1');
  assert.equal(r.id, 'tlr-txn_abc');
  assert.equal(r.importId, 'teller:acc_1');
  assert.equal(r.bankacctId, 'bank1');
  assert.equal(r.date, '2026-06-12');
  assert.equal(r.desc, 'SQ *MUSE NAILS');
  assert.equal(r.amountCents, -4250);               // negative = outflow, matches BO
  assert.equal(r.status, 'pending');
  assert.deepEqual(r.source, { app: 'teller', sourceId: 'txn_abc' });
  assert.equal(r.dedupHash, dedupHash({ date: '2026-06-12', desc: 'SQ *MUSE NAILS', amountCents: -4250 }));
});

test('a deposit (positive amount) stays positive', () => {
  const r = shapeTellerTxn(posted({ id: 't2', amount: '1830.00', description: 'HELCIM PAYMENTS DEPOSIT' }), 'bank1');
  assert.equal(r.amountCents, 183000);
});

test('pending transactions are skipped (they can still change)', () => {
  assert.equal(shapeTellerTxn(posted({ status: 'pending' }), 'bank1'), null);
});

test('whitespace in the description is collapsed', () => {
  const r = shapeTellerTxn(posted({ description: '  SQ   *MUSE\tNAILS ' }), 'bank1');
  assert.equal(r.desc, 'SQ *MUSE NAILS');
});

test('zero / missing amount, blank desc, or bad date are skipped', () => {
  assert.equal(shapeTellerTxn(posted({ amount: '0.00' }), 'bank1'), null);
  assert.equal(shapeTellerTxn(posted({ description: '   ' }), 'bank1'), null);
  assert.equal(shapeTellerTxn(posted({ date: 'nope' }), 'bank1'), null);
  assert.equal(shapeTellerTxn(posted({ id: '' }), 'bank1'), null);
});

test('batch skips pending, dedups within the batch and against known hashes', () => {
  const dupHash = dedupHash({ date: '2026-06-12', desc: 'SQ *MUSE NAILS', amountCents: -4250 });
  const txns = [
    posted(),                                              // -> staged
    posted({ id: 'txn_abc_again' }),                       // same content -> dropped (in-batch dup)
    posted({ id: 't3', amount: '-10.00', description: 'PEN', status: 'pending' }), // pending -> skip
    posted({ id: 't4', amount: '-99.00', description: 'SUPPLY CO' }),              // -> staged
  ];
  const rows = shapeTellerBatch(txns, 'bank1', new Set());
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.id).sort(), ['tlr-t4', 'tlr-txn_abc']);

  // a CSV import already staged the same first txn -> Teller drops it (cross-source)
  const rows2 = shapeTellerBatch(txns, 'bank1', new Set([dupHash]));
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].id, 'tlr-t4');
});
