// ── lib: ls-quota — which localStorage keys are safe to evict at the 10MB cap (pure) ──────────────
// All three apps (BackOffice, Muse, TurnDesk) share the musenail.github.io origin and its ONE ~10MB
// localStorage. Each caches a full state snapshot there for instant offline reload — those mirrors are
// the only thing we drop to make room, because they REGENERATE (re-fetched from the server next load).
// Everything else — the auth token, device id, and especially the offline OUTBOX and dead-letter of
// un-synced writes — is NEVER evicted (losing an un-synced write loses real money data).
//
// Match on the substring 'state_cache' so Muse's suffix-less `muse_state_cache` is caught alongside the
// per-business `bo_state_cache_<biz>` / `td_state_cache_*` keys. None of the protected bo_ keys
// (token, user, businesses, active_biz, device_id, outbox, failed_ops) contain 'state_cache'.
export function isEvictableCacheKey(key) {
  return typeof key === 'string' && key.includes('state_cache');
}

// STRICT — only THIS app's per-business snapshot caches (`bo_state_cache_<biz>`). Distinct from
// isEvictableCacheKey on purpose: the IndexedDB migration DELETES these from localStorage once a durable
// IDB copy exists, so it must NEVER match Muse/TurnDesk caches (`muse_state_cache`, `td_state_cache_*`),
// the non-regenerable `bo_tax_rate_*` setting, or any protected bo_ key (none begin with this prefix).
export function isLegacyBoCacheKey(key) {
  return typeof key === 'string' && key.startsWith('bo_state_cache_');
}

// The order to evict in: every evictable cache EXCEPT the active business's own mirror first, then that
// one LAST — dropping the active mirror only stings if the user reloads while offline before it
// re-fetches, so it's the last resort.
export function evictionOrder(allKeys, activeCacheKey) {
  const cacheKeys = (allKeys || []).filter(isEvictableCacheKey);
  const others = cacheKeys.filter(k => k !== activeCacheKey);
  const active = cacheKeys.filter(k => k === activeCacheKey);
  return [...others, ...active];
}
