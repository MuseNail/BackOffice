// node --test tests/wrong-biz.test.mjs
// Layer 3 of the wrong-business-writes fix (SYNC-MISROUTE-PLAN.md): the DO refuses a write
// whose client seal (op._sealBiz — the business whose books were LOADED when the write was
// made) disagrees with the Worker's unspoofable X-Bo-Biz header (the URL business). The
// truth table IS the contract: reject ONLY when both are present and differ — server-built
// internal ops (no seal) and internal DO callers (no expectedBiz) must skip untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrongBusiness } from '../cloudflare/src/do/wrong-biz.js';
import { BusinessDO } from '../cloudflare/src/do/business.js';

// ── predicate truth table ──
test('wrongBusiness: both present and differing ⇒ reject', () => {
  assert.equal(wrongBusiness({ _sealBiz: 'tie-corp' }, 'muse'), true);
});

test('wrongBusiness: both present and equal ⇒ pass', () => {
  assert.equal(wrongBusiness({ _sealBiz: 'muse' }, 'muse'), false);
});

test('wrongBusiness: no seal (server-built / pre-L3 op) ⇒ pass, whatever the header', () => {
  assert.equal(wrongBusiness({}, 'muse'), false);
  assert.equal(wrongBusiness({ _sealBiz: '' }, 'muse'), false);
});

test('wrongBusiness: no expectedBiz (internal DO caller) ⇒ pass, even sealed', () => {
  assert.equal(wrongBusiness({ _sealBiz: 'muse' }, ''), false);
  assert.equal(wrongBusiness({ _sealBiz: 'muse' }, undefined), false);
});

test('wrongBusiness: neither ⇒ pass; junk op tolerated', () => {
  assert.equal(wrongBusiness({}, ''), false);
  assert.equal(wrongBusiness(null, 'muse'), false);
  assert.equal(wrongBusiness(undefined, undefined), false);
});

// ── apply() wiring — the check must actually gate the DO's single write choke-point ──
function makeDO(seed = {}, env = {}) {
  const store = new Map(Object.entries(seed));
  const state = { storage: {
    async get(k) { return store.get(k); },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  } };
  const bo = new BusinessDO(state, env);
  bo.broadcast = () => {};        // no live sockets in a unit test
  bo.recordAudit = async () => {}; // skip audit-log storage churn
  return { bo, store };
}

test('apply: a mismatched seal rejects entity.upsert with wrong-business, storing nothing', async () => {
  const { bo, store } = makeDO();
  const res = await bo.apply({ op: 'entity.upsert', kind: 'vendor', _sealBiz: 'tie-corp',
    value: { id: 'v1', name: 'Acme', updatedAt: 1000 } }, '', 'muse');
  assert.equal(res.rejected, true);
  assert.equal(res.reason, 'wrong-business');
  assert.equal(store.has('vendor:v1'), false);
});

test('apply: a mismatched seal rejects meta.set (a misrouted profile overwrite)', async () => {
  const { bo, store } = makeDO({ meta: { name: 'Muse' } });
  const res = await bo.apply({ op: 'meta.set', _sealBiz: 'tie-corp', value: { name: 'TIE' } }, '', 'muse');
  assert.equal(res.rejected, true);
  assert.equal(res.reason, 'wrong-business');
  assert.equal(store.get('meta').name, 'Muse');
});

test('apply: a mismatched seal rejects entity.bulkUpsert before ANY value lands', async () => {
  const { bo, store } = makeDO();
  const res = await bo.apply({ op: 'entity.bulkUpsert', kind: 'staged', _sealBiz: 'tie-corp',
    values: [{ id: 's1' }, { id: 's2' }] }, '', 'muse');
  assert.equal(res.rejected, true);
  assert.equal(res.reason, 'wrong-business');
  assert.equal(store.has('staged:s1'), false);
  assert.equal(store.has('staged:s2'), false);
});

test('apply: a mismatched seal rejects entity.delete, keeping the entity', async () => {
  const { bo, store } = makeDO({ 'vendor:v2': { id: 'v2', name: 'Keep' } });
  const res = await bo.apply({ op: 'entity.delete', kind: 'vendor', id: 'v2', _sealBiz: 'tie-corp' }, '', 'muse');
  assert.equal(res.rejected, true);
  assert.equal(res.reason, 'wrong-business');
  assert.equal(store.get('vendor:v2').name, 'Keep');
});

test('apply: internal callers (no expectedBiz) apply a sealed op untouched', async () => {
  const { bo, store } = makeDO();
  const res = await bo.apply({ op: 'entity.upsert', kind: 'vendor', _sealBiz: 'muse',
    value: { id: 'v3', name: 'Internal', updatedAt: 1000 } });
  assert.ok(!res.rejected, `internal apply must skip the check (got ${JSON.stringify(res)})`);
  assert.equal(store.get('vendor:v3').name, 'Internal');
});

test('apply: an unstamped op passes whatever the header — the orphan-guess class is Layer 1\'s to catch', async () => {
  const { bo, store } = makeDO();
  const res = await bo.apply({ op: 'entity.upsert', kind: 'vendor',
    value: { id: 'v4', name: 'Unsealed', updatedAt: 1000 } }, '', 'muse');
  assert.ok(!res.rejected);
  assert.equal(store.get('vendor:v4').name, 'Unsealed');
});

test('apply: a matched seal applies — and the stale-write guard still runs AFTER the check', async () => {
  const { bo, store } = makeDO({ 'vendor:v5': { id: 'v5', name: 'Newer', updatedAt: 2000 } });
  const ok = await bo.apply({ op: 'entity.upsert', kind: 'vendor', _sealBiz: 'muse',
    value: { id: 'v5', name: 'Newest', updatedAt: 3000 } }, '', 'muse');
  assert.ok(!ok.rejected);
  assert.equal(store.get('vendor:v5').name, 'Newest');
  const stale = await bo.apply({ op: 'entity.upsert', kind: 'vendor', _sealBiz: 'muse',
    value: { id: 'v5', name: 'Older', updatedAt: 500 } }, '', 'muse');
  assert.equal(stale.rejected, true);
  assert.equal(stale.reason, 'stale', 'the seal check must not swallow the stale guard');
});

test('apply: the kill switch (WRONG_BIZ_CHECK=off) disables the check without a code revert', async () => {
  const { bo, store } = makeDO({}, { WRONG_BIZ_CHECK: 'off' });
  const res = await bo.apply({ op: 'entity.upsert', kind: 'vendor', _sealBiz: 'tie-corp',
    value: { id: 'v6', name: 'Switched off', updatedAt: 1000 } }, '', 'muse');
  assert.ok(!res.rejected);
  assert.equal(store.get('vendor:v6').name, 'Switched off');
});
