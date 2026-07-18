// node --test tests/vendor-attribution.test.mjs
// Per-split vendors (v0.71.11): a transaction's expense can be split across accounts AND
// vendors. Vendor reporting must credit each line to its own vendor (falling back to the
// txn-level vendor), and — critically — a legacy txn matched only by payee, with no vendor
// tag anywhere, must still attribute its WHOLE amount (never silently drop to $0). ONE
// resolution shared by txnsForVendor membership and the amount, pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineVendorId, txnHasVendor, hasAnyVendor, vendorLinesOf, expenseForVendor, remapVendor } from '../js/app/lib/vendor-attribution.js';

const EXP = new Set(['exp-a', 'exp-b', 'exp-c']);   // expense account ids
// bank line first (negative), then category/expense lines (positive) — the real shape.

test('lineVendorId prefers the line vendor, then the txn vendor, else null', () => {
  assert.equal(lineVendorId({ vendorId: 'v-b' }, { vendorId: 'v-a' }), 'v-b');
  assert.equal(lineVendorId({}, { vendorId: 'v-a' }), 'v-a');
  assert.equal(lineVendorId({}, {}), null);
});

test('a single-vendor txn (top-level vendor, no line vendors) attributes its whole expense', () => {
  const t = { vendorId: 'v-a', lines: [{ accountId: 'bank', amountCents: -5000 }, { accountId: 'exp-a', amountCents: 5000 }] };
  assert.equal(expenseForVendor(t, 'v-a', EXP), 5000);
  assert.equal(expenseForVendor(t, 'v-b', EXP), 0);
  assert.equal(txnHasVendor(t, 'v-a'), true);
});

test('a two-vendor split credits each vendor only its own line, and the sum reconciles', () => {
  const t = { lines: [
    { accountId: 'bank', amountCents: -10000 },
    { accountId: 'exp-a', amountCents: 6000, vendorId: 'v-a' },
    { accountId: 'exp-b', amountCents: 4000, vendorId: 'v-b' },
  ] };
  assert.equal(expenseForVendor(t, 'v-a', EXP), 6000);
  assert.equal(expenseForVendor(t, 'v-b', EXP), 4000);
  assert.equal(expenseForVendor(t, 'v-a', EXP) + expenseForVendor(t, 'v-b', EXP), 10000, 'no money lost or double-counted');
  assert.ok(txnHasVendor(t, 'v-a') && txnHasVendor(t, 'v-b'));
});

test('a MIXED split: an untagged line falls back to the txn-level vendor', () => {
  const t = { vendorId: 'v-a', lines: [
    { accountId: 'bank', amountCents: -10000 },
    { accountId: 'exp-a', amountCents: 3000 },                    // untagged → falls back to v-a
    { accountId: 'exp-b', amountCents: 3000, vendorId: 'v-b' },
    { accountId: 'exp-c', amountCents: 4000 },                    // untagged → v-a
  ] };
  assert.equal(expenseForVendor(t, 'v-a', EXP), 7000, 'both untagged lines credit the txn vendor');
  assert.equal(expenseForVendor(t, 'v-b', EXP), 3000);
  assert.equal(expenseForVendor(t, 'v-a', EXP) + expenseForVendor(t, 'v-b', EXP), 10000);
});

test('a LEGACY untagged txn matched only by payee attributes its WHOLE expense (not $0)', () => {
  const t = { lines: [{ accountId: 'bank', amountCents: -4200 }, { accountId: 'exp-a', amountCents: 4200 }] };
  assert.equal(hasAnyVendor(t), false);
  // Without the payee-match flag it would be 0 (no line resolves to v-x)…
  assert.equal(expenseForVendor(t, 'v-x', EXP), 0);
  // …but a payee-matched legacy txn credits all its expense lines to that vendor.
  assert.equal(expenseForVendor(t, 'v-x', EXP, { payeeMatch: true }), 4200);
});

test('payeeMatch does NOT override a txn that DOES carry a vendor somewhere', () => {
  const t = { vendorId: 'v-a', lines: [{ accountId: 'bank', amountCents: -100 }, { accountId: 'exp-a', amountCents: 100 }] };
  // Even if a caller passes payeeMatch, a txn with a real vendor tag attributes by the tag.
  assert.equal(expenseForVendor(t, 'v-x', EXP, { payeeMatch: true }), 0);
  assert.equal(expenseForVendor(t, 'v-a', EXP, { payeeMatch: true }), 100);
});

test('only expense lines count — a transfer/asset line is never attributed', () => {
  const t = { vendorId: 'v-a', lines: [
    { accountId: 'bank', amountCents: -5000 },
    { accountId: 'exp-a', amountCents: 2000 },
    { accountId: 'asset-x', amountCents: 3000 },   // not an expense id
  ] };
  assert.equal(expenseForVendor(t, 'v-a', EXP), 2000);
});

test('vendorLinesOf returns the actual line objects for callers that need them (IIF NAME/MEMO)', () => {
  const t = { lines: [{ accountId: 'bank', amountCents: -100 }, { accountId: 'exp-a', amountCents: 100, vendorId: 'v-a', note: 'lunch' }] };
  const lines = vendorLinesOf(t, 'v-a', EXP);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].note, 'lunch');
});

test('remapVendor rewrites both the top-level AND a line-only vendor tag (merge must not orphan a line)', () => {
  const t = { vendorId: 'v-from', lines: [
    { accountId: 'bank', amountCents: -100 },
    { accountId: 'exp-a', amountCents: 60, vendorId: 'v-from' },
    { accountId: 'exp-b', amountCents: 40, vendorId: 'v-other' },
  ] };
  const r = remapVendor(t, 'v-from', 'v-to');
  assert.equal(r.vendorId, 'v-to');
  assert.equal(r.lines[1].vendorId, 'v-to');
  assert.equal(r.lines[2].vendorId, 'v-other', 'an unrelated line vendor is untouched');
});

test('remapVendor catches a txn that references the source ONLY on a line', () => {
  const t = { vendorId: 'v-other', lines: [{ accountId: 'bank', amountCents: -50 }, { accountId: 'exp-a', amountCents: 50, vendorId: 'v-from' }] };
  assert.equal(txnHasVendor(t, 'v-from'), true, 'membership must see the line-only ref');
  const r = remapVendor(t, 'v-from', 'v-to');
  assert.equal(r.vendorId, 'v-other');
  assert.equal(r.lines[1].vendorId, 'v-to');
});

test('helpers tolerate junk', () => {
  assert.equal(hasAnyVendor(null), false);
  assert.equal(txnHasVendor(null, 'v'), false);
  assert.deepEqual(vendorLinesOf(null, 'v', EXP), []);
});
