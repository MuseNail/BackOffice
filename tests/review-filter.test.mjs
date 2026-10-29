import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeFilterCount } from '../js/app/lib/review-filter.js';

// The Review filter bar collapses behind a "Filters" button when the window is narrow.
// activeFilterCount drives the button's badge so the user can tell filters are on while
// they're hidden. It counts the COLLAPSIBLE dimensions only — the search box (q) stays
// visible next to the button, so it must NOT be counted here.
const DEFAULT = { dir: 'all', status: 'all', source: 'all', bank: 'all', sort: 'date-desc', amountMin: '', amountMax: '', from: '', to: '', q: '' };

test('activeFilterCount is 0 for the default filter', () => {
  assert.equal(activeFilterCount(DEFAULT), 0);
});

test('activeFilterCount counts each active collapsible dimension', () => {
  assert.equal(activeFilterCount({ ...DEFAULT, dir: 'in' }), 1);
  assert.equal(activeFilterCount({ ...DEFAULT, status: 'ready', source: 'client' }), 2);
  assert.equal(activeFilterCount({ ...DEFAULT, bank: 'chase-1', sort: 'amount-desc' }), 2);
  assert.equal(activeFilterCount({ ...DEFAULT, amountMin: 500, amountMax: 2000 }), 2);
  assert.equal(activeFilterCount({ ...DEFAULT, from: '2026-01-01', to: '2026-02-01' }), 2);
});

test('activeFilterCount ignores the search box (q is shown separately, not collapsed)', () => {
  assert.equal(activeFilterCount({ ...DEFAULT, q: 'tesla' }), 0);
  assert.equal(activeFilterCount({ ...DEFAULT, q: 'tesla', dir: 'out' }), 1);
});

test('activeFilterCount treats empty-string and null amounts as inactive', () => {
  assert.equal(activeFilterCount({ ...DEFAULT, amountMin: '', amountMax: null }), 0);
});
