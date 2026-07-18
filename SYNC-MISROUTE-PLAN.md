# Wrong-business writes — fix plan (re-grounded to v0.71.7)

**Origin:** a $4,000 TIE Corp txn sat POSTED in Muse's books for a month (removed 2026-07-17). Root cause
diagnosed + a 3-layer fix twice-adversarially-reviewed in a prior session (notes: [[bo-wrong-business-writes]]).
This doc re-grounds that plan to the current code (repo now at v0.71.7; the prior plan said 0.71.6 and the
line numbers shifted 0 — `sync.js` is unchanged) and scopes **Layer 1** for build now.

## Root cause (plain English)
When BackOffice has a write it couldn't stamp with a business (an "orphan" — e.g. queued while signed out, or
a legacy pre-v0.70.1 row), the app **guesses** which business's books it belongs to — it sends it to whatever
business happens to be open. With two tabs open on different businesses, the guess can land a write in the wrong
company's ledger. That's how a TIE transaction ended up a second copy inside Muse.

## Technical root (verified against current code)
- The **guess** lives in two places: `flushOutbox` (`sync.js:144-147` — `!item.biz` → re-route to
  `wsBiz || getActiveBiz()`) and `syncNow` (`sync.js:106,111` — `biz: f.biz || b`).
- The vector is **cross-tab**: `flushing` is a per-tab guard (`sync.js:13,133`) but `bo_outbox` is ONE global
  localStorage key (`config.js:23`), so two tabs read the same queue head and each guesses its own destination.
- `dispatch` (`sync.js:73`) stamps `wsBiz || getActiveBiz()` at QUEUE time — that's the acting context, correct;
  it is NOT the guess. `wsBiz` is per-tab so it protects the stamp once set (Layer 2 hardens the load-window gap).

## The reviewed 3-layer fix (re-numbered — 0.71.7 is taken by the bank-feed UI)
- **Layer 1 — v0.71.8 (THIS build): never guess + fix the recovery UI.** Stop guessing an orphan's business;
  preserve it in the dead-letter log and let the owner route it by hand. Ships WITH the recovery UI (below) —
  shipping the "never guess" half alone is a REGRESSION (orphans would pile into a log that can't recover them
  and whose Clear-all deletes them).
- **Layer 2 — v0.71.9 (next): route by data.** A `getStateBiz()` (the business the loaded state actually belongs
  to) becomes the routing authority (`getStateBiz() || getActiveBiz() || wsBiz`), plus the empty-store stamp at
  `openBusiness`, a `ws.onmessage` business check, the `sync.js:170` self-heal guard, and — **the worst LIVE hole
  — Plaid.** Plaid connect/map/sync route by the shared `getActiveBiz()` and write server-side directly (no
  outbox, no stamp), so a wrong-tab connect binds a bank feed to the wrong business PERMANENTLY. Interim
  mitigation in force: **connect Plaid with only one BO tab open.**
- **Layer 3 — v0.71.10 (last): server stamp.** Client stamps `getStateBiz()` on each op; the Worker sets an
  unspoofable `X-Bo-Biz` header (beside `X-Bo-Role`/`X-Bo-User`, `index.js`); the DO's `apply()` rejects when
  both are present and differ → 409 → dead-letter. Belt-and-suspenders; a no-op without Layer 2.

## Layer 1 — concrete changes (this release)

### A. `sync.js` — never guess (dead-letter instead)
1. `flushOutbox` (:144-147): an orphan (`!item.biz`) is **dead-lettered** (`deadLetter(item, 'no-business')` +
   shift + continue) — delete the `wsBiz || getActiveBiz()` re-route. It still unjams the queue (it shifts), it
   just never guesses a destination.
2. `syncNow` (:105-117): **do not re-queue orphans.** Split the failed log — re-queue only entries WITH a `biz`
   (real rejections the owner may retry); leave `!biz` orphans in the failed log for the recovery UI. This closes
   the "syncNow re-queues an orphan → flush dead-letters it → loop + a `{serious:true}` push per tap" spam.
3. New export `saveOrphanTo(biz, op)`: push `{biz, op}` onto `bo_outbox` and `flushOutbox()` — the recovery UI's
   per-row "Save to these books" action calls it. (dispatch can't be reused — it re-stamps its own biz.)

### B. `views/settings.js drawFailedOps` — a recovery UI that can actually recover (non-negotiable with A)
1. **Readable rows.** Replace `fmtWhat` ("entity.upsert txn t-imp-…") with a human summary: for a txn
   (`op.value` with `payee`/`date`/`lines`) show **date · payee · amount** (sum the bank-side line via existing
   money formatting); fall back to `op.op kind` for non-txn ops.
2. **Per-row "Save to these books" for orphans.** An entry with `!e.biz` renders a small business picker (from
   `getBusinesses()`) + a "Save" button → `saveOrphanTo(chosenBiz, e.op)` + remove that entry from `LS.failed` +
   redraw. Entries WITH a `biz` stay view-only (a server rejection re-rejects on retry; that's not this bug).
   Orphans are visually flagged ("⚠️ not saved yet — choose its business").
3. **Clear-all refuses orphans.** Change `kept = log.filter(e => e.biz && e.biz !== biz)` (which DROPS orphans)
   to `kept = log.filter(e => !e.biz || e.biz !== biz)` (keeps orphans + other-biz; clears only THIS business's
   stamped diagnostic rejections). Update the copy to say orphans are kept ("un-saved writes stay until you file
   them").

### C. Money-derivation helper
Reuse `ui.js fmtMoney`/`acctAmount` + `lib/posting.js` (bank-line sum) for the row amount — no new money math.

## Testing (TDD)
Pure/unit where possible: a `syncNow`-splits-orphans-from-routable test and a `saveOrphanTo` round-trip
(orphan in failed → picked business → lands in outbox with that biz, gone from failed). The `flushOutbox`
dead-letter-orphan path and `drawFailedOps` rendering are covered by a small harness / manual owner check
(login-gated). ⚠️ Windows: `node --test --test-force-exit tests/<f>` per file. Do NOT regress `features.test.mjs`
(has 10 no-arg `setSnapshot` calls — Layer 1 doesn't touch `setSnapshot`, so they stay green).

## Out of scope for Layer 1 (recorded)
Plaid direct-write routing, `getStateBiz()`/route-by-data, `ws.onmessage` biz check, the `sync.js:170` guard,
server `X-Bo-Biz` stamp — all Layer 2/3. Also recorded, not fixed: `/ai/categorize` + `/suggest` cross-business
routing (a confidentiality concern), `deadLetter` `slice(0,100)` dropping entry #101.

## Release
Client-only (Layer 1 touches no Worker code). Version trio → 0.71.8 + a `changelog.js` entry. Push needs owner OK.

**Layer 1 SHIPPED** — v0.71.8, pushed `37ad19f`, Pages live 2026-07-17.

---

# Layer 2 — concrete build spec (v0.71.9) — route by the loaded business + Plaid

**The root fix.** Writes route by the **per-tab loaded business**, not the **shared** active-biz marker. A new
`getStateBiz()` — the business the current tab actually loaded, client-tracked from the `bizId` `openBusiness`
fetched for — becomes the routing authority. The shared `bo_active_biz` is last-tab-wins (`main.js:133`
`setActiveBiz(biz)`), so two tabs on different companies share it; `stateBiz` is per-tab module state, so each
tab routes to its OWN company. Client-only, no Worker change. (Grounded: `setSnapshot` stores only
`{meta,entities,seq}` — the DO can't know its own id, `meta` has the business NAME not its id (setup.js:111) —
so `stateBiz` is client-tracked, never derived from snapshot content.)

### A. store.js — the state-biz authority
- `let stateBiz = '';` · `export function getStateBiz(){ return stateBiz; }` · `export function setStateBiz(b){ stateBiz = b || ''; }`
- `setSnapshot(snap, biz)` sets `stateBiz = biz || ''` **unconditionally** — a no-arg call clears to `''` so routing
  falls back safely (never a stale-truthy WRONG value). `features.test.mjs`'s 10 no-arg `setSnapshot` calls stay green.

Also: `clearSession()` (session.js) calls `setStateBiz('')` — the idle path re-routes to login WITHOUT a reload, and
`stateBiz` is now the TOP routing authority, so a sign-out must clear it or it survives into the next user's session.

### B. sync.js — route by getStateBiz, close the load window
- import `getStateBiz, setStateBiz` from store.js.
- `openBusiness(bizId)`: synchronously `setStateBiz(bizId)` at the TOP. Empty-store stamp on BOTH cache-miss cases
  (wrong `_biz` AND `cached===null`): `if (cached && parsed._biz===bizId) setSnapshot(parsed, bizId); else
  setSnapshot({meta:null,entities:{},seq:0}, bizId)` — so the previous business's data is never shown/read during the
  fetch. **⚠️ BLOCKER GUARD (the fix the review caught):** after `await api('/b/'+bizId+'/state')`, apply ONLY when
  `getStateBiz()===bizId` — otherwise DISCARD the reply entirely (no `setSnapshot`, no cache write, no
  `replayOutboxLocal`, no `connectWS`). `openBusiness` is fired fire-and-forget + re-entrant from `main.js:133`, and
  `wsBiz`/`connectWS` are set only AFTER the await — so without this guard a slow business-A reply resolving after the
  user clicked business B re-stamps `stateBiz='A'` and the next txn routes to A. This REGRESSES today's fast-switch
  behavior; the guard is mandatory. Same guard in `resync(bizId)` (a late old-socket reply must not re-stamp/rewrite).
- `dispatch` (:73): `const biz = getStateBiz() || getActiveBiz() || wsBiz;` — per-tab first; `getActiveBiz` is
  synchronous but SHARED (could be another tab's); `wsBiz` is set only after an await, so LAST.
- `ws.onmessage`: **capture the socket's business in the closure** — in `connectWS` add `const socketBiz = bizId;`
  and gate `msg.op?.device!==deviceId() && socketBiz===getStateBiz()`. (A module-level `wsBiz===getStateBiz()` guard
  is a NO-OP — `connectWS` overwrites `wsBiz` to the new business on switch, so the old socket's closure reads the new
  value and passes; only a per-socket capture blocks a switched-away socket's still-queued frames.)
- 409 self-heal (:170): `if (item.biz===getStateBiz()) applyChange(item.op)` — healing a queued op for a DIFFERENT
  business than the one loaded must not corrupt the loaded state.
- `saveOrphanTo` (:135, from Layer 1): gate the optimistic apply on `biz===getStateBiz()` (was `wsBiz`) for
  consistency with the above (low priority; it self-corrects, but align the authority).

### C. Plaid + confidentiality sweep (drive by GREP, not a line list)
- **Plaid (the worst hole):** grep `banking.js` + `plaid-connect.js` for EVERY `getActiveBiz()` Plaid site — a fixed
  line list already missed one. Confirmed sites → `getStateBiz()`: `plaid-connect.js:154` (disconnect), `:206`
  (openPlaidLink), `:276` (linkExistingAccount), `:300` (connectedModal sync); **`banking.js:123` (`syncPlaid` "Sync
  now" — the load-bearing miss)** + `maybeLoadFeedIntel`. Evaluate `banking.js:114` (ledger href) / `:385` (post-import
  redirect) per-site. **`map`/`exchange` (206/276) are the permanent-misbind class** (bind a feed to the wrong
  company forever — Plaid has NO Layer-3 server backstop, it routes by URL path); `syncPlaid` (123) is B→B
  annoyance-grade (syncs the wrong-but-own business + mislabels the toast), still swept.
- **OAuth resume is SAFE (confirmed):** connect-time `{linkToken,bankacctId,biz,startDate}` is stashed in
  `sessionStorage`; `resumePlaidOAuth` threads `saved.biz` through `onConnected`/`map`/`exchange` — never re-reads the
  marker. The empty-store stamp intentionally does NOT cover the resume window (map write is safe; only a post-connect
  row count can read a stale store — a pre-existing cosmetic issue).
- **Confidentiality sweep:** add `invoices.js:243` + `:1057` (`/ai/match-invoices`) alongside `review.js`
  `/ai/categorize` → `getStateBiz()` (both POST this business's payments/invoices to an AI endpoint keyed by the shared
  marker → a two-tab cross-tenant leak). **Do NOT bare-swap `client.js:265` `/suggest`** — the client app is
  single-business (`getStateBiz()===getActiveBiz()` always), so a bare swap is zero-benefit and adds a `/b//suggest`
  failure surface; leave `getActiveBiz()`. Deferred + recorded (read-only, lower risk): Helcim `/processor/helcim/
  transactions` GETs (`review.js:1017`, `deposits.js:63`, `search.js`).

### D. setup.js — no change needed
`create()` POSTs raw to the explicit new `id` (not a guess), then `#/b/<id>/dashboard` → `openBusiness(id)` stamps
`stateBiz`; the empty-store stamp (B) closes the post-create window.

### Testing (TDD)
- Pure `routeBiz({stateBiz, activeBiz, wsBiz})` (`stateBiz || activeBiz || wsBiz`, blanks skipped) + test.
- **Blocker regression test:** an `openBusiness(A)` reply arriving after `setStateBiz(B)` must NOT change
  `getStateBiz()` nor write B's store (needs a testable seam — extract the guarded-apply into a pure/injectable unit,
  or a browser harness). This is the highest-value test.
- `setSnapshot(snap, biz)` set/clear of `stateBiz` (if store.js loads under node; else browser harness). ws-guard +
  Plaid routing = browser/manual. No `features.test.mjs` regression. ⚠️ Windows: `node --test --test-force-exit tests/<f>` per file.

### Out of scope → Layer 3 (v0.71.10): server `X-Bo-Biz` unspoofable stamp. Deferred polish: a loading spinner during
the empty-store window (safety covered by the empty clear); Helcim processor-read confidentiality sweep.

### Deferred to Layer 3 (display/nav only — server-enforced, not book-writes)
Left on the shared `getActiveBiz()` deliberately: `canEdit(...)` display gates in accounts/customers/vendors/ledger/
reconcile/inventory (fail-closed + server-enforced; each view's content is also getActiveBiz-derived, so internally
consistent), in-view navigation hrefs (`invoices.js:136/749/1129`, ledger/settings back-links), and the reports CSV
export filename. These are UI/nav affordances (they self-correct on `route()`), not cross-business writes. A Layer-3
pass can converge them on `getStateBiz()` for full per-tab consistency.

### Review record (Layer 2)
PLAN review (4-lens, ready-with-edits): 1 BLOCKER (stale-reply guard → B), 1 must (Plaid grep vs line-list → C), 5
should — all folded in. CODE review (3-lens + senior, ship-after-fixes): 1 HIGH — **`settings.js` `/registry` user/
device admin WRITES (create/update/reset-PIN/delete/revoke) were still on `getActiveBiz()`** (a real cross-business
write path + roster PII read; app-owner is a member of every business so no server backstop) → FIXED (`:49/:77` →
`getStateBiz`). Should-fixes applied: `banking.js:80` canEdit + `reports.js` tax rateKey/gate → `getStateBiz` (same-file
consistency + a device-local write). In-view nav hrefs + other canEdit gates deferred + documented (above).

**Layer 2 SHIPPED** — v0.71.9, pushed `8e246c0`, Pages live 2026-07-17.

---

# Layer 3 — concrete build spec (v0.71.10) — the server refuses a wrong-business write
### (v2 — rewritten from the 4-agent committee review, 2026-07-17 evening)

**Belt-and-suspenders, honestly scoped.** Layer 3 makes the SERVER able to refuse a misrouted `dispatch`
write instead of posting it silently into another company's ledger — refused LOUDLY (409 → dead-letter →
serious-error push) and recoverably (the write lands in the shipped recovery UI, not the bin).

**Honest threat model (committee must-fix):** the seal catches re-routes of STAMPED items — a corrupted or
hand-edited outbox, a future write path that routes a stamped op by the shared marker, a stale tab flushing a
stamped item to the wrong URL. It CANNOT catch a reintroduced *orphan-guess* (the original $4k class): an
orphan exists precisely because `getStateBiz()` was empty at dispatch, so there is no data-derived truth to
seal — that class stays protected by Layer 1's never-guess code and its tests, inherently. And Layer 3 is
prospective-only: it protects nothing already on disk. Also corrected: the premise "L1+L2 closed every known
dispatch misroute" was FALSE — the committee found a live hole (item 0).

## Item 0 — FIRST, separately revertible: the idle-lock stateBiz hole (LIVE BUG in v0.71.9)
Verified chain: `lockNow()` → `clearSession()` → `setStateBiz('')` with **no reload** (lock.js:31-38,
session.js:29-32); module `opened` (main.js:70) survives; re-entering the SAME business hits
`if (opened !== biz)` (main.js:133) ⇒ `openBusiness` never re-runs ⇒ `stateBiz` stays `''` while that
business's books render. Consequences, daily: writes go UNSEALED and route by the surviving per-tab `wsBiz` /
shared marker (the misroute class, alive today); the tab goes DEAF (broadcast gate `socketBiz===getStateBiz()`
sync.js:253 + resync guard :296 fail, live frames silently dropped); the 409 self-heal (:206) and
`saveOrphanTo` local apply (:145) mis-gate. Adjacent: a single-business non-owner's post-lock login writes the
SAME hash (login.js:77) ⇒ no `hashchange` ⇒ stuck on the login screen.
**Fix (client-only, tiny):** main.js:133 → `if (opened !== biz || getStateBiz() !== biz)` (re-opening the same
business is idempotent: re-stamp, cached snapshot, refetch with stale-guard, connectWS early-returns on an
open same-biz socket); login.js submit → if the target hash equals `location.hash`, dispatch a synthetic
`hashchange` (else the natural event fires — no double-route). Manual test: idle-lock → re-login → same
business ⇒ a write syncs sealed + live updates arrive; single-business non-owner post-lock login lands.

## Mechanism (all halves, one release)

**1. Client seal — `sync.js dispatch`.** Single-read, one value feeding BOTH route and seal (committee: make
"false 409 impossible" literal): `const sb = getStateBiz(); const biz = sb || getActiveBiz() || wsBiz;
if (sb) op._sealBiz = sb;` — assigned before `applyChange` runs any listener. Named **`_sealBiz`** (NOT
`_biz` — that identifier already means the snapshot-cache stamp at sync.js:40/:56/:298; three reviewers
independently tripped on the collision). Underscore = transport metadata, same convention as `_healed`. Never
seal from the fallback chain — `getActiveBiz()`/`wsBiz` are exactly the guesses the server must catch. The
seal rides the outbox through localStorage and survives `requeueRoutable` (strips only `_healed`).

**2. Unsealed-route telemetry — `sync.js dispatch`.** When `!sb` but a fallback routes the write
(`biz` truthy), fire a NON-serious `reportError('sync.unsealed-route', ...)` naming the fallback used. The
fallback chain is deliberately KEPT (availability: a stateBiz gap — item 0 proves they happen — must not brick
every write), but each unsealed route is now visible in Diagnostics. Decision recorded: revisit making
`getStateBiz()` the SOLE routing authority in a later release once this telemetry has stayed quiet for a
while — that would make "nothing unsealed can route" true by construction.

**3. Owner override — `sync.js saveOrphanTo`.** Set `op._sealBiz = biz` (the explicitly picked business)
before queueing. The owner's hand-filing IS the new authority — without the re-stamp, a wrong-business orphan
whose seal disagrees with the picked books would 409 forever.

**4. Worker header — `index.js` beside `X-Bo-Role`/`X-Bo-User` (:144-147).** `fwd.headers.set('X-Bo-Biz',
bizId)`. `bizId` comes from the URL path AFTER the membership gate; `.set` overwrites anything a client sent ⇒
unspoofable. Covers both the `/state` POST forward and the `/ws` upgrade (same `fwd`). No CORS change — the
browser never sends the header (and the CORS allowlist deliberately keeps it out).

**5. DO check — `business.js` + new pure `cloudflare/src/do/wrong-biz.js`.** `wrongBusiness(op, expectedBiz)`
⇒ true only when BOTH `op._sealBiz` and `expectedBiz` are truthy AND differ (the truth table is the contract,
pinned by tests), plus a **kill switch** (committee must-fix, see Rollback): the check is skipped when
`env.WRONG_BIZ_CHECK === 'off'`.
- `apply(op, actor = '', expectedBiz = '')` — the check is the FIRST statement, **above the `meta.set`
  branch** (a misrouted `meta.set` would overwrite another company's PROFILE and has no checks of its own):
  `if (this.env.WRONG_BIZ_CHECK !== 'off' && wrongBusiness(op, expectedBiz)) return { rejected: true,
  reason: 'wrong-business' };`
- `/state` POST handler (:305-309) passes `req.headers.get('X-Bo-Biz') || ''`.
- `/ws` attachment (:72-76) adds `biz: req.headers.get('X-Bo-Biz') || ''`; `webSocketMessage` (:578) passes
  `att.biz || ''`. The client sends no WS ops today (ping only) — gated anyway so a future re-enable can't
  silently bypass the seal. Pre-deploy hibernated attachments lack `biz` ⇒ read `''` ⇒ skip; additive, no crash.
- Internal callers unchanged and unaffected by design: `_sync/inbound`, `_suggest`, `_plaid/map|apply-sync|
  disconnect` build ops server-side (no seal) and pass no `expectedBiz`; `ai.js:137/:264` POST
  `https://do/b/x/state` with no header ⇒ skip. `setup.js create()` (:109-118) POSTs raw to the explicit new
  id — unstamped ⇒ skip (a seal there would be the id vs the id, a tautology).

**6. Client 409 handling — `flushOutbox` 409 branch, THROUGH the deadLetter machinery.** `reason ===
'wrong-business'` ⇒ dead-letter as an **orphan** via a new pure `orphanizeRejected(item, reason)` helper
(orphan-recovery.js) returning `{ biz: '', op, attempted: item.biz, reason, rejectedAt }`; `deadLetter` gains
an entry-shape path so the orphanized write flows through the SAME capped write + serious `reportError` as
every dead-letter (an inline localStorage write would silently bypass both — committee catch). Orphan-izing
routes it straight into the shipped recovery UI, where the L1 machinery already protects it: Clear-all keeps
it, syncNow won't re-queue it, claim-then-file prevents double-filing. The report MESSAGE names all three of
seal + attempted + `getStateBiz()` at rejection time — the report's structured `biz` field is the SHARED
marker (reporter.js:30) and must not be trusted for these entries (recorded). Push spam bounded server-side
(fingerprint dedupe + 1-push/hour per fingerprint + 40/min per-IP).

**7. Recovery-UI — `settings.js drawFailedOps`, reason-aware (committee: the current copy would LIE).** The
orphan row's hardcoded "held because no business was set" is false for a wrong-business orphan (a business WAS
set; the server refused it). For `e.reason === 'wrong-business'`: caption ≈ "refused — headed for
<attempted name>'s books but made in <seal name>'s; choose where to file it", pre-select `op._sealBiz` in the
picker, and show `attempted`. Fallback when the sealed id isn't in `getBusinesses()` (deleted business /
lost membership): neutral picker + raw id in the hint ("made in \"<id>\" — no longer in your list").
Legacy no-business orphans keep the current copy and neutral picker.

**8. Orphan-preserving dead-letter cap — `sync.js deadLetter` + pure `capFailedLog(log)`
(orphan-recovery.js).** Independent budgets (committee: a shared budget lets piled-up orphans starve the
rejection log): keep the newest **100 routable** AND the newest **200 orphans** (newest-first, consistent with
today's unshift). When the orphan cap actually evicts (oldest orphan dropped), fire
`reportError('sync.orphan-evicted', ..., {serious:true})` — the cap firing IS the siren. And `deadLetter`'s
storage write gets a quota-throw fallback: if `setItem` throws, `reportError` with the op's `describeWrite`
summary — never a bare swallow of a never-saved write.

**9. Cross-tab flush containment — `flushOutbox` (pre-existing silent-loss bug, same family).** `flushing` is
per-tab over the SHARED `bo_outbox`, so two tabs can process the same head; today the second tab's blind
`shift()` then removes the NEXT item unsent (silent loss). Containment: shift only when the current head still
JSON-matches the item just processed; otherwise skip the shift (the duplicate send is harmless — by-id +
stale-guard — and the next item survives). Full cross-tab flush locking stays out of scope.

## Deliberately OUT (with reasons — not oversight)
- **Plaid body-stamp:** a Plaid POST seals and routes from the SAME `getStateBiz()` read in the same tick —
  seal ≡ URL, a tautology (unlike dispatch→flush, where disk-time and other tabs intervene). Zero protection;
  excluded. Plaid misbind safety = L2's routing + the identity-confirm bind modal (v0.71.7).
- **Display/nav convergence** (remaining `canEdit` gates, in-view hrefs → `getStateBiz`): cosmetic,
  server-enforced, self-correcting — a separate no-Worker pass if the owner wants it.
- **`/registry/*` admin writes** (users/devices): no `/b/<biz>/` URL ⇒ the header mechanism cannot apply; they
  stay Layer-2-only. Verified: RegistryDO's `canManage` gates every user/device mutation against the PAYLOAD
  businessId server-side (registry.js:213), so the residual risk is exactly what L2's payload fix addressed.
- **Other write paths, each seen and exempt for cause:** `/sync/inbound` (machine token, target business fixed
  by Muse-side config); `/report` + `/push/*` (system DO instance, business-agnostic); `/auth/*`
  (pre-business); `/registry/businesses` create/delete (explicit id, setup.js:101); client-app `/suggest`
  (client.js:277 — op built server-side). Sweep found no other client write path.
- `/ai/categorize`-class confidentiality routing: recorded before, still separate.

## Migration / rollback / ordering
No schema or storage change: `op.value` (what the DO stores) is untouched; `_sealBiz` rides the op envelope
only (outbox + broadcast frames — `applyChange` reads `op/kind/value/id` and ignores it; verified across every
consumer). **No deploy-order constraint:** old client + new Worker/DO ⇒ no seal ⇒ skip; new client + old
Worker ⇒ seal ignored. **Mixed-tab window (recorded):** a stale ≤v0.71.9 tab flushing the shared outbox
dead-letters a wrong-business 409 as a STAMPED view-only row under the wrong business and syncNow bounces it
(bounded, 1-push/hr); it self-corrects the first time a NEW tab runs syncNow (re-queue → 409 → orphanize).
**Rollback (committee must-fix — the old claim was false):** after any wrong-business 409 has fired, a
client-ONLY rollback strands the orphan (v0.71.9 `saveOrphanTo` doesn't re-seal ⇒ filing to a non-seal
business 409s into a view-only stamped row). So: roll back the client only together with either the Worker or
the **kill switch** — `wrangler secret/var WRONG_BIZ_CHECK=off` disables the DO check without a code revert.
Default (unset) = ON.

## Testing (TDD) + verification
- `tests/wrong-biz.test.mjs` — predicate truth table (differ⇒reject; equal / no seal / no expected / neither ⇒
  pass) **plus the REQUIRED apply()-wiring test** (committee: `business.js` imports under node — empirically
  verified; `tests/stale-guard.test.mjs` already drives `bo.apply()` with a Map-backed mock storage): mismatch
  ⇒ `{rejected, reason:'wrong-business'}` for `entity.upsert`, `entity.bulkUpsert`, `entity.delete` AND
  `meta.set`; default `expectedBiz=''` ⇒ applies (internal-caller contract); matched seal+header ⇒ applies and
  the stale-guard still runs after; `WRONG_BIZ_CHECK==='off'` ⇒ skips. Pin the limitation: an unstamped op
  (empty stateBiz at dispatch) passes the predicate — the orphan-guess class is L1's to catch.
- `tests/orphan-recovery.test.mjs` additions: `requeueRoutable` preserves `_sealBiz` while stripping
  `_healed`; `orphanizeRejected` shape (biz:'' + attempted + op passthrough incl. `_sealBiz`); `capFailedLog`
  truth table (independent budgets, newest-kept, orphans never evicted by routable pressure, 200-cap eviction
  reported).
- All 26 existing test files stay green (⚠️ Windows: `node --test --test-force-exit tests/<f>` per file).
- Live probe — ONLY after `wrangler deploy` is confirmed; always a junk VENDOR op (never a txn; vendors are
  un-audited, guard-free, cleanly deletable). The crafted op MUST carry `value.id`, `value.updatedAt`, and
  `op.device = deviceId()` (else 'bad op' / echo-suppression muddies the result). Craft one outbox entry whose
  `op._sealBiz` names business A while `biz` names B → syncNow ⇒ expect 409 `wrong-business`, a serious report
  naming seal+attempted, and an orphan row pre-pointing at A with the refused-copy caption; file to A ⇒ lands;
  delete the junk vendor. **If the probe is ACCEPTED, the Worker isn't running the new code — delete the junk
  vendor from B and stop.** Then: a normal owner edit + a client-app suggest prove the happy path, and one
  Plaid "Sync now" tap on the connected Chase feed (zero-row sync still exercises `_plaid/apply-sync` →
  `apply()`) proves the internal callers survived the signature change — confirm no `lastError`.
- Item 0 manual test: idle-lock → re-login → same business ⇒ sealed write + live frames arrive; the
  single-business-user login lands (no stuck screen).

## Release
Client + Worker together: version trio → **0.71.10** (`js/app/config.js` APP_VERSION + `version.json` +
`sw.js` CACHE_NAME — no new client file, so NO precache-list change; `wrong-biz.js` is Worker-side, never in
the SW precache) + `changelog.js` plain-English entry. Commit order: item 0 hotfix FIRST as its own commit
(separately revertible / shippable alone if anything stalls), then the L3 mechanism. BO is main-only: commit
to main. `git push` AND `wrangler deploy` (account info@musenailandspa.com, from `cloudflare/`) each need the
owner's explicit OK.

### Review record (Layer 3 — PLAN, round 2: the 4-agent committee)
First attempt of the committee died on the session usage limit (zero output) — an inline 4-lens pass
substituted for the sign-off draft, then the committee RE-RAN post-reset against the revised plan. All four
verdicts: **ready-with-edits**. MUSTs (all folded): the **idle-lock stateBiz hole** — a live v0.71.9 misroute
+ deaf-tab bug, independently re-verified line-by-line before acceptance → item 0; the **rollback claim was
false** for client-only rollback post-409 → kill switch + pairing rule; the **threat model overclaimed** —
orphan-guess regressions are unstamped and invisible to the seal → honesty section + pinned test. SHOULDs
(folded): single-read seal; orphanize through deadLetter machinery via pure helper; independent cap budgets +
eviction siren + quota fallback; reason-aware recovery copy + missing-business fallback; wiring test promoted
to REQUIRED (node-importability proven); Plaid sync post-deploy check. NOTEs (folded): `_biz`→`_sealBiz`
rename (cache-stamp collision, flagged by 3/4 lenses); mixed-tab degraded-recovery window recorded; probe
recipe fields; exemption-list completions; telemetry caveat on the report `biz` field; cross-tab shift-guard
containment (pre-existing silent loss, same family). MODIFIED (not taken as proposed): "make `getStateBiz()`
the sole routing authority" — deferred; the fallback chain is kept for availability (item 0 proves stateBiz
gaps happen) with new unsealed-route telemetry (item 2) to build the evidence for a later sole-authority
release. Nothing else rejected — the committee's line refs were spot-checked and held.
