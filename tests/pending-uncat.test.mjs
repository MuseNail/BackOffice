// node --test tests/pending-uncat.test.mjs
// Provisional income/expense from items still in Review (status 'pending'), bucketed by bank-feed
// sign: money-in → income, money-out → expense. Date filter mirrors activityByAccount (posting.js):
// a null bound is unbounded; a set bound is inclusive; an undated row is only counted when unbounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingUncategorized } from '../js/app/lib/pending-uncat.js';

const S = (over) => ({ status: 'pending', amountCents: -100, date: '2026-03-10', ...over });

test('buckets by sign: money-in → inc, money-out → exp (both positive)', () => {
  const rows = [S({ amountCents: 5000, date: '2026-03-05' }), S({ amountCents: -3000, date: '2026-03-06' })];
  assert.deepEqual(pendingUncategorized(rows, {}), { inc: 5000, exp: 3000, count: 2 });
});

test('only status pending counts', () => {
  const rows = [S({ amountCents: 100 }), S({ amountCents: 200, status: 'approved' }), S({ amountCents: 400, status: 'skipped' }), S({ amountCents: 800, status: 'deleted' })];
  assert.deepEqual(pendingUncategorized(rows, {}), { inc: 100, exp: 0, count: 1 });
});

test('amountCents 0 / missing is skipped', () => {
  const rows = [S({ amountCents: 0 }), S({ amountCents: undefined }), S({ amountCents: 250 })];
  assert.deepEqual(pendingUncategorized(rows, {}), { inc: 250, exp: 0, count: 1 });
});

test('inclusive date bounds; null bound is unbounded (mirrors activityByAccount)', () => {
  const rows = [
    S({ amountCents: 100, date: '2026-02-28' }),  // before
    S({ amountCents: 200, date: '2026-03-01' }),  // on from
    S({ amountCents: 400, date: '2026-03-31' }),  // on to
    S({ amountCents: 800, date: '2026-04-01' }),  // after
  ];
  assert.deepEqual(pendingUncategorized(rows, { from: '2026-03-01', to: '2026-03-31' }), { inc: 600, exp: 0, count: 2 });
  assert.deepEqual(pendingUncategorized(rows, { from: '2026-03-01' }), { inc: 1400, exp: 0, count: 3 }); // to unbounded
  assert.deepEqual(pendingUncategorized(rows, {}), { inc: 1500, exp: 0, count: 4 });                     // both unbounded
});

test('undated row: excluded when a bound is set, included only when fully unbounded', () => {
  const rows = [S({ amountCents: 900, date: '' }), S({ amountCents: 100, date: '2026-03-10' })];
  assert.deepEqual(pendingUncategorized(rows, { from: '2026-03-01', to: '2026-03-31' }), { inc: 100, exp: 0, count: 1 });
  assert.deepEqual(pendingUncategorized(rows, {}), { inc: 1000, exp: 0, count: 2 });
});

test('empty / nullish input is safe', () => {
  assert.deepEqual(pendingUncategorized([], {}), { inc: 0, exp: 0, count: 0 });
  assert.deepEqual(pendingUncategorized(undefined, {}), { inc: 0, exp: 0, count: 0 });
  assert.deepEqual(pendingUncategorized([null, undefined], {}), { inc: 0, exp: 0, count: 0 });
});
