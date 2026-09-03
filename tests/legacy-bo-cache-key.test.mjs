// node --test tests/legacy-bo-cache-key.test.mjs
// The IndexedDB migration deletes a business's LEGACY localStorage snapshot cache only after a durable
// IDB copy exists. That deletion filter MUST be an exact `bo_state_cache_` prefix — never the broader
// `state_cache` substring (which would also delete Muse/TurnDesk caches on the shared origin), and never
// a loose `bo_` scan (which would endanger the NON-regenerable bo_tax_rate_* setting and other bo_ keys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLegacyBoCacheKey } from '../js/app/lib/ls-quota.js';

test('matches BackOffice per-business snapshot caches', () => {
  assert.equal(isLegacyBoCacheKey('bo_state_cache_tie-corp'), true);
  assert.equal(isLegacyBoCacheKey('bo_state_cache_muse'), true);
  assert.equal(isLegacyBoCacheKey('bo_state_cache_'), true); // degenerate but still ours
});

test('NEVER matches other apps’ caches on the shared origin', () => {
  assert.equal(isLegacyBoCacheKey('muse_state_cache'), false);
  assert.equal(isLegacyBoCacheKey('td_state_cache_krystal'), false);
});

test('NEVER matches non-regenerable / protected bo_ keys', () => {
  for (const k of [
    'bo_token', 'bo_user', 'bo_businesses', 'bo_active_biz', 'bo_device_id', 'bo_outbox', 'bo_failed_ops',
    'bo_tax_rate_tie-corp', 'bo_tax_rate_muse', 'bo_nav_collapsed', 'bo_whatsnew_seen', 'bo_error_alerts', 'bo_last_activity',
  ]) assert.equal(isLegacyBoCacheKey(k), false, k);
});

test('non-string / junk is safe', () => {
  assert.equal(isLegacyBoCacheKey(undefined), false);
  assert.equal(isLegacyBoCacheKey(null), false);
  assert.equal(isLegacyBoCacheKey(''), false);
  assert.equal(isLegacyBoCacheKey('state_cache'), false);
  assert.equal(isLegacyBoCacheKey('xbo_state_cache_y'), false); // must be a PREFIX
});
