# Back Office â€” Kickoff & Structure Plan

> **Status: BUILT THROUGH M10 + extras — v0.12.0 LIVE** at `musenail.github.io/BackOffice/`. The milestone table and the Progress Log at the bottom of this file are the build record. Remaining: M11 (blocked on Muse §13) · M12 · M13.
> Back Office is a standalone, multi-business financial-operations app (accounting, bank CSV import, AI categorization, vendor rules, inventory, reports, QuickBooks Desktop export). It is the THIRD product in the family: Muse (this repo, live salon app) â†’ Back Office (this plan). It does NOT live inside Muse â€” Muse syncs finalized financial data INTO it, one-way.
>
> Source strategy doc: `BackOffice_App_Overview_and_Strategy.md` (owner's Downloads). Phase 1 repo review done 2026-06-11.

---

## 0. Decisions & defaults (owner can override any of these before M0)

| Decision | Choice | Why |
|---|---|---|
| Repo | New GitHub repo `MuseNail/backoffice`, GitHub Pages at `/backoffice/` | TurnDesk precedent; Muse repo stays untouched |
| Cloudflare | Isolated Worker `backoffice` in the existing CF account (`info@musenailandspa.com`), own DO class + R2 bucket + secrets | Same as the TurnDesk account decision â€” CF requires unique email per account; isolation is per-Worker/DO, billing login shared |
| Stack | Same as Muse: static PWA (no build step, vanilla ES modules, Tailwind CDN) + Cloudflare Worker + Durable Objects + R2 | Proven, owner-operable, zero build infra |
| Tenancy | **One Durable Object per business** (`BusinessDO`, `idFromName(businessId)`) | Hard data separation â€” one business physically cannot read another's DO |
| Ledger | **Double-entry under the hood, single-entry UX** | P&L + Balance Sheet + QuickBooks export all require it; retrofitting later is painful |
| Auth | **Per-user sessions on EVERY Worker route from day one**: identifier + PIN â†’ session token; membership checked server-side before any business data is touched (see Â§3b) | Muse's biggest open debt (Â§13) â€” do not repeat it; clients must only ever see their own business |
| WebSockets | **Hibernation API from day one** (`state.acceptWebSocket()`) | Lesson from Muse's free-tier outage; non-hibernating WS bills DO duration continuously |
| Storage keys | All browser storage prefixed `bo_` (never `muse_`/`turndesk_`) | Same GitHub Pages origin â†’ localStorage/CacheStorage are shared per-ORIGIN |
| QB export | IIF format (QuickBooks Desktop's import format) | Design the COA with IIF account-type vocabulary in mind from day one |
| AI categorization | Worker-side call to the Claude API (`/ai/categorize`, batch) â€” suggestions only, never auto-post | API key stays server-side (Muse's proxy pattern); model picked at build time |

---

## 1. What we port from Muse vs. what we do differently

**Port (the small, proven core â€” adapt, don't copy blindly):**
- `store.js` / `sync.js` / `session.js` â€” optimistic `dispatch`, offline outbox, stale-write guards, snapshot hydration, echo suppression.
- DO entity-per-key persistence pattern (`customer:<id>` â†’ here `txn:<id>`, `account:<id>`, â€¦) + R2 snapshot backups via DO `alarm()`.
- `auth.js` PIN/role concepts (re-shaped for per-business users).
- Worker proxy pattern (secrets server-side; client never holds API keys).
- `utils.js` pieces as needed: numpad, toast, money formatting, `xlsxBlob()`, PDF helpers.

**Do differently (the lessons):**
1. **No window-glue / no inline `onclick=`.** Muse's 234KB `index.html` + 241KB `reports.js` are the direct result of one global HTML file wired by inline handlers. Back Office: `index.html` is a thin shell (header + nav + one `<div id="view">`); each screen is a view module that renders its own DOM and binds events with `addEventListener`/delegation. This single rule is what keeps modules small.
2. **A real (tiny) view router.** Hash-based (`#/business/<id>/ledger`), `main.js` mounts/unmounts view modules. No framework â€” a ~50-line router.
3. **Worker as multiple source files.** `wrangler` bundles with esbuild, so the Worker can be modular (`src/routes/*.js`) without violating the no-client-build rule. Muse's 66KB single `worker.js` doesn't need repeating.
4. **Auth middleware first, routes second.** Every route except nothing (no exceptions) goes through the bearer check.
5. **Schema versioning from day one.** Each DO stores `schema_version`; migrations are explicit functions run on DO wake.

---

## 2. Repo layout

```
backoffice/
â”œâ”€ index.html                 # thin shell: header, nav mount, #view container
â”œâ”€ manifest.json  sw.js  version.json  icons/
â”œâ”€ css/styles.css
â”œâ”€ js/app/
â”‚  â”œâ”€ main.js                 # boot, hash router, view mount/unmount, version check
â”‚  â”œâ”€ config.js               # APP_VERSION, ORIGIN (Worker URL)
â”‚  â”œâ”€ store.js                # in-memory state + applyChange reducer (per business)
â”‚  â”œâ”€ sync.js                 # dispatch, WS + HTTP fallback, offline outbox
â”‚  â”œâ”€ session.js              # auth token, active business, active user
â”‚  â”œâ”€ ui.js                   # dom(), modal, toast, confirm, .data-table renderer
â”‚  â”œâ”€ views/                  # ONE MODULE PER SCREEN â€” each exports render(el)/unmount()
â”‚  â”‚  â”œâ”€ businesses.js        # business selector + "new business" setup wizard
â”‚  â”‚  â”œâ”€ dashboard.js         # per-business overview (cash position, uncategorized count, alerts)
â”‚  â”‚  â”œâ”€ accounts.js          # chart of accounts (tree, CRUD, archive)
â”‚  â”‚  â”œâ”€ ledger.js            # transaction ledger, manual entry, journal entries
â”‚  â”‚  â”œâ”€ banking.js           # bank/cc accounts + CSV import wizard (upload â†’ map â†’ preview â†’ stage)
â”‚  â”‚  â”œâ”€ staging.js           # staging area: review/approve/skip imported rows
â”‚  â”‚  â”œâ”€ rules.js             # vendor rules (exact / keyword / history matchers)
â”‚  â”‚  â”œâ”€ reconcile.js         # statement reconciliation sessions
â”‚  â”‚  â”œâ”€ inventory.js         # items, quantities, restock
â”‚  â”‚  â”œâ”€ vendors.js           # vendor/supplier directory + purchase history
â”‚  â”‚  â”œâ”€ reports.js           # P&L, Balance Sheet, sales/expense summaries, tax estimate
â”‚  â”‚  â””â”€ settings.js          # users/PINs/roles, business settings, integrations, QB export
â”‚  â””â”€ lib/                    # pure logic, no DOM â€” independently testable
â”‚     â”œâ”€ csv.js               # parse, encoding handling, column auto-detect heuristics
â”‚     â”œâ”€ coa-templates.js     # industry â†’ starting chart of accounts (data-only)
â”‚     â”œâ”€ posting.js           # double-entry posting engine (lines sum to zero, period locks)
â”‚     â”œâ”€ match.js             # duplicate detection + vendor-rule matching
â”‚     â”œâ”€ qb-iif.js            # IIF export writer
â”‚     â””â”€ money.js             # integer-cents math everywhere (no floats in stored data)
â”œâ”€ cloudflare/
â”‚  â”œâ”€ src/
â”‚  â”‚  â”œâ”€ index.js             # router + auth middleware (bearer token on every route)
â”‚  â”‚  â”œâ”€ do/business.js       # BusinessDO: state, WS w/ HIBERNATION, alarm() R2 backups
â”‚  â”‚  â”œâ”€ do/registry.js       # RegistryDO: business directory + cross-business owner access
â”‚  â”‚  â””â”€ routes/
â”‚  â”‚     â”œâ”€ state.js          # /b/:businessId/state  (snapshot, mutate, WS upgrade)
â”‚  â”‚     â”œâ”€ ai.js             # /ai/categorize  (batch â†’ Claude API, returns suggestions)
â”‚  â”‚     â”œâ”€ sync.js           # /sync/inbound   (Muse â†’ Back Office, idempotent)
â”‚  â”‚     â””â”€ files.js          # /files/*        (R2: receipts/invoices/statements)
â”‚  â””â”€ wrangler.toml
â””â”€ tests/                     # plain node test files for lib/ (posting, csv, match, iif)
```

Rules carried over from Muse: section markers `// â”€â”€ Name â”€â”€â€¦`, no comments explaining WHAT, version bump = `config.js` + `version.json` + `sw.js` CACHE_NAME together.

---

## 3. Data model (entities inside each BusinessDO)

Every record carries `updatedAt`/`updatedBy` (stale-write guard, same as Muse) and belongs to exactly one business by construction (it lives in that business's DO).

| Key | Entity | Fields (core) |
|---|---|---|
| `meta` | Business profile | name, industry, fiscal year start, settings, `schema_version` |
| `user:<id>` | Business user | name, PIN hash, role (`owner` / `manager` / `bookkeeper` / `viewer`), permissions |
| `account:<id>` | COA account | name, type (`asset` / `liability` / `equity` / `income` / `cogs` / `expense`), subtype, parentId, qbName + qbType (IIF mapping), active |
| `txn:<id>` | Ledger transaction | date, payeeVendorId?, memo, **lines[] `{accountId, amountCents}` summing to 0**, status (`staged` â†’ `posted` â†’ `void`), source `{app, sourceId, importId}`, reconciledIn? |
| `bankacct:<id>` | Bank/credit-card account | name, institution, kind (`checking` / `savings` / `card` / `cash`), linked `account:<id>`, saved CSV mapping presets |
| `import:<id>` | Import batch | bankacctId, filename, importedAt, mapping used, row/dup/posted counts, status |
| `staged:<id>` | Staged bank row | importId, raw row, normalized `{date, desc, amountCents}`, dedupHash, suggestion `{accountId, by: rule/ai/history, confidence}`, status (`pending` / `approved` / `skipped` / `duplicate`) |
| `vendor:<id>` | Vendor / supplier | name, matchers `{exact[], keywords[]}`, defaultAccountId, defaultMemo, isSupplier |
| `item:<id>` | Inventory item | name, supplierId, unit, qtyOnHand, avgUnitCostCents, restockAt |
| `purchase:<id>` | Restock / purchase | itemId, supplierId, qty, unitCostCents, txnId link, receipt file ref |
| `recon:<id>` | Reconciliation session | bankacctId, statementEndDate, statementBalanceCents, clearedTxnIds[], status |
| `lock:<period>` | Period lock | closed accounting periods reject postings (Muse payroll-lock precedent) |

**RegistryDO (one global instance):** `business:<id>` (id, name, industry, createdAt) + `membership:<userId>:<businessId>` (role). The owner belongs to all businesses; clients belong only to theirs.

**Money is integer cents everywhere.** No floats in stored data, ever.

### 3b. Access & visibility model â€” HARD REQUIREMENT (owner, 2026-06-11)

> Clients get access ONLY to their own business. A Muse user must not even be able to learn that "Pham Properties LLC" *exists* â€” no name, no id, no count of other businesses â€” let alone see its data. The owner sees and switches between all businesses.

**Enforcement is server-side; the UI merely reflects it.** Hiding a nav item is not the wall â€” the Worker is.

1. **Login flow:** user enters identifier + PIN â†’ Worker checks credentials â†’ issues a session token. The login response (and every later response) contains ONLY the businesses that user is a member of. A single-business user's session literally never carries another business's name or id over the wire.
2. **Worker middleware:** every `/b/:businessId/*` request resolves the session user's membership in that business (RegistryDO) BEFORE the request touches the BusinessDO. Non-members get the same `403` whether the business exists or not â€” no enumeration, no existence leak.
3. **DO isolation as the backstop:** even a middleware bug can only ever expose ONE business's DO per request path â€” there is no query that spans businesses, because there is no shared table to query.
4. **UI shaping:** a single-business user gets NO business switcher (the business name renders as a static label), NO "Businesses" screen, and lands directly in their business after PIN entry. Only multi-business users (the owner) get the switcher + selector.
5. **Files too:** R2 receipt/statement objects are keyed `b/<businessId>/...` and served only through the same membership check â€” no public URLs.

**Client-login hardening (because clients sign in from their own devices over the internet):** a bare 4-digit PIN is not enough remotely. Plan: per-device enrollment (first sign-in on a new device requires owner approval or a one-time invite code) + rate-limited PIN attempts with lockout. PIN stays the daily convenience; the enrolled device is the second factor. Details locked at M2.

**Posting invariants (enforced in `lib/posting.js` AND in the DO on write):**
- lines sum to exactly 0; at least 2 lines; every line references an active account
- posting into a locked period is rejected
- staged â†’ posted is the ONLY path for imported rows (no silent auto-posting)
- `void` reverses, never deletes â€” the ledger is append-only

---

## 4. Core workflows

**Business setup wizard:** name â†’ industry pick â†’ COA template applied from `coa-templates.js` (e.g. *Salon/Spa*, *Retail*, *Restaurant*, *Services*, *Generic*) â†’ opening balances (optional) â†’ first user (owner PIN). Templates are data, not code â€” adding an industry is adding an array.

**Bank import:** upload CSV â†’ `csv.js` parses + auto-detects columns (date/description/amount, or debit+credit pair; falls back to manual mapping UI; mapping saved per bank account) â†’ preview â†’ dedup (`dedupHash = date+amountCents+normalized-desc` checked against existing staged AND posted) â†’ staged rows created under an `import:<id>`.

**Categorization (in priority order, on the staging screen):** â‘  exact vendor match â†’ â‘¡ keyword rule â†’ â‘¢ history match (same normalized desc previously approved) â†’ â‘£ AI suggestion (batched to `/ai/categorize`). Every suggestion shows its source + confidence. **User approves; approval posts** the double-entry txn (bank account line + category line) linked to the import. "Make this a rule" is one tap from any approval.

**Reconciliation:** pick bank account + statement end date + end balance â†’ app shows posted txns in range â†’ check off cleared â†’ difference must reach $0.00 to close â†’ closed session stamps `reconciledIn` on the txns.

**Reports:** P&L (date range, cash basis first; accrual later if ever needed), Balance Sheet (as-of date), sales/expense summaries by account/vendor/month, tax-estimate summary (configurable % buckets). Excel-style `.data-table` layout (owner preference), CSV/XLSX/PDF export reusing Muse's helpers.

**QuickBooks Desktop export:** `qb-iif.js` writes `!ACCNT` (COA) and `!TRNS`/`!SPL` (transactions) IIF sections using each account's `qbName`/`qbType`. Export by date range; mark exported txns so re-export warns about duplicates.

---

## 5. Sync contract â€” Muse â†’ Back Office (one-way, additive)

- **Direction:** Muse pushes; Back Office receives at `POST /sync/inbound`. **No reverse channel exists at all** â€” "no destructive sync back" is structural.
- **Payload:** finalized records only (paid transactions / daily sales summaries, gift-card liability movements, payroll summaries), each with `{sourceApp:'musenail', sourceId, businessId}`.
- **Idempotent:** upsert keyed on `sourceApp+sourceId` â€” re-pushing the same record is a no-op.
- **Lands as STAGED**, mapped via a saved "Muse mapping" (sales â†’ income account, tips â†’ liability, gift cards sold â†’ liability, payroll â†’ expense). Owner approves into the ledger like any import. Day one fallback: Muse's existing CSV exports through the normal import wizard â€” the live sync is a later milestone.
- **Hard prerequisite: Muse Â§13 Worker auth.** The Muse Worker is still unauthenticated; the sync touchpoint in the Muse repo (one small additive push hook) must land behind the shared-bearer-token work. Until then, CSV is the bridge.
- TurnDesk sync: moot â€” TurnDesk is superseded; any future product built from current Muse inherits this same contract.

---

## 6. Build milestones (each small, testable, shippable)

| # | Milestone | Proof it works |
|---|---|---|
| M0 | Repo bootstrap: shell + router + Worker w/ auth + empty `BusinessDO` + deploy | Pages loads; `GET /b/test/state` 401s without token, returns empty state with it |
| M1 | Business registry + setup wizard + COA templates | Create 2 businesses; each gets its own COA; data provably isolated |
| M2 | Users / PIN / roles + Â§3b access model (sessions, membership middleware, device enrollment, rate limiting) | PIN login; viewer can't edit; owner sees both businesses; **a client user's session provably never carries the other business's name/id; non-member request â†’ indistinguishable 403** |
| M3 | Chart of accounts CRUD | Add/rename/archive accounts; tree renders; template + custom coexist |
| M4 | Posting engine + manual ledger entry + journal entries | `tests/posting` pass; unbalanced entry rejected; ledger renders |
| M5 | Bank accounts + CSV import wizard + staging | Import 3 different real bank CSVs; columns auto-detect; dups flagged |
| M6 | Vendor rules + history matching | Rule auto-suggests on next import; "make rule" from approval works |
| M7 | AI categorization (`/ai/categorize`) | Unmatched rows get suggestions; nothing posts without approval |
| M8 | Reconciliation | Reconcile a real statement to $0.00 |
| M9 | Reports: P&L, Balance Sheet, summaries, tax estimate | P&L ties to the ledger by hand-check; BS balances |
| M10 | Inventory + suppliers + purchases | Restock updates qty + posts the linked txn |
| M11 | Muse â†’ Back Office sync (AFTER Muse Â§13 auth ships) | Muse day pushes land as staged rows; re-push is a no-op |
| M12 | QuickBooks IIF export | Exported file imports into QB Desktop cleanly |

Testing gates (from the strategy doc, every milestone): business isolation, no auto-posting, import history present, report accuracy hand-checked.

---

## 7. Data integrity rules (restated as build constraints)

1. Every record lives inside one business's DO â€” cross-business access is impossible by construction, not by query filter.
2. Imported/synced rows are ALWAYS staged; only explicit user approval posts.
3. The ledger is append-only: void/reverse, never delete or mutate posted amounts.
4. Every import and every synced record carries its provenance (`import:<id>` / `sourceApp+sourceId`).
5. AI suggests; the user approves. No exceptions.
6. R2 snapshot backups via DO `alarm()` from M1 (not bolted on later).
7. Integer cents; no floats in stored data.

---

## 8. Progress log (updated 2026-06-12)

| Milestone | Version | Status | Notes |
|---|---|---|---|
| M0 bootstrap (shell, router, authed Worker, DOs) | 0.1.0 | ✅ verified | local smoke 10/10 |
| M1 setup wizard + industry COA templates | 0.2.0 | ✅ verified | bulkUpsert op; isolation proven across 2 DOs |
| M2 §3b access model (sessions, PIN, devices, memberships) | 0.3.0 | ✅ verified | 12/12 security checks incl. invisibility proof; AUTH_TOKEN retired |
| M3 chart of accounts CRUD | 0.4.0 | ✅ verified | archive-not-delete; type fixed once created |
| M4 posting engine + ledger | 0.4.0 | ✅ verified | debit-positive signed lines; DO rejects unbalanced/float 409 |
| M5 bank accounts + CSV import + Review staging | 0.5.0 | ✅ verified | column auto-detect, saved mappings, dedup; boot-rehydration fix |
| M6 vendor rules + history matching | 0.6.0 | ✅ verified | exact→keyword→history; orphan-rule fallthrough fix |
| M7 AI categorization (Claude) | 0.7.0 | ✅ live | /ai/categorize, structured output, suggestions never post |
| — AI spend controls | 0.9.0 | ✅ verified | usage metering + server-enforced monthly budget + pause |
| M8 reconciliation | 0.8.0 | ✅ verified | $0.00-difference close; reconciledIn stamps |
| M9 reports (P&L, BS, tax estimate) | 0.10.0 | ✅ verified | figures tie to hand-math; BS structural balance tick |
| M10 inventory | 0.11.0 | ✅ verified | restocks post linked txns; weighted-avg cost |
| — feedback batch: per-account Review, transfers w/ counterpart matching, fee splits, subaccounts, owner-device fix | 0.12.0 | ✅ verified | see commit aee28a0 |
| M11 Muse → Back Office sync | — | ⛔ blocked | prerequisite: Muse §13 Worker auth (shared bearer token) |
| M12 QuickBooks Desktop IIF export | — | ⏳ next | lib/qb-iif.js + Settings export card |
| M13 processor sync (Helcim + Square) | — | 🆕 planned | pull payouts via APIs, match deposits to daily sales, auto-extract processing fees as expense lines, reconcile vs the Muse app. Muse Worker has a verified /helcim/transactions to borrow from (HELCIM-MIGRATION.md). Interim today: the % fee-split button in Review. |

Decisions added during the build: transfers post bank↔bank with auto-matching of the opposite staged row (±7 days) so statements never double-count; deposit fee-splits post gross income + fee expense + net cash in one txn; subaccounts are one level deep via parentId with `Parent › Child` labels everywhere; AI suggestions are gated server-side by per-business budget/pause and always lose to rules/history; app-owner devices are approvable only by owner sessions.
