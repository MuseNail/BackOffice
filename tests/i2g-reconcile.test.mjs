// node --test tests/i2g-reconcile.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePayouts } from '../js/app/lib/i2g-reconcile.js';

const payouts = [
  { id: 'p1', date: '2026-05-01', netToBankCents: 1000 },
  { id: 'p2', date: '2026-05-02', netToBankCents: 2000 }, // no deposit
  { id: 'p3', date: '2026-05-03', netToBankCents: 999 },  // no deposit
];
const deposits = [
  { id: 'd1', date: '2026-05-02', amountCents: 1000 }, // matches p1 (within window)
  { id: 'd2', date: '2026-05-02', amountCents: 5000 }, // other income
];

test('matches a payout to a same-amount deposit within the window', () => {
  const r = reconcilePayouts(payouts, deposits);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].payout.id, 'p1');
  assert.equal(r.matches[0].deposit.id, 'd1');
  assert.equal(r.unmatchedPayouts.length, 2);
  assert.deepEqual(r.unmatchedDeposits.map(d => d.id), ['d2']);
});

test('a deposit outside the date window does not match', () => {
  const r = reconcilePayouts(
    [{ id: 'p', date: '2026-05-01', netToBankCents: 1000 }],
    [{ id: 'd', date: '2026-06-01', amountCents: 1000 }], // ~31 days later
  );
  assert.equal(r.matches.length, 0);
  assert.equal(r.unmatchedPayouts.length, 1);
  assert.equal(r.unmatchedDeposits.length, 1);
});

test('two same-amount payouts take two distinct deposits (no double-grab)', () => {
  const r = reconcilePayouts(
    [{ id: 'pa', date: '2026-05-01', netToBankCents: 500 }, { id: 'pb', date: '2026-05-04', netToBankCents: 500 }],
    [{ id: 'da', date: '2026-05-01', amountCents: 500 }, { id: 'db', date: '2026-05-04', amountCents: 500 }],
  );
  assert.equal(r.matches.length, 2);
  // each payout took the closest-dated deposit
  assert.equal(r.matches.find(m => m.payout.id === 'pa').deposit.id, 'da');
  assert.equal(r.matches.find(m => m.payout.id === 'pb').deposit.id, 'db');
  assert.equal(r.unmatchedDeposits.length, 0);
});
