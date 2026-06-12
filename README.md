# Back Office

Multi-business financial operations: accounting, bank CSV imports with AI-assisted categorization, vendor rules, inventory, reconciliation, reports (P&L / Balance Sheet), and QuickBooks Desktop (IIF) export.

A static PWA (GitHub Pages) backed by a Cloudflare Worker with one Durable Object per business — each business's books are physically isolated. See `BACKOFFICE-KICKOFF.md` for the full architecture and build plan, `CLAUDE.md` for working rules.

## Status

**M0 — bootstrap.** App shell, router, authenticated Worker, business registry. Screens beyond Businesses/Dashboard are placeholders until their milestone.

## Deploy

**Worker** (from `cloudflare/`):

```
wrangler deploy
wrangler secret put AUTH_TOKEN     # bootstrap bearer token (replaced by user sessions in M2)
```

Then put the printed Worker URL in `js/app/config.js` → `ORIGIN`.

**Front end:** GitHub Pages serves the repo as-is at `/backoffice/`. PWA icons (`icons/icon-192.png`, `icon-512.png`) still need to be added.

## Verify M0

- `GET <worker>/health` → `{ok:true}` with no auth.
- `GET <worker>/registry/businesses` → 401 without the token, `{businesses:[]}` with it.
- Open the app → token sign-in → create a business → it appears, opens, and shows "Live and syncing".
