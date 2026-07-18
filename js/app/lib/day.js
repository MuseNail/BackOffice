// ── lib: day — the VIEWING device's local calendar day/month (pure) ────────────
// The owner is in PST. Deriving "today" via new Date().toISOString().slice(0,10) is UTC,
// which reads TOMORROW from ~4-5pm Pacific — so a transaction entered in the evening
// defaulted to the wrong day. These derive the day/month from the LOCAL zone instead.
// now-injectable so they're testable; no DOM/IO so they load under node.
//
// Decision (2026-07): calendar day/month follow the viewing device's local zone; there is
// no per-business timezone setting (fine for the single PST owner — a future out-of-zone
// bookkeeper would bucket to their own device's zone). Shared home so there's ONE local-day
// implementation (daterange.js and plaid-feed.js delegate here).
const pad = (n) => String(n).padStart(2, '0');
export const todayLocal = (now = new Date()) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
export const monthLocal = (now = new Date()) => todayLocal(now).slice(0, 7);
