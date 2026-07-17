# Bank-feed recovery UI — build plan (v2, post-adversarial-review)

**Status:** direction signed off in principle (owner: "card-enrichment + offer both, push full history",
2026-07-17). v1 of this plan went through a 4-lens adversarial review grounded in the live code; verdict
was **needs-rework** (2 blockers + 8 hardening items). This v2 folds them in. **Still needs the owner's
sign-off before any code**, plus one live pre-build check (below).

**Scope: client-only.** Server half already live: `GET /b/:biz/plaid/accounts` (owner/manager-only;
per-bank `{itemId, institution, startDate, lastSyncAt, lastError, accounts:[{plaidAccountId, name, mask,
subtype, mappedTo}]}`), `POST /b/:biz/plaid/map {itemId, plaidAccountId, bankacctId}`, and the fresh
connect flow `startPlaidConnect`. No worker change, no `wrangler deploy` — client version-trio bump only.

---

## ⚠️ Pre-build gate (BLOCKER from review — do this FIRST)

The whole "offered-but-unlinked" strip only renders for an account that appears as an **unmapped** entry
inside some connected Item's stored `accounts` list (`publicItem`, captured once per Item at connect,
never merged across Items). Memory (2026-07-17) says the Chase 6494 Item exposes **8002 Honey (unmapped)**
and **8005 Parents (unmapped)** — but the owner has since connected the Ink card, so state may have moved.

**Before writing code, confirm against the LIVE endpoint** (owner-assisted, since it's auth-gated): call
`GET /b/muse-nail-and-spa/plaid/accounts` and verify 8002/8005 are listed as unmapped on a Chase Item.
- If yes → build as below.
- If Honey/Parents are on a **separate** Chase login (not on the 6494 Item) → the offered strip is inert
  for them, and their real recovery is the existing per-card **Connect feed** (fresh full-history). The
  release then rescopes to: the diagnostic strip for whatever IS offered + the honest duplicate-expectation
  copy on `startPlaidConnect`. (Owner decides at that point.)

**Honest scoping note for sign-off:** "Get full history" is a *fresh connect*, which the existing
per-card **Connect feed** button already does. So the genuinely NEW value this release adds over today is:
(1) the **diagnostic** — you can see what each bank is offering vs. what's linked, per card; (2) the cheap
**Just link new** path (attach onto an existing feed, no second Plaid bill); (3) clearer recovery framing
+ the honest duplicate copy. Worth confirming you want all three, or a leaner cut.

## The problem (why)

The Banking cards show balance + "N in Review" + Connect/Sync/Disconnect, but nothing about **what the
bank is offering** — the blindness behind the Honey/Ink mysteries, while the answer already exists in
`plaid/accounts` with no UI on it. And attaching a second account from a connected bank today needs a full
re-link (a duplicate Item + a second Plaid bill).

## The design (what) — enrich existing cards; no merged panel

Keep every account card as-is (balance, Review count, existing buttons); add feed intelligence per card
from live `plaid/accounts` data (never hardcoded):

1. **Linked** (`bankacct.plaid` set): unchanged `feedHealth` line. (Optional: append "· history from
   `<startDate>`".)
2. **Offered-but-unlinked** (a non-cash card whose derived mask matches an unmapped offered account, and
   `!bankacct.plaid`): a blue strip that **names the offered account it found** — "Chase is offering a
   checking account ••8002 — its feed history isn't in your books yet" — with two actions:
   - **Get full history** (primary): `startPlaidConnect(bankacct)` — fresh Item, full back-history.
   - **Just link new** (quiet): **[REV] opens an identity-confirmation step** showing the offered
     account's real name + ••mask + subtype and asking the owner to confirm it feeds *this* book account,
     then `POST /plaid/map`. **Never a one-click bind on an inferred mask** (see Honesty/Safety).
3. **Cash / non-feed** (`kind==='cash'`, or a bank with no connection): **untouched**, no feed UI —
   enforced **in the pure matching module**, not just view copy.

**[REV] Deferred to a later slice (was in v1):** the **orphan-offered note** ("Chase is also offering
••XXXX — add a bank account") and the **"not offered" hint**. Both are the fragile-inference half; shipping
one while deferring the other was inconsistent, and the orphan copy can wrongly tell the owner to create a
duplicate register. v1 ships neither. **[REV] Dropped:** the standalone "Refresh feeds" button (the stored
offered-accounts list only changes when a new Item is connected, which already re-fetches).

## Honesty & safety constraints (baked in)

- **[REV — BLOCKER] No silent bind on inference.** The existing connect path *always* routes through
  `pickAccountModal` even for a single account, precisely because "a wrong bind feeds this register from
  the wrong account, and every approval after posts real money to the wrong place" (plaid-connect.js:52-55).
  A name-parsed mask is a **hint that decides which card shows the strip — never a basis to bind.** "Just
  link new" MUST show the offered account's real name/••mask/subtype and require an explicit confirm
  (mirroring `pickAccountModal`), so a wrong parse (e.g. a book account "Chase Ink 2019" parsing "2019")
  is caught by the human at a visible moment.
- **[REV] "New transactions only" copy is conditional.** Mapping onto an Item whose cursor is **null**
  (connected but never synced) backfills ~2yr from `startDate` (plaid.js:219,247-255) — so the "new only"
  promise is false there. Gate the copy on the target Item having a non-null cursor / prior `lastSyncAt`
  (the intel carries per-Item `lastSyncAt`); for a never-synced Item, say "transactions from now on land in
  Review to skip" instead. (Data-safe either way — all rows land staged, deduped by `plaid-dedup`.)
- **Get full history / duplicates.** Everything lands in Review; nothing posts without approval. The DO
  de-dupes fresh rows against that account's staged rows (pending + approved) by content fingerprint
  `date|amountCents|desc.toLowerCase()`, count-aware (`plaid-dedup.js`, live v0.71.6). Residual rows to
  *skip*: (a) transfers booked from the other account's import (Honey's whole balance is this shape);
  (b) a row whose date or wording differs between a prior CSV and the feed. The **Get-full-history confirm**
  states this and that a fresh connect is a separate feed (minor extra cost).
- **[REV] Result scoping.** "Just link new" reports **this** bankacct's outcome: count
  `entities('staged').filter(s => s.bankacctId === id)` and filter errors to `e.bankacctIds.includes(id)`
  (reuse `mapPlaid`'s pattern) — NOT `syncPlaid`'s fleet-wide `synced`/`errors`. Do **not** reuse
  `connectedModal` (its "fills in older history afterwards" line is false for a map-onto-existing).

## Where the code goes

- **New pure `js/app/lib/plaid-intel.js`** (no DOM; tested in `tests/`): `plaidIntel(bankaccts, items)`
  → per bankacct `{status:'linked'|'offered'|'none', candidates:[{itemId, plaidAccountId, name, mask,
  subtype, itemLastSyncAt}]}`. Rules **[REV]**:
  - `linked` — an offered account has `mappedTo === bankacct.id`.
  - Exclude `kind==='cash'` (and any non-feed kind) up front → always `none`.
  - Require a **non-empty, digits-only mask on BOTH sides**; an unparseable book name → `null` (never
    `''`, so `'' === ''` can't false-match a digit-less name to a blank-mask offered account, plaid.js:144).
  - `maskOf(bankacct)` = trailing ≥3-digit run of `bankacct.name` (an offered card never has
    `bankacct.plaid`, so `plaid.mask` never participates here).
  - **Duplicate-Item collapse:** group unmapped offered accounts by mask across ALL Items first. A mask
    offered by 2+ Items is ONE logical account (a re-link makes duplicates) → still `offered`, with all
    candidates; prefer a candidate whose Item has a non-null cursor/`lastSyncAt` for the "just link" target
    and for honest copy.
  - `offered` — a non-cash card, `!bankacct.plaid`, whose mask matches exactly one logical offered
    account. **Ambiguous** (a mask matching 2+ *cards*) → silent `none` (never the orphan note).
  - Institution is a **weak, case-folded hint only** (bankacct.institution is free-text/often blank;
    item.institution is Plaid-derived and may be "Chase"/"JPMorgan Chase"/"Bank") — never a required gate.
- **`js/app/views/banking.js`** (only view touched): on `render`, if
  `['owner','manager'].includes(roleFor(getActiveBiz()))`, fetch `GET /plaid/accounts` once → module
  state → re-`draw`; failure/403/501 degrades silently to today's cards. `drawBody` computes
  `plaidIntel(...)` and renders the strip for `offered` (+ optional history detail for `linked`). Events
  via `el({onclick})`/`addEventListener` (no inline HTML handlers).
- **`js/app/plaid-connect.js`**: `linkExistingAccount(bankacct, candidate)` — the identity-confirm →
  `POST /plaid/map` → `syncPlaid` → per-bankacct honest result (not `connectedModal`). Reuse
  `startPlaidConnect` for "Get full history"; add the duplicate-expectation line to its connect modal for
  the has-posted-but-no-imported-statements shape only (don't regress the normal first-connect copy).
- **CSS** in `css/styles.css` (a `.feed-offer` strip class), never inline in `index.html`.

## Data flow

`plaid/accounts` isn't in the synced snapshot (needs the server token blob) → one authenticated fetch on
Banking open (owner/manager only), cached in the view's module state, re-fetched after a successful **Just
link new** (synchronous map). **[REV]** Do NOT hang a re-fetch on `startPlaidConnect`'s return — for a big
bank it OAuth-redirects the whole tab and completes on the next boot via `resumePlaidOAuth`; the mount-time
fetch refreshes the strip after that reload. `bankacct.plaid` health stamps ride the snapshot, so linked
cards stay live without the fetch — and **[REV]** `offered` is gated on `!bankacct.plaid` so a just-linked
account can't keep offering itself if the items cache is stale or a re-fetch fails.

## Testing (TDD)

`tests/plaid-intel.test.mjs` (pure): linked match; offered match by name-parsed mask; **cash account never
`offered`**; **two-Items-one-mask (duplicate Item) → `offered`, NOT dropped**; **mask '' matches nothing**;
**no-digits name never `offered`**; **mask matching 2+ cards → silent none**; a mapped account never also
`offered`; **a just-linked account (`bankacct.plaid` set) never re-offers with a stale items cache**;
institution blank ≠ mismatch. Manual owner verify (login-gated): Honey shows the strip naming ••8002;
"Just link new" shows the identity confirm then links with a per-account honest result (no backfill
promise); "Get full history" runs the connect flow; 6494 unchanged; cash untouched; **a bookkeeper/client/
viewer sees no NEW feed strips** (note: a bookkeeper still sees the pre-existing Connect/Sync/Disconnect
buttons and gets 403s — a pre-existing, out-of-scope client/server gate mismatch, worth a one-line note).

## Release

Client-only. Bump the trio (`config.js` APP_VERSION + `version.json` + `sw.js` CACHE_NAME) + `changelog.js`
entry; precache `js/app/lib/plaid-intel.js` in `sw.js`. No `wrangler deploy`. Push needs the owner's OK.

## What the review changed (and what I rejected)

- **Blockers folded in:** (1) never bind a feed on an inferred mask — "Just link new" now requires an
  identity confirm; (2) added the live pre-build check that Honey/Parents are actually offered, with an
  honest rescope path + the "net-new value" note; (3) duplicate-Item collapse so the strip isn't dropped on
  the recovery targets, and the orphan note (which could tell the owner to add a duplicate account) is
  deferred entirely.
- **Hardening folded in:** cash excluded in the pure module; non-empty digits-only mask both sides; copy
  honesty for never-synced Items; `offered` gated on `!bankacct.plaid`; per-account result scoping;
  institution as a weak hint only; dropped the "Refresh feeds" button; deferred the orphan-offered note.
- **Rejected / out of scope:** the pre-existing bookkeeper client/server gate mismatch on the *existing*
  Connect/Sync/Disconnect buttons — real but not introduced here; the new surfaces are correctly hidden
  from bookkeepers. Captured as a one-line known-limitation + reworded manual-test bullet, no code change.
