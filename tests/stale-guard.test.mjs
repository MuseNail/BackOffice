// Regression tests for the staged-advance carve-out in the DO stale-write guard
// (business.js apply()). A staged row leaving 'pending' (approve/skip/match) is a forward
// status transition and must NOT be rejected as 'stale' even when its browser-clock stamp
// is older than the edge-clock /suggest stamp — that race was the StickerApp double-
// representation bug. The carve-out must stay TIGHT: only pending -> non-pending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BusinessDO } from '../cloudflare/src/do/business.js';

function makeDO(seed = {}) {
  const store = new Map(Object.entries(seed));
  const state = { storage: {
    async get(k) { return store.get(k); },
    async put(k, v) { store.set(k, v); },
  } };
  const bo = new BusinessDO(state, {});
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
  const { bo, store } = makeDO({ 'staged:r4': { id: 'r4', status: 'pending', updatedAt: 1000 } });
  const res = await bo.apply({ op: 'entity.upsert', kind: 'staged',
    value: { id: 'r4', status: 'approved', updatedAt: 2000 } });
  assert.ok(!res.rejected);
  assert.equal(store.get('staged:r4').status, 'approved');
});
