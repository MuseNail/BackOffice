// node --test tests/vendor-attribution.test.mjs
// Per-split vendors (v0.71.11): a transaction's activity can be split across accounts AND vendors.
// Vendor reporting credits each EXPENSE line to its own vendor (falling back to the txn-level vendor),
// and a legacy txn matched only by payee, with no vendor tag anywhere, still attributes its WHOLE
// expense (never silently drop to $0). v3 (income→vendor NET): an INCOME line counts toward a vendor
// ONLY when it carries its OWN explicit vendorId — never the txn-level fallback, never payeeMatch — so
// existing deposits tagged only at the txn level (e.g. a "Square" card deposit) never retroactively net.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineVendorId, txnHasVendor, hasAnyVendor, vendorLinesOf, activityForVendor, remapVendor } from '../js/app/lib/vendor-attribution.js';

const EXP = new Set(['exp-a', 'exp-b', 'exp-c']);   // expense account ids
const INC = new Set(['inc-a', 'inc-b']);            // income account ids
// bank line first (signed), then category lines — the real shape.

test('lineVendorId prefers the line vendor, then the txn vendor, else null', () => {
  assert.equal(lineVendorId({ vendorId: 'v-b' }, { vendorId: 'v-a' }), 'v-b');
  assert.equal(lineVendorId({}, { vendorId: 'v-a' }), 'v-a');
  assert.equal(lineVendorId({}, {}), null);
});

test('a single-vendor txn (top-level vendor, no line vendors) attributes its whole expense', () => {
  const t = { vendorId: 'v-a', lines: [{ accountId: 'bank', amountCents: -5000 }, { accountId: 'exp-a', amountCents: 5000 }] };
  assert.equal(activityForVendor(t, 'v-a', EXP, INC), 5000);
  assert.equal(activityForVendor(t, 'v-b', EXP, INC), 0);
  assert.equal(txnHasVendor(t, 'v-a'), true);
});

test('a two-vendor split credits each vendor only its own line, and the sum reconciles', () => {
  const t = { lines: [
    { accountId: 'bank', amountCents: -10000 },
    { accountId: 'exp-a', amountCents: 6000, vendorId: 'v-a' },
    { accountId: 'exp-b', amountCents: 4000, vendorId: 'v-b' },
  ] };
  assert.equal(activityForVendor(t, 'v-a', EXP, INC), 6000);
  assert.equal(activityForVendor(t, 'v-b', EXP, INC), 4000);
  assert.equal(activityForVendor(t, 'v-a', EXP, INC) + activityForVendor(t, 'v-b', EXP, INC), 10000, 'no money lost or double-counted');
  assert.ok(txnHasVendor(t, 'v-a') && txnHasVendor(t, 'v-b'));
});

test('a MIXED expense split: an untagged line falls back to the txn-level vendor', () => {
  const t = { vendorId: 'v-a', lines: [
    { accountId: 'bank', amountCents: -10000 },
    { accountId: 'exp-a', amountCents: 3000 },                    // untagged → falls back to v-a
    { accountId: 'exp-b', amountCents: 3000, vendorId: 'v-b' },
    { accountId: 'exp-c', amountCents: 4000 },                    // untagged → v-a
  ] };
  assert.equal(activityForVendor(t, 'v-a', EXP, INC), 7000, 'both untagged expense lines credit the txn vendor');
  assert.equal(activityForVendor(t, 'v-b', EXP, INC), 3000);
  assert.equal(activityForVendor(t, 'v-a', EXP, INC) + activityForVendor(t, 'v-b', EXP, INC), 10000);
});

test('a LEGACY untagged txn matched only by payee attributes its WHOLE expense (not $0)', () => {
  const t = { lines: [{ accountId: 'bank', amountCents: -4200 }, { accountId: 'exp-a', amountCents: 4200 }] };
  assert.equal(hasAnyVendor(t), false);
  assert.equal(activityForVendor(t, 'v-x', EXP, INC), 0);
  assert.equal(activityForVendor(t, 'v-x', EXP, INC, { payeeMatch: true }), 4200);
});

test('payeeMatch does NOT override a txn that DOES carry a vendor somewhere', () => {
  const t = { vendorId: 'v-a', lines: [{ accountId: 'bank', amountCents: -100 }, { accountId: 'exp-a', amountCents: 100 }] };
  assert.equal(activityForVendor(t, 'v-x', EXP, INC, { payeeMatch: true }), 0);
  assert.equal(activityForVendor(t, 'v-a', EXP, INC, { payeeMatch: true }), 100);
});

test('only category lines count — a transfer/asset line is never attributed', () => {
  const t = { vendorId: 'v-a', lines: [
    { accountId: 'bank', amountCents: -5000 },
    { accountId: 'exp-a', amountCents: 2000 },
    { accountId: 'asset-x', amountCents: 3000 },   // not an expense or income id
  ] };
  assert.equal(activityForVendor(t, 'v-a', EXP, INC), 2000);
});

// ── v3: income → vendor, NET, explicit-line-only ──────────────────────────────
test('income attributes to a vendor ONLY via an explicit per-line vendorId — NEVER the txn-level fallback', () => {
  // A deposit tagged at the TXN level to v-a (a "Square" card deposit) must not net its income —
  // this is the whole reason existing vendor totals stay unchanged after the change.
  const t = { vendorId: 'v-a', lines: [
    { accountId: 'bank', amountCents: 5000 },
    { accountId: 'inc-a', amountCents: -5000 },   // no per-line vendor → NOT attributed to v-a
  ] };
  assert.equal(activityForVendor(t, 'v-a', EXP, INC), 0, 'txn-level vendor never nets existing income (back-compat)');
});

test('income nets to a vendor when the income LINE carries its own vendorId (negative = money received)', () => {
  const t = { lines: [{ accountId: 'bank', amountCents: 5000 }, { accountId: 'inc-a', amountCents: -5000, vendorId: 'v-a' }] };
  assert.equal(activityForVendor(t, 'v-a', EXP, INC), -5000, 'a refund credited to the vendor reduces net paid');
});

test('a split credit across vendors nets each vendor its own income line', () => {
  const t = { lines: [
    { accountId: 'bank', amountCents: 10000 },
    { accountId: 'inc-a', amountCents: -6000, vendorId: 'v-a' },
    { accountId: 'inc-a', amountCents: -4000, vendorId: 'v-b' },
  ] };
  assert.equal(activityForVendor(t, 'v-a', EXP, INC), -6000);
  assert.equal(activityForVendor(t, 'v-b', EXP, INC), -4000);
});

test('expense + income to the same vendor NET (money out minus money in)', () => {
  const t = { lines: [
    { accountId: 'bank', amountCents: -2000 },
    { accountId: 'exp-a', amountCents: 5000, vendorId: 'v-a' },
    { accountId: 'inc-a', amountCents: -3000, vendorId: 'v-a' },
  ] };
  assert.equal(activityForVendor(t, 'v-a', EXP, INC), 2000, 'net = 5000 paid − 3000 received');
});

test('payeeMatch NEVER pulls income into a vendor (legacy untagged fee-split deposit, expense-only)', () => {
  // bank +net, income −gross, fee +expense, NO vendor tag but a payee that matches a vendor rule.
  const t = { lines: [
    { accountId: 'bank', amountCents: 9700 },
    { accountId: 'inc-a', amountCents: -10000 },
    { accountId: 'exp-a', amountCents: 300 },
  ] };
  assert.equal(hasAnyVendor(t), false);
  assert.equal(activityForVendor(t, 'v-x', EXP, INC, { payeeMatch: true }), 300, 'only the fee expense — never the −10000 gross income');
});

test('vendorLinesOf returns the actual line objects for callers that need them (IIF NAME/MEMO)', () => {
  const t = { lines: [{ accountId: 'bank', amountCents: -100 }, { accountId: 'exp-a', amountCents: 100, vendorId: 'v-a', note: 'lunch' }] };
  const lines = vendorLinesOf(t, 'v-a', EXP, INC);
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
  assert.deepEqual(vendorLinesOf(null, 'v', EXP, INC), []);
});
