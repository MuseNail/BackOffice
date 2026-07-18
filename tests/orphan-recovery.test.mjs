// node --test tests/orphan-recovery.test.mjs
// Layer 1 of the wrong-business-writes fix: the app must NEVER guess an un-tagged write's
// business (a wrong guess posted a $4k TIE txn into Muse's books). These pin the two pure
// helpers the recovery path leans on — a readable summary of a held write, and the split
// that keeps orphans OUT of the retry loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeWrite, partitionFailed, requeueRoutable, orphanizeRejected, capFailedLog } from '../js/app/lib/orphan-recovery.js';

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

// ── Layer 3 (SYNC-MISROUTE-PLAN.md): the seal must survive a Sync-now round trip ──
// (regression pin — requeueRoutable strips ONLY the one-shot _healed retry flag; the
// _sealBiz seal is the integrity stamp the server compares, so losing it here would
// silently disarm the server check on every retried write)
test('requeueRoutable preserves _sealBiz while stripping _healed', () => {
  const failed = [{ biz: 'muse', op: { op: 'entity.upsert', _sealBiz: 'muse', _healed: true } }];
  const r = requeueRoutable(failed, []);
  assert.equal(r.outbox[0].op._sealBiz, 'muse');
  assert.equal('_healed' in r.outbox[0].op, false);
});

// ── orphanizeRejected — a server-refused wrong-business write becomes an ORPHAN entry ──
// biz:'' routes it into the recovery UI's per-row picker (a stamped entry would render
// view-only under the WRONG business); `attempted` preserves which books it almost hit.
test('orphanizeRejected builds an orphan entry keeping the op (and its seal) plus the attempted business', () => {
  const item = { biz: 'muse', op: { op: 'entity.upsert', kind: 'vendor', _sealBiz: 'tie-corp', value: { id: 'v1' } } };
  const e = orphanizeRejected(item, 'wrong-business');
  assert.equal(e.biz, '', 'must be an orphan so the recovery picker renders');
  assert.equal(e.attempted, 'muse');
  assert.equal(e.reason, 'wrong-business');
  assert.equal(e.op._sealBiz, 'tie-corp', 'the seal must survive for the pre-select hint');
  assert.deepEqual(e.op.value, { id: 'v1' });
  assert.equal(typeof e.rejectedAt, 'number');
});

test('orphanizeRejected tolerates a junk item without throwing', () => {
  const e = orphanizeRejected({}, 'wrong-business');
  assert.equal(e.biz, '');
  assert.equal(e.attempted, '');
});

// ── capFailedLog — independent budgets so piled-up orphans can't blind the rejection log
// and routable pressure can NEVER evict an orphan (the only copy of a never-saved write) ──
const mkRoutable = (n) => Array.from({ length: n }, (_, i) => ({ biz: 'muse', op: { i }, reason: 'stale' }));
const mkOrphans = (n) => Array.from({ length: n }, (_, i) => ({ biz: '', op: { o: i }, reason: 'no-business' }));

test('capFailedLog leaves a small log untouched, preserving order', () => {
  const log = [...mkOrphans(3), ...mkRoutable(5)];
  const r = capFailedLog(log);
  assert.deepEqual(r.log, log);
  assert.deepEqual(r.evictedOrphans, []);
  assert.notEqual(r.log, log, 'caller\'s array must not be shared/mutated');
});

test('capFailedLog keeps the newest 100 routable and ALL orphans (orphans never evicted by routable pressure)', () => {
  // newest-first log: 150 orphans interleaved after 500 routable would be unrealistic;
  // build newest-first with orphans scattered at both ends to prove order-preserving filters.
  const log = [...mkOrphans(50), ...mkRoutable(500), ...mkOrphans(100)];
  const r = capFailedLog(log);
  const routable = r.log.filter(e => e.biz);
  const orphans = r.log.filter(e => !e.biz);
  assert.equal(routable.length, 100);
  assert.equal(orphans.length, 150);
  assert.deepEqual(routable, mkRoutable(500).slice(0, 100), 'newest routable kept');
  assert.deepEqual(r.evictedOrphans, []);
});

test('capFailedLog hard-caps orphans at 200 newest and RETURNS the evicted ones so the caller can sound the siren', () => {
  const log = mkOrphans(250);   // newest-first
  const r = capFailedLog(log);
  assert.equal(r.log.length, 200);
  assert.deepEqual(r.log, log.slice(0, 200), 'newest 200 kept');
  assert.equal(r.evictedOrphans.length, 50);
  assert.deepEqual(r.evictedOrphans, log.slice(200), 'the oldest orphans are the evicted ones');
});

test('capFailedLog tolerates a non-array', () => {
  assert.deepEqual(capFailedLog(null), { log: [], evictedOrphans: [] });
  assert.deepEqual(capFailedLog(undefined), { log: [], evictedOrphans: [] });
});
