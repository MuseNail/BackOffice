// ── lib: plaid-feed — cutoff + sync-result logic for bank feeds (pure) ────────
// Split out of plaid-connect.js so it can be tested: that module reaches `location`
// at import time (via config.js) and can't load under node. No DOM/IO here.
//
// The rule this file exists to enforce: a feed must never report success while
// delivering nothing. In 2026-07 a feed connected with the pre-filled cutoff staged
// 0 rows and burned its cursor, and a broken sync was indistinguishable from a quiet
// one — both rendered "No new transactions".

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// A calendar day after `date`, computed in UTC so it can't drift with the clock of
// whoever is looking.
export function suggestedCutoff(date) {
  if (!ISO.test(String(date || ''))) return null;
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// The owner's calendar day, NOT the UTC one: at 21:33 in California, toISOString()
// already says tomorrow, and pre-filling tomorrow as a cutoff means "skip everything".
export const todayLocal = (now = new Date()) => now.toLocaleDateString('en-CA');

// Exactly the 730 days the link token asks Plaid for — same number, so the cutoff can
// never be narrower than what the Item actually holds. Day arithmetic, not month
// arithmetic: Date.UTC(y-2, …) overflows a Feb-29 source into March. Asking for more
// than the Item holds is harmless; asking for less silently drops rows.
export const PLAID_DAYS_REQUESTED = 730;
export function farBackCutoff(now = new Date()) {
  return new Date(now.getTime() - PLAID_DAYS_REQUESTED * 86400000).toISOString().slice(0, 10);
}

// A row the FEED produced, as opposed to a statement the owner imported. Disconnecting
// a feed deliberately leaves its rows behind, so they outlive the feed — and counting
// them as "history we already hold" makes a RECONNECT suggest a cutoff of today, which
// is precisely the wipe this module exists to prevent, wearing a justification. Checked
// two ways because it guards a data-loss path: shapePlaidTxn is the only minting site.
const isFeedRow = (s) => s?.source?.app === 'plaid' || String(s?.id || '').startsWith('plaid-');

// The newest imported STATEMENT row for this account, or null.
export function lastImportedDate(stagedRows, bankacctId) {
  const dates = (stagedRows || [])
    .filter(s => s && s.bankacctId === bankacctId && !isFeedRow(s) && ISO.test(String(s.date || '')))
    .map(s => s.date)
    .sort();
  return dates.length ? dates[dates.length - 1] : null;
}

// Do we already hold this account's statement for some period?
//
// STAGED PROVENANCE ONLY. A posted transaction is NOT evidence: a transfer from
// another account posts a line on this account's ledger without its statement ever
// being imported, and an opening balance does the same. Honey-8002 held nothing but
// transfers-in from Business-6494 — treating those as history suggests a cutoff of
// "last week", which stages 0 rows and burns the cursor. Only an imported row proves
// the period is already covered and would duplicate.
export function feedHasHistory(stagedRows, bankacctId) {
  return lastImportedDate(stagedRows, bankacctId) !== null;
}

const ERRORS = {
  ITEM_LOGIN_REQUIRED: (n) => `${n} needs you to sign in at your bank again`,
  ITEM_LOCKED: (n) => `${n} is locked at your bank — sign in there to unlock it`,
  INVALID_ACCESS_TOKEN: (n) => `${n} lost its connection — disconnect the feed and connect it again`,
  INVALID_CREDENTIALS: (n) => `${n} was rejected by your bank — disconnect the feed and connect it again`,
  INSTITUTION_DOWN: (n) => `${n}'s bank is temporarily unavailable — try again later`,
  INSTITUTION_NOT_RESPONDING: (n) => `${n}'s bank isn't responding — try again later`,
  RATE_LIMIT_EXCEEDED: (n) => `${n} was asked too often — wait a minute and sync again`,
  PARTIAL_SYNC: (n) => `only part of ${n} synced — press Sync now again to pull the rest`,
};

// Plain English for one failed feed. Never leaks a Plaid error code at the owner,
// and never renders "undefined" for a code Plaid adds after this was written.
export function plaidErrorText(err) {
  const name = (err && err.name) || 'a bank feed';
  const fn = err && Object.hasOwn(ERRORS, err.code ?? '') && ERRORS[err.code];
  // Unknown code — most likely something Plaid added after this was written. Do NOT
  // default to "disconnect and reconnect": that is the one irreversible action here
  // (it destroys the Item and its history window), and it must never be blind advice.
  return fn ? fn(name) : `couldn’t reach ${name} — try again in a few minutes; if it keeps failing, check Settings → Diagnostics`;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const count = (n) => `${n} new transaction${n === 1 ? '' : 's'} in Review`;

// The single place that decides what a sync MEANT. The invariant, which the tests
// pin: a non-empty `errors` can never be reported as 'ok' or 'info'. Anything that
// reads `synced` without reading `errors` will lie the way the old code lied.
export function syncMessage({ synced = 0, errors = [], items = 0 } = {}) {
  const bad = (errors || []).filter(Boolean);
  if (bad.length) {
    const why = bad.map(plaidErrorText).join('; ');
    return { text: synced ? `${count(synced)} — but ${why}` : cap(why), kind: 'err' };
  }
  if (synced) return { text: count(synced), kind: 'ok' };
  if (!items) return { text: 'No bank feeds connected yet', kind: 'info' };
  return { text: 'Nothing new — your bank feeds are up to date', kind: 'info' };
}
