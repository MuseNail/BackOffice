// ── Back Office — constants ────────────────
export const APP_VERSION = '0.71.9';

// Worker URL — fill in after the first `wrangler deploy` prints it.
// When the app itself is served from localhost, target `wrangler dev` instead.
const LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
export const ORIGIN = LOCAL ? 'http://127.0.0.1:8787' : 'https://backoffice.musenailandspa.workers.dev';

// Automatic error reporting + Web Push (both live on the system DO instance).
export const REPORT_PROXY = ORIGIN + '/report';
export const PUSH_PROXY   = ORIGIN + '/push';
// Non-secret VAPID public key (matching private key = the Worker's VAPID_PRIVATE_KEY secret).
export const VAPID_PUBLIC_KEY = 'BF_ah8pKpJHCTJo60vj2IEqki0ObMkwCm_qeWu0FrkSNxdhuYRz_33IUq0ggtlWoJUYI9pHiigZWforpqeCWFTo';

// All browser storage is prefixed bo_ — this app shares the GitHub Pages
// ORIGIN with muse/turndesk, and localStorage/CacheStorage are per-origin.
export const LS = {
  token: 'bo_token',
  user: 'bo_user',
  businesses: 'bo_businesses',
  device: 'bo_device_id',
  activeBiz: 'bo_active_biz',
  outbox: 'bo_outbox',
  failed: 'bo_failed_ops',
  cache: (biz) => `bo_state_cache_${biz}`,
};
