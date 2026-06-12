# Claude — AI Coding Instructions for backoffice

Read this before making any changes. The full architecture plan is `BACKOFFICE-KICKOFF.md` (repo root) — this file is the working rules.

## What this app is

**Back Office** — a standalone, multi-business financial-operations app (accounting, bank CSV import, AI categorization, vendor rules, inventory, reports, QuickBooks Desktop IIF export). Third product in the family: Muse (`../musedashboard`, the live salon app) syncs INTO Back Office one-way; Back Office never writes back.

Owner + clients use it: the owner belongs to every business; **client users see ONLY their business and must never learn other businesses exist** (kickoff §3b — server-side enforcement, not UI hiding).

## Architecture (locked)

- **Stack:** static PWA on GitHub Pages (`/backoffice/` base path) + Cloudflare Worker (`cloudflare/`) + Durable Objects + R2. Worker deploys via `wrangler deploy` from `cloudflare/` — owner's job.
- **No frontend build step, no frameworks.** Vanilla ES2020+ ES modules served as-is. The Worker IS multi-file (`src/`) — wrangler bundles it.
- **One `BusinessDO` per business** (`idFromName(businessId)`) + one global `RegistryDO` (directory + memberships). Cross-business queries are impossible by construction — keep it that way.
- **NO window glue, NO inline `onclick=`.** `index.html` is a thin shell; `js/app/main.js` is a hash router; each screen is a view module in `js/app/views/` exporting `render(root)`/`unmount()`, binding events with `addEventListener`. Pure logic (posting, CSV, matching, IIF) goes in `js/app/lib/` — no DOM, testable in `tests/`.
- **Auth on every Worker route.** M0: shared `AUTH_TOKEN` bearer (WS upgrade may pass it as `?token=`). M2: per-user sessions + membership middleware + device enrollment — same gate position, richer check. Never add an unauthenticated route.
- **WebSockets use the Hibernation API** (`state.acceptWebSocket()` + `webSocketMessage` handlers). Never hold sockets open with classic handlers.
- **Browser storage keys are prefixed `bo_`** — this app shares the GitHub Pages origin with `musedashboard`; never use a `muse_` key or an unprefixed key.

## Financial data rules (non-negotiable)

1. **Money is integer cents.** No floats in stored data, ever. Format only at the display edge (`ui.js fmtMoney`).
2. **Double-entry under the hood:** every posted `txn` has `lines[]` summing to exactly 0. Single-entry UX on top.
3. **The ledger is append-only.** Void (reversal) — never delete or mutate a posted amount. Period `lock:` keys reject postings into closed periods.
4. **Imported/synced rows ALWAYS land staged.** Only explicit user approval posts. AI suggests, never posts.
5. **Provenance everywhere:** imports carry `import:<id>`; synced records carry `sourceApp`+`sourceId` (idempotent upsert).
6. Every entity write stamps `updatedAt`/`updatedBy`; the stale-write guard (client `store.js` + DO `apply`) must stay symmetric.

## Conventions

- Section markers: `// ── Name ────` (U+2500 box-drawing).
- Comments explain WHY (constraints, invariants), never WHAT.
- Version bump = `js/app/config.js` APP_VERSION + `version.json` + `sw.js` CACHE_NAME, all three together.
- Commit freely; **`git push` needs explicit owner OK each time**; `wrangler deploy` is the owner's job.
- Milestones M0–M12 and their proof-of-done live in `BACKOFFICE-KICKOFF.md` §6. Build one milestone at a time; each must be verifiable before the next starts.
