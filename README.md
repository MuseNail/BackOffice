# Back Office

Multi-business financial operations: accounting, bank CSV imports with AI-assisted categorization, vendor rules, inventory, reconciliation, reports (P&L / Balance Sheet), and QuickBooks Desktop (IIF) export.

A static PWA (GitHub Pages) backed by a Cloudflare Worker with one Durable Object per business — each business's books are physically isolated. See `BACKOFFICE-KICKOFF.md` for the full architecture and build plan, `CLAUDE.md` for working rules.

## Status — v0.12.0, LIVE in production

**M0–M10 complete** (of the M0–M12 plan in `BACKOFFICE-KICKOFF.md`), plus AI spend controls and the 2026-06-12 feedback batch (per-account Review, transfers with counterpart matching, deposit fee splits, subaccounts, owner-device approval fix).

Working today: PIN logins with device enrollment + the §3b client-visibility access model · business setup wizard with industry chart-of-accounts templates · chart of accounts with subaccounts · double-entry ledger (manual entry, journal entries, void) · bank/card accounts + CSV import wizard with dedup · Review staging (rules → history → Claude AI suggestions, transfers, fee splits) · AI usage metering with a server-enforced monthly budget + pause · reconciliation · reports (P&L, Balance Sheet, tax estimate) · inventory with restocks that post.

**Remaining:** M11 Muse sync (blocked on Muse's §13 Worker auth), M12 QuickBooks Desktop IIF export, M13 Helcim/Square processor sync (payout matching + automatic fee extraction).

## Deploy

**Front end:** GitHub Pages auto-deploys `main` to `musenail.github.io/BackOffice/`.

**Worker** (only when `cloudflare/` changed; from `cloudflare/`):

```
wrangler deploy
wrangler secret put ANTHROPIC_API_KEY   # enables AI categorization (set once)
```

Optional var: `AI_MODEL` (defaults to `claude-opus-4-8`; `claude-haiku-4-5` is ~5× cheaper).

## Develop locally

```
cd cloudflare && wrangler dev --local --port 8787   # local Worker (state in .wrangler/)
```

Serve the repo root with any static server; `js/app/config.js` auto-targets `127.0.0.1:8787` when the page is on localhost. Tests: `node --test tests/<file>.mjs` (run files directly).
