// node --test tests/day.test.mjs
// The owner is in PST. Several date defaults derived "today"/"this month" in UTC via
// toISOString().slice(), which reads TOMORROW / NEXT MONTH from ~4-5pm Pacific — stamping a
// wrong calendar day on a manually-entered transaction. These helpers derive the calendar
// day/month from the VIEWING device's local zone instead. Pure + now-injectable so they test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { todayLocal, monthLocal } from '../js/app/lib/day.js';

// Constructed in LOCAL time (new Date(y, m0, d, h, min)), so these hold on any machine zone.
test('todayLocal returns the local calendar day, zero-padded', () => {
  assert.equal(todayLocal(new Date(2026, 6, 18, 23, 30)), '2026-07-18'); // 11:30pm local Jul 18
  assert.equal(todayLocal(new Date(2026, 0, 3, 9, 0)), '2026-01-03');    // single-digit month+day padded
});

test('monthLocal returns the local YYYY-MM', () => {
  assert.equal(monthLocal(new Date(2026, 6, 18, 23, 30)), '2026-07');
  assert.equal(monthLocal(new Date(2026, 11, 31, 20, 0)), '2026-12');
});

// The bug this replaces: west of UTC, a late-evening local instant's UTC slice is already
// TOMORROW. Guarded on being behind UTC so the assertion is meaningful on the owner's PST
// machine (and any west-of-UTC CI) and skipped elsewhere.
test('todayLocal is the LOCAL day, not the UTC slice (west of UTC)', () => {
  const evening = new Date(2026, 6, 18, 23, 30); // 11:30pm local
  if (evening.getTimezoneOffset() > 0) {         // positive offset = behind UTC = west
    assert.notEqual(todayLocal(evening), evening.toISOString().slice(0, 10),
      'todayLocal must not equal the UTC-sliced day for a late-evening local instant');
    assert.equal(todayLocal(evening), '2026-07-18');
  }
});
