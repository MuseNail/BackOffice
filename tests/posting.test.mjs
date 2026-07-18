// node --test tests/posting.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTxn, simpleTxn, voidTxn, accountBalance, activityByAccount, profitAndLoss, periodKey, invoiceExpensesTotal, splitParts } from '../js/app/lib/posting.js';
import { parseMoney, fmtCents } from '../js/app/lib/money.js';

const accounts = new Map([
  ['checking', { id: 'checking', name: 'Checking', type: 'asset', active: true }],
  ['income', { id: 'income', name: 'Service income', type: 'income', active: true }],
  ['supplies', { id: 'supplies', name: 'Supplies', type: 'expense', active: true }],
  ['old', { id: 'old', name: 'Old', type: 'expense', active: false }],
]);
const ctx = { accountsById: accounts, locks: new Set(['2026-01']) };

// splitParts decides whether the edit-modal split editor may open. A mixed-sign one-bank txn
// (fee split / journal) must NOT be splittable, or the editor blocks editing and can flip signs.
const isBank = (id) => id === 'checking';
test('splitParts: a simple 2-line expense is splittable', () => {
  const r = splitParts([{ accountId: 'checking', amountCents: -5000 }, { accountId: 'supplies', amountCents: 5000 }], isBank);
  assert.equal(r.canSplit, true);
  assert.equal(r.bankLine.amountCents, -5000);
  assert.equal(r.catLines.length, 1);
});
test('splitParts: an already-split uniform-sign txn is splittable (re-editable)', () => {
  const r = splitParts([{ accountId: 'checking', amountCents: -10000 }, { accountId: 'supplies', amountCents: 6000 }, { accountId: 'income', amountCents: 4000 }], isBank);
  assert.equal(r.canSplit, true);
  assert.equal(r.catLines.length, 2);
});
test('splitParts: a fee-split deposit (mixed-sign category lines) is NOT splittable', () => {
  // bank +net, income −gross, fee +feeCents — the % Fee tool's shape.
  const r = splitParts([{ accountId: 'checking', amountCents: 9700 }, { accountId: 'income', amountCents: -10000 }, { accountId: 'fees', amountCents: 300 }], isBank);
  assert.equal(r.canSplit, false, 'a mixed-sign fee split must stay on the metadata-only edit path');
});
test('splitParts: a transfer (two bank lines) is NOT splittable', () => {
  const r = splitParts([{ accountId: 'checking', amountCents: -5000 }, { accountId: 'checking', amountCents: 5000 }], isBank);
  assert.equal(r.canSplit, false);
  assert.equal(r.bankLine, null);
});

test('validateTxn accepts a split whose lines carry a per-line vendorId and note', () => {
  const t = { id: 't-split', date: '2026-06-12', status: 'posted', lines: [
    { accountId: 'checking', amountCents: -10000 },
    { accountId: 'supplies', amountCents: 6000, vendorId: 'v-a', note: 'paper' },
    { accountId: 'supplies', amountCents: 4000, vendorId: 'v-b' },
  ] };
  assert.equal(validateTxn(t, ctx).ok, true, 'extra per-line fields must not break validation');
});

test('simpleTxn builds balanced entries both directions', () => {
  const out = simpleTxn({ id: 't1', date: '2026-06-12', amountCents: 8417, direction: 'out', bankAccountId: 'checking', categoryAccountId: 'supplies' });
  assert.deepEqual(out.lines, [{ accountId: 'checking', amountCents: -8417 }, { accountId: 'supplies', amountCents: 8417 }]);
  const inn = simpleTxn({ id: 't2', date: '2026-06-12', amountCents: 194620, direction: 'in', bankAccountId: 'checking', categoryAccountId: 'income' });
  assert.deepEqual(inn.lines, [{ accountId: 'checking', amountCents: 194620 }, { accountId: 'income', amountCents: -194620 }]);
  assert.equal(validateTxn(out, ctx).ok, true);
  assert.equal(validateTxn(inn, ctx).ok, true);
});

test('validateTxn rejects every invariant breach', () => {
  const good = simpleTxn({ id: 't', date: '2026-06-12', amountCents: 100, direction: 'out', bankAccountId: 'checking', categoryAccountId: 'supplies' });
  assert.equal(validateTxn({ ...good, date: 'June 12' }, ctx).ok, false, 'bad date');
  assert.equal(validateTxn({ ...good, status: 'pending' }, ctx).ok, false, 'bad status');
  assert.equal(validateTxn({ ...good, lines: [good.lines[0]] }, ctx).ok, false, 'one line');
  assert.equal(validateTxn({ ...good, lines: [{ accountId: 'checking', amountCents: -100 }, { accountId: 'supplies', amountCents: 99 }] }, ctx).ok, false, 'unbalanced');
  assert.equal(validateTxn({ ...good, lines: [{ accountId: 'checking', amountCents: -100.5 }, { accountId: 'supplies', amountCents: 100.5 }] }, ctx).ok, false, 'float cents');
  assert.equal(validateTxn({ ...good, lines: [{ accountId: 'checking', amountCents: 0 }, { accountId: 'supplies', amountCents: 0 }] }, ctx).ok, false, 'zero lines');
  assert.equal(validateTxn({ ...good, lines: [{ accountId: 'ghost', amountCents: -100 }, { accountId: 'supplies', amountCents: 100 }] }, ctx).ok, false, 'unknown account');
  assert.equal(validateTxn({ ...good, lines: [{ accountId: 'old', amountCents: -100 }, { accountId: 'supplies', amountCents: 100 }] }, ctx).ok, false, 'archived account');
  assert.equal(validateTxn({ ...good, date: '2026-01-15' }, ctx).ok, false, 'locked period');
  assert.equal(validateTxn({ ...good, date: '2026-01-15', status: 'staged' }, ctx).ok, true, 'staging into a locked period is fine — posting is blocked');
});

test('balances and P&L tie, and void removes a txn from both', () => {
  const txns = [
    simpleTxn({ id: 'a', date: '2026-06-01', amountCents: 200000, direction: 'in', bankAccountId: 'checking', categoryAccountId: 'income' }),
    simpleTxn({ id: 'b', date: '2026-06-02', amountCents: 50000, direction: 'out', bankAccountId: 'checking', categoryAccountId: 'supplies' }),
    simpleTxn({ id: 'c', date: '2026-05-20', amountCents: 99900, direction: 'in', bankAccountId: 'checking', categoryAccountId: 'income' }),
  ];
  assert.equal(accountBalance(txns, 'checking'), 200000 - 50000 + 99900);
  assert.equal(accountBalance(txns, 'checking', { from: '2026-06-01', to: '2026-06-30' }), 150000);

  const pl = profitAndLoss(txns, accounts, { from: '2026-06-01', to: '2026-06-30' });
  assert.equal(pl.incomeTotal, 200000);
  assert.equal(pl.expenseTotal, 50000);
  assert.equal(pl.netCents, 150000);

  const voided = txns.map(t => (t.id === 'b' ? voidTxn(t, 1749700000000) : t));
  assert.equal(voided[1].status, 'void');
  assert.equal(voided[1].lines.length, 2, 'void keeps the lines — append-only');
  assert.equal(accountBalance(voided, 'checking', { from: '2026-06-01' }), 200000);
  assert.equal(profitAndLoss(voided, accounts, { from: '2026-06-01' }).expenseTotal, 0);
});

test('staged txns never count toward balances', () => {
  const t = simpleTxn({ id: 's', date: '2026-06-05', amountCents: 1, direction: 'out', bankAccountId: 'checking', categoryAccountId: 'supplies' });
  t.status = 'staged';
  assert.equal(accountBalance([t], 'checking'), 0);
  assert.equal(activityByAccount([t]).size, 0);
});

test('periodKey', () => { assert.equal(periodKey('2026-06-12'), '2026-06'); });

test('parseMoney handles the real-world inputs and rejects garbage', () => {
  assert.equal(parseMoney('1,234.56'), 123456);
  assert.equal(parseMoney('$12'), 1200);
  assert.equal(parseMoney('12.5'), 1250);
  assert.equal(parseMoney('-3'), -300);
  assert.equal(parseMoney('0.07'), 7);
  assert.equal(parseMoney(' $ 1,000 '), 100000);
  assert.equal(parseMoney('12.345'), null);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('.'), null);
});

test('fmtCents round-trips', () => {
  assert.equal(fmtCents(123456), '$1,234.56');
  assert.equal(fmtCents(-8417), '−$84.17');
  assert.equal(fmtCents(150000, { sign: true }), '+$1,500.00');
});

test('invoiceExpensesTotal sums expense + cogs lines tagged to one invoice, posted only', () => {
  const accts = new Map([
    ['checking', { id: 'checking', type: 'asset' }],
    ['supplies', { id: 'supplies', type: 'expense' }],
    ['cogs', { id: 'cogs', type: 'cogs' }],
    ['income', { id: 'income', type: 'income' }],
  ]);
  const T = (id, invoiceId, lines, status = 'posted') => ({ id, date: '2026-03-01', status, invoiceId, lines });
  const txns = [
    T('a', 'inv1', [{ accountId: 'checking', amountCents: -5000 }, { accountId: 'supplies', amountCents: 5000 }]),
    T('b', 'inv1', [{ accountId: 'checking', amountCents: -2000 }, { accountId: 'cogs', amountCents: 2000 }]),
    T('c', 'inv2', [{ accountId: 'checking', amountCents: -9999 }, { accountId: 'supplies', amountCents: 9999 }]), // other invoice
    T('d', 'inv1', [{ accountId: 'checking', amountCents: -1000 }, { accountId: 'supplies', amountCents: 1000 }], 'void'), // void excluded
    T('e', undefined, [{ accountId: 'checking', amountCents: -3000 }, { accountId: 'supplies', amountCents: 3000 }]), // untagged
    T('f', 'inv1', [{ accountId: 'checking', amountCents: 7000 }, { accountId: 'income', amountCents: -7000 }]), // income line, not an expense
  ];
  assert.equal(invoiceExpensesTotal(txns, accts, 'inv1'), 7000); // 5000 + 2000 only
  assert.equal(invoiceExpensesTotal(txns, accts, 'inv2'), 9999);
  assert.equal(invoiceExpensesTotal(txns, accts, 'nope'), 0);
});
