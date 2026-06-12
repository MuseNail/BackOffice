// node --test tests/musesync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { MUSE_SYNC_TYPES, syncRowId, shapeSyncRow, shapeSyncBatch } from '../js/app/lib/musesync.js';
import { simpleTxn, validateTxn } from '../js/app/lib/posting.js';

const row = (over = {}) => ({
  sourceId: '2026-06-12:sales_cash', type: 'sales_cash', date: '2026-06-12',
  amountCents: 41250, desc: 'Muse — Sales (cash) Jun 12', ...over,
});

test('syncRowId is deterministic and key-safe', () => {
  assert.equal(syncRowId('musenail', '2026-06-12:sales_cash'), 'sync-musenail-2026-06-12:sales_cash');
  assert.equal(syncRowId('musenail', 'a b/c'), 'sync-musenail-a-b-c');
  assert.equal(syncRowId('musenail', 'x'), syncRowId('musenail', 'x'));
});

test('shapeSyncRow keeps "in" rows positive and flips "out" rows negative', () => {
  const cash = shapeSyncRow('musenail', row()).row;
  assert.equal(cash.amountCents, 41250);
  assert.equal(cash.status, 'pending');
  assert.equal(cash.importId, 'sync:musenail');
  assert.deepEqual(cash.source, { app: 'musenail', sourceId: '2026-06-12:sales_cash' });
  const pay = shapeSyncRow('musenail', row({ type: 'payroll', sourceId: '2026-06-12:payroll' })).row;
  assert.equal(pay.amountCents, -41250);
  // gift_sold is money IN (charged on top of the bill) crediting the liability
  const sold = shapeSyncRow('musenail', row({ type: 'gift_sold', sourceId: '2026-06-12:gift_sold' })).row;
  assert.equal(sold.amountCents, 41250);
});

test('shapeSyncRow rejects every malformed field', () => {
  assert.ok(shapeSyncRow('Mu se', row()).error, 'bad sourceApp');
  assert.ok(shapeSyncRow('musenail', row({ type: 'tips_jar' })).error, 'unknown type');
  assert.ok(shapeSyncRow('musenail', row({ date: 'Jun 12' })).error, 'bad date');
  assert.ok(shapeSyncRow('musenail', row({ amountCents: 412.5 })).error, 'float cents');
  assert.ok(shapeSyncRow('musenail', row({ amountCents: 0 })).error, 'zero');
  assert.ok(shapeSyncRow('musenail', row({ amountCents: -100 })).error, 'negative (dir comes from type)');
  assert.ok(shapeSyncRow('musenail', row({ sourceId: '' })).error, 'no sourceId');
  assert.ok(shapeSyncRow('musenail', row({ sourceId: 'x'.repeat(81) })).error, 'sourceId too long');
});

test('shapeSyncBatch validates the whole batch and rejects in-batch duplicates', () => {
  const ok = shapeSyncBatch('musenail', [row(), row({ type: 'gift_sold', sourceId: '2026-06-12:gift_sold' })]);
  assert.equal(ok.rows.length, 2);
  assert.ok(shapeSyncBatch('musenail', []).error, 'empty');
  assert.ok(shapeSyncBatch('musenail', [row(), row()]).error, 'duplicate sourceId');
  assert.ok(shapeSyncBatch('musenail', Array.from({ length: 201 }, (_, i) => row({ sourceId: 's' + i }))).error, 'over 200');
});

test('every sync type posts a balanced txn through simpleTxn (the Review approval path)', () => {
  const accounts = new Map([
    ['bal', { id: 'bal', name: 'Balancing', type: 'asset', active: true }],
    ['cat', { id: 'cat', name: 'Category', type: 'income', active: true }],
  ]);
  for (const type of Object.keys(MUSE_SYNC_TYPES)) {
    const r = shapeSyncRow('musenail', row({ type, sourceId: 'd:' + type })).row;
    const txn = simpleTxn({
      id: 't-' + r.id, date: r.date, amountCents: Math.abs(r.amountCents),
      direction: r.amountCents < 0 ? 'out' : 'in',
      bankAccountId: 'bal', categoryAccountId: 'cat',
    });
    const v = validateTxn(txn, { accountsById: accounts, locks: new Set() });
    assert.equal(v.ok, true, `${type}: ${v.error || 'ok'}`);
    assert.equal(txn.lines[0].amountCents + txn.lines[1].amountCents, 0);
    // direction semantics: in = balancing debited (+), out = balancing credited (−)
    assert.equal(txn.lines[0].amountCents > 0, MUSE_SYNC_TYPES[type].dir === 'in', type);
  }
});
