// node --test tests/orphan-recovery.test.mjs
// Layer 1 of the wrong-business-writes fix: the app must NEVER guess an un-tagged write's
// business (a wrong guess posted a $4k TIE txn into Muse's books). These pin the two pure
// helpers the recovery path leans on — a readable summary of a held write, and the split
// that keeps orphans OUT of the retry loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeWrite, partitionFailed, requeueRoutable } from '../js/app/lib/orphan-recovery.js';

test('describeWrite summarizes a txn as date / payee / amount', () => {
  const op = { op: 'entity.upsert', kind: 'txn', value: { id: 't-1', date: '2026-06-22', payee: 'AMERICAN HOME DE', lines: [{ accountId: 'chase-chk-0116', amountCents: -400000 }, { accountId: 'draping', amountCents: 400000 }] } };
  const d = describeWrite(op);
  assert.equal(d.kind, 'txn');
  assert.equal(d.date, '2026-06-22');
  assert.equal(d.payee, 'AMERICAN HOME DE');
  assert.equal(d.cents, 400000);
});

test('describeWrite falls back payee → memo → empty', () => {
  assert.equal(describeWrite({ op: 'entity.upsert', kind: 'txn', value: { memo: 'M', lines: [{ amountCents: 1200 }] } }).payee, 'M');
  assert.equal(describeWrite({ op: 'entity.upsert', kind: 'txn', value: { lines: [{ amountCents: 1200 }] } }).payee, '');
});

test('describeWrite uses the largest-magnitude line as the amount (splits)', () => {
  const op = { op: 'entity.upsert', kind: 'txn', value: { lines: [{ amountCents: -5000 }, { amountCents: 3000 }, { amountCents: 2000 }] } };
  assert.equal(describeWrite(op).cents, 5000);
});

test('describeWrite falls back for non-txn ops', () => {
  assert.equal(describeWrite({ op: 'entity.upsert', kind: 'account', value: { id: 'a-1' } }).fallback, 'entity.upsert account a-1');
  assert.equal(describeWrite({ op: 'entity.delete', kind: 'staged', id: 's-1' }).fallback, 'entity.delete staged s-1');
});

test('describeWrite tolerates junk without throwing', () => {
  assert.equal(describeWrite(null).fallback, 'unknown write');
  assert.equal(describeWrite({}).fallback, 'write');
  assert.equal(describeWrite({ op: 'entity.upsert', kind: 'txn', value: {} }).cents, 0);
});

test('partitionFailed splits routable (has biz) from orphans (no biz)', () => {
  const failed = [{ biz: 'tie-corp', op: {} }, { biz: '', op: {} }, { op: {} }, { biz: 'muse-nail-and-spa', op: {} }, null];
  const { routable, orphans } = partitionFailed(failed);
  assert.equal(routable.length, 2);
  assert.equal(orphans.length, 3);   // '', missing, and null all count as orphans
  assert.deepEqual(routable.map(f => f.biz), ['tie-corp', 'muse-nail-and-spa']);
});

test('partitionFailed tolerates a non-array', () => {
  assert.deepEqual(partitionFailed(undefined), { routable: [], orphans: [] });
  assert.deepEqual(partitionFailed(null), { routable: [], orphans: [] });
});

test('requeueRoutable moves routable to the outbox tail oldest-first, keeps orphans, strips _healed', () => {
  const failed = [   // newest-first (deadLetter unshifts)
    { biz: 'muse', op: { op: 'x', _healed: true, v: 2 } },   // newer routable
    { op: { v: 'orphan' } },                                 // orphan (no biz)
    { biz: 'tie', op: { op: 'y', v: 1 } },                   // older routable
  ];
  const outbox = [{ biz: 'muse', op: { existing: true } }];
  const r = requeueRoutable(failed, outbox);
  assert.equal(r.moved, 2);
  assert.deepEqual(r.failed, [{ op: { v: 'orphan' } }]);      // orphan stays in the failed log
  assert.deepEqual(r.outbox.map(x => x.biz), ['muse', 'tie', 'muse']);   // existing, then oldest routable first
  assert.equal('_healed' in r.outbox[2].op, false);          // one-shot retry flag stripped
  assert.equal(outbox.length, 1);                            // caller's array not mutated
});

test('requeueRoutable with only orphans moves nothing', () => {
  const r = requeueRoutable([{ op: {} }, { biz: '', op: {} }], [{ a: 1 }]);
  assert.equal(r.moved, 0);
  assert.deepEqual(r.outbox, [{ a: 1 }]);
  assert.equal(r.failed.length, 2);
});
