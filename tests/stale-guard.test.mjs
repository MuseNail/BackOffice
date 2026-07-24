// Regression tests for the staged-advance carve-out in the DO stale-write guard
// (business.js apply()). A staged row leaving 'pending' (approve/skip/match) is a forward
// status transition and must NOT be rejected as 'stale' even when its browser-clock stamp
// is older than the edge-clock /suggest stamp — that race was the StickerApp double-
// representation bug. The carve-out must stay TIGHT: only pending -> non-pending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BusinessDO } from '../cloudflare/src/do/business.js';

function makeDO(seed = {}, env = {}) {
  const store = new Map(Object.entries(seed));
  const state = { storage: {
    async get(k) { return store.get(k); },
    async put(k, v) { store.set(k, v); },
  } };
  const bo = new BusinessDO(state, env);
  bo.broadcast = () => {};        // no live sockets in a unit test
  bo.recordAudit = async () => {}; // skip audit-log storage churn
  return { bo, store };
}

test('staged approve (pending->approved) is NOT rejected with an older stamp (clock-skew carve-out)', async () => {
  const { bo, store } = makeDO({ 'staged:r1': { id: 'r1', status: 'pending', updatedAt: 1000 } });
  const res = await bo.apply({ op: 'entity.upsert', kind: 'staged',
    value: { id: 'r1', status: 'approved', txnId: 't-r1', updatedAt: 500 } }); // 500 < 1000
  assert.ok(!res.rejected, `approve must not be rejected (got ${JSON.stringify(res)})`);
  assert.equal(store.get('staged:r1').status, 'approved');
});

test('staged content edit (stays pending) with an older stamp IS still rejected as stale', async () => {
  const { bo, store } = makeDO({ 'staged:r2': { id: 'r2', status: 'pending', desc: 'new', updatedAt: 1000 } });
  const res = await bo.apply({ op: 'entity.upsert', kind: 'staged',
    value: { id: 'r2', status: 'pending', desc: 'old', updatedAt: 500 } });
  assert.equal(res.rejected, true);
  assert.equal(res.reason, 'stale');
  assert.equal(store.get('staged:r2').desc, 'new', 'an older content edit must not clobber');
});

test('the carve-out is TIGHT: a backward move (approved->pending) with an older stamp is still rejected', async () => {
  const { bo, store } = makeDO({ 'staged:r3': { id: 'r3', status: 'approved', txnId: 't-r3', updatedAt: 1000 } });
  const res = await bo.apply({ op: 'entity.upsert', kind: 'staged',
    value: { id: 'r3', status: 'pending', updatedAt: 500 } });
  assert.equal(res.rejected, true, 'a stale write must never un-approve a row');
  assert.equal(store.get('staged:r3').status, 'approved');
});

test('a staged advance with a newer stamp applies normally', async () => {
  const { bo, store } = makeDO({ 'staged:r4': { id: 'r4', status: 'pending', updatedAt: 2000 } });
  const res = await bo.apply({ op: 'entity.upsert', kind: 'staged',
    value: { id: 'r4', status: 'approved', updatedAt: 3000 } });
  assert.ok(!res.rejected);
  assert.equal(store.get('staged:r4').status, 'approved');
});

// A client /suggest keeps the row 'pending', so the staged-advance carve-out does NOT
// apply. It must still never be dropped as stale: the DO stamps it monotonically
// (>= storedUpdatedAt+1) so an owner whose browser clock ran ahead of the edge can't
// silently lose the whole suggestion (Account + Vendor + Invoice + Note together).
async function suggest(bo, stagedId, payload) {
  return bo.fetch(new Request('https://do/_suggest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stagedId, ...payload }),
  }));
}

test('a client suggestion is NOT dropped when the stored row\'s clock is ahead (monotonic stamp)', async () => {
  const ahead = Date.now() + 9_000_000;   // stored stamp far ahead of edge-now
  const { bo, store } = makeDO({ 'staged:s1': { id: 's1', status: 'pending', updatedAt: ahead } });
  const res = await suggest(bo, 's1', { suggestedAccountId: 'a-1', suggestedVendorId: 'v-1', clientNote: 'ours' });
  assert.equal(res.status, 200);
  const row = store.get('staged:s1');
  assert.equal(row.suggestedAccountId, 'a-1', 'the suggestion must persist, not be judged stale');
  assert.equal(row.suggestedVendorId, 'v-1');
  assert.equal(row.clientNote, 'ours');
  assert.ok(row.updatedAt > ahead, `stamp must be monotonic (got ${row.updatedAt} vs stored ${ahead})`);
  assert.equal(row.status, 'pending', 'a suggestion never advances the status');
});

// The stale 409 now carries the STORED copy so the client can prove a refused write is a byte-
// identical duplicate (a cross-tab out-of-order send) and drop it instead of stranding a permanent
// "Unsynced" badge. It must NEVER re-apply/re-stamp — only expose what the server already holds.
test('a stale single-upsert 409 returns the stored copy (for the redundant-drop client check)', async () => {
  const stored = { id: 'v1', name: 'Sally Beauty', updatedAt: 1000, updatedBy: 'devA' };
  const { bo } = makeDO({ 'vendor:v1': stored });
  const res = await bo.apply({ op: 'entity.upsert', kind: 'vendor', value: { id: 'v1', name: 'Sally Beauty', updatedAt: 500, updatedBy: 'devB' } });
  assert.equal(res.rejected, true);
  assert.equal(res.reason, 'stale');
  assert.equal(res.storedUpdatedAt, 1000, 'storedUpdatedAt still returned (staged self-heal reads it)');
  assert.deepEqual(res.stored, stored, 'the full stored entity is exposed for the content comparison');
});

test('the kill switch REDUNDANT_DROP=off omits stored from the stale 409 (no-redeploy rollback)', async () => {
  const stored = { id: 'v1', name: 'Sally Beauty', updatedAt: 1000 };
  const { bo } = makeDO({ 'vendor:v1': stored }, { REDUNDANT_DROP: 'off' });
  const res = await bo.apply({ op: 'entity.upsert', kind: 'vendor', value: { id: 'v1', name: 'Sally Beauty', updatedAt: 500 } });
  assert.equal(res.rejected, true);
  assert.equal(res.reason, 'stale');
  assert.equal(res.storedUpdatedAt, 1000);
  assert.equal('stored' in res, false, 'kill switch withholds the stored copy → client dead-letters as before');
});

test('a suggested split is stored only when it has 2+ real lines', async () => {
  const { bo, store } = makeDO({ 'staged:s2': { id: 's2', status: 'pending', updatedAt: 1000 } });
  await suggest(bo, 's2', { suggestedSplit: [
    { accountId: 'a-1', amountCents: 12000 },
    { accountId: 'a-2', amountCents: 5240 },
  ] });
  assert.equal(store.get('staged:s2').suggestedSplit.length, 2);

  const { bo: bo2, store: store2 } = makeDO({ 'staged:s3': { id: 's3', status: 'pending', updatedAt: 1000 } });
  await suggest(bo2, 's3', { suggestedSplit: [{ accountId: 'a-1', amountCents: 100 }] });   // only one line
  assert.deepEqual(store2.get('staged:s3').suggestedSplit, [], 'a single-line split is not a split');
});
