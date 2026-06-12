// ── Back Office — constants ────────────────
export const APP_VERSION = '0.1.0';

// Worker URL — fill in after the first `wrangler deploy` prints it.
export const ORIGIN = 'https://backoffice.musenailandspa.workers.dev';

// All browser storage is prefixed bo_ — this app shares the GitHub Pages
// ORIGIN with muse/turndesk, and localStorage/CacheStorage are per-origin.
export const LS = {
  token: 'bo_token',
  device: 'bo_device_id',
  activeBiz: 'bo_active_biz',
  outbox: 'bo_outbox',
  cache: (biz) => `bo_state_cache_${biz}`,
};
