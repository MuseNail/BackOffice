// node --test tests/deposits.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDeposits } from '../js/app/lib/deposits-compare.js';

const mMuse = (obj) => new Map(Object.entries(obj).map(([d, v]) => [d, typeof v === 'number' ? { cents: v, pending: false } : v]));
const mHelcim = (obj) => new Map(Object.entries(obj));
const byDate = (rows) => Object.fromEntries(rows.map(r => [r.date, r]));

test('learns the surcharge rate and flags only the day that does not fit', () => {
  const muse = mMuse({
    '2026-06-10': 100000,            // surcharge 3.5% → OK
    '2026-06-11': 200000,            // surcharge 3.5% → OK
    '2026-06-12': 50000,             // surcharge 1.0% → off-band
  });
  const helcim = mHelcim({
    '2026-06-10': 103500,
    '2026-06-11': 207000,
    '2026-06-12': 50500,
  });
  const r = summarizeDeposits(muse, helcim);
  assert.equal(r.rate, 0.035);                         // median of [0.035,0.035,0.01]
  const d = byDate(r.rows);
  assert.equal(d['2026-06-10'].flag, null);
  assert.equal(d['2026-06-11'].flag, null);
  assert.deepEqual(d['2026-06-12'].flag, { cls: 'amber', text: 'Surcharge off' });
  assert.equal(r.flagCount, 1);
  assert.equal(r.totMuse, 350000);
  assert.equal(r.totHelcim, 361000);
});

test('flags missing-side days and a Helcim-under-Muse day', () => {
  const muse = mMuse({
    '2026-06-10': 100000,                       // matched below → OK
    '2026-06-13': { cents: 80000, pending: true }, // no Helcim → amber + pending
    '2026-06-15': 40000,                        // Helcim under Muse → red
  });
  const helcim = mHelcim({
    '2026-06-10': 103500,
    '2026-06-14': 30000,                        // no Muse → red
    '2026-06-15': 39000,
  });
  const r = summarizeDeposits(muse, helcim);
  const d = byDate(r.rows);
  assert.equal(d['2026-06-10'].flag, null);
  assert.deepEqual(d['2026-06-13'].flag, { cls: 'amber', text: 'No Helcim activity' });
  assert.equal(d['2026-06-13'].musePending, true);
  assert.deepEqual(d['2026-06-14'].flag, { cls: 'red', text: 'Not in Muse' });
  assert.equal(d['2026-06-14'].hasMuse, false);
  assert.deepEqual(d['2026-06-15'].flag, { cls: 'red', text: 'Helcim under Muse' });
  assert.equal(r.flagCount, 3);
});

test('no overlapping days → rate is null and nothing crashes', () => {
  const r = summarizeDeposits(mMuse({ '2026-06-10': 50000 }), mHelcim({ '2026-06-12': 20000 }));
  assert.equal(r.rate, null);
  assert.equal(r.rows.length, 2);
  assert.equal(r.flagCount, 2); // one amber (no Helcim), one red (not in Muse)
});

test('empty inputs → zeroed summary', () => {
  const r = summarizeDeposits(new Map(), new Map());
  assert.deepEqual(r, { rows: [], rate: null, totMuse: 0, totHelcim: 0, flagCount: 0 });
});
