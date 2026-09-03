// node --test tests/ls-quota.test.mjs
// Which localStorage keys are safe to evict when the shared 10MB origin is full, and in what order.
// ONLY the regenerable state-cache mirrors may go; the auth token, device id, and the un-synced
// outbox / dead-letter must NEVER be evicted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEvictableCacheKey, evictionOrder } from '../js/app/lib/ls-quota.js';

// The seven protected bo_ keys (config.js LS map) — none may ever be evictable.
const PROTECTED = ['bo_token', 'bo_user', 'bo_businesses', 'bo_active_biz', 'bo_device_id', 'bo_outbox', 'bo_failed_ops'];
// Cache mirrors across the three apps sharing musenail.github.io.
const CACHES = ['bo_state_cache_tie-corp', 'bo_state_cache_muse', 'muse_state_cache', 'td_state_cache_krystal'];

test('isEvictableCacheKey: every state-cache mirror is evictable, incl. muse suffix-less key', () => {
  for (const k of CACHES) assert.equal(isEvictableCacheKey(k), true, k);
});

test('isEvictableCacheKey: none of the protected keys are evictable', () => {
  for (const k of PROTECTED) assert.equal(isEvictableCacheKey(k), false, k);
});

test('isEvictableCacheKey: non-string / junk is safe', () => {
  assert.equal(isEvictableCacheKey(undefined), false);
  assert.equal(isEvictableCacheKey(null), false);
  assert.equal(isEvictableCacheKey(''), false);
  assert.equal(isEvictableCacheKey('bo_tax_rate_muse'), false);
});

test('evictionOrder: only cache keys, active business cache LAST', () => {
  const all = [...PROTECTED, ...CACHES];
  const order = evictionOrder(all, 'bo_state_cache_tie-corp');
  // no protected key present
  for (const k of PROTECTED) assert.equal(order.includes(k), false, k);
  // active cache is last
  assert.equal(order[order.length - 1], 'bo_state_cache_tie-corp');
  // all four caches present exactly once
  assert.deepEqual([...order].sort(), [...CACHES].sort());
});

test('evictionOrder: no active cache key → all caches, order preserved among the rest', () => {
  const order = evictionOrder([...PROTECTED, ...CACHES], '');
  assert.deepEqual(order, CACHES);
});

test('evictionOrder: empty / nullish input is safe', () => {
  assert.deepEqual(evictionOrder([], 'x'), []);
  assert.deepEqual(evictionOrder(undefined, 'x'), []);
});
