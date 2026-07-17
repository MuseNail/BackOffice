// TZ=America/Los_Angeles node --test tests/plaid-feed.test.mjs
// The salon is in Yucaipa, CA — the date tests are meaningless unless the clock is
// west of UTC, which is exactly where the today-is-tomorrow bug lives.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestedCutoff, farBackCutoff, todayLocal,
  lastImportedDate, feedHasHistory,
  syncMessage, plaidErrorText,
} from '../js/app/lib/plaid-feed.js';

// ── suggestedCutoff ───────────────────────────────────────────────────────────
// `since` is inclusive (routes/plaid.js: `if (t.date < since) continue` drops only
// EARLIER rows), so the day after the last import is the no-gap/no-overlap cutoff.
test('the cutoff is the day after the last imported row', () => {
  assert.equal(suggestedCutoff('2026-06-12'), '2026-06-13');
});

test('the cutoff rolls over months, years, and leap days', () => {
  assert.equal(suggestedCutoff('2026-06-30'), '2026-07-01');
  assert.equal(suggestedCutoff('2026-12-31'), '2027-01-01');
  assert.equal(suggestedCutoff('2028-02-28'), '2028-02-29');   // leap
  assert.equal(suggestedCutoff('2027-02-28'), '2027-03-01');   // non-leap
});

test('no last date means no suggestion', () => {
  for (const v of [null, undefined, '', 'nonsense']) assert.equal(suggestedCutoff(v), null);
});

// ── today / far-back ──────────────────────────────────────────────────────────
// The live bug this replaces: at 21:33 PDT on Jul 16, new Date().toISOString() says
// 2026-07-17. Pre-filling THAT as a cutoff means "ignore everything before tomorrow".
test('today is the local day, not the UTC day', () => {
  const evening = new Date('2026-07-17T04:33:00Z');       // 21:33 PDT on the 16th
  assert.equal(todayLocal(evening), '2026-07-16');
  assert.notEqual(todayLocal(evening), evening.toISOString().slice(0, 10));
});

// Day arithmetic, not month arithmetic: Date.UTC(y-2, 1, 29) silently overflows a
// Feb-29 source into March. Counting 730 days back also keeps this identical to the
// days_requested the link token sends, so the cutoff can't be narrower than the Item.
test('far-back cutoff is the same 730 days the link token asks Plaid for', () => {
  assert.equal(farBackCutoff(new Date('2026-07-16T12:00:00Z')), '2024-07-16');
  assert.equal(farBackCutoff(new Date('2027-01-01T12:00:00Z')), '2025-01-01');
  assert.equal(farBackCutoff(new Date('2028-02-29T12:00:00Z')), '2026-03-01');   // leap source, no overflow
});

// ── feedHasHistory — THE regression lock for the blocker ──────────────────────
// Honey-8002's only posted transactions are transfers IN from Business-6494. A
// transfer posts a line on Honey's ledger account WITHOUT Honey's statement ever
// being imported. Treating that as "history" suggests a recent cutoff, which stages
// 0 rows and burns the cursor — the exact failure of 2026-07-17, but recommended by
// the app. Only an imported statement row proves we already hold that period.
const staged = (bankacctId, date, over = {}) => ({ id: 's-' + date, bankacctId, date, ...over });

test('an account with only transfers posted from the other side has NO history', () => {
  // no staged rows at all — Honey's shape before it was ever connected
  assert.equal(feedHasHistory([], 'ba-honey-8002'), false);
  assert.equal(lastImportedDate([], 'ba-honey-8002'), null);
});

// Honey's shape TODAY: connected once, 40 rows the feed produced, still zero imported
// statements. Disconnect leaves those rows behind (DO /_plaid/disconnect keeps staged),
// so on the reconnect this module tells people to do, counting them would suggest a
// cutoff of "today" — the exact wipe of 2026-07-17, recommended by the app.
test('a previous feed\'s own rows are NOT history — a reconnect must not suggest today', () => {
  const feedRows = [
    { id: 'plaid-abc', bankacctId: 'ba-honey-8002', date: '2026-07-15', source: { app: 'plaid' } },
    { id: 'plaid-def', bankacctId: 'ba-honey-8002', date: '2026-04-20', source: { app: 'plaid' } },
  ];
  assert.equal(feedHasHistory(feedRows, 'ba-honey-8002'), false);
  assert.equal(lastImportedDate(feedRows, 'ba-honey-8002'), null);
});

test('a feed row is spotted by id even if source is missing', () => {
  const rows = [{ id: 'plaid-xyz', bankacctId: 'ba-honey-8002', date: '2026-07-15' }];
  assert.equal(feedHasHistory(rows, 'ba-honey-8002'), false);
});

// A real CSV import alongside feed rows still counts — and dates from the feed must not
// drag the suggestion forward past what was actually imported.
test('imported rows still count when feed rows sit alongside them', () => {
  const mixed = [
    staged('ba-muse-ink', '2026-06-12'),                                                   // CSV
    { id: 'plaid-new', bankacctId: 'ba-muse-ink', date: '2026-07-15', source: { app: 'plaid' } },
  ];
  assert.equal(feedHasHistory(mixed, 'ba-muse-ink'), true);
  assert.equal(lastImportedDate(mixed, 'ba-muse-ink'), '2026-06-12');   // NOT 07-15
});

test('imported statement rows are history', () => {
  const rows = [staged('ba-muse-ink', '2026-04-05'), staged('ba-muse-ink', '2026-06-12')];
  assert.equal(feedHasHistory(rows, 'ba-muse-ink'), true);
  assert.equal(lastImportedDate(rows, 'ba-muse-ink'), '2026-06-12');
});

test('another account\'s rows are not this account\'s history', () => {
  const rows = [staged('ba-business-6494', '2026-07-15')];
  assert.equal(feedHasHistory(rows, 'ba-honey-8002'), false);
  assert.equal(lastImportedDate(rows, 'ba-honey-8002'), null);
});

test('approved and skipped rows still prove we hold the period', () => {
  const rows = [staged('ba-muse-ink', '2026-05-01', { status: 'approved' }),
                staged('ba-muse-ink', '2026-05-09', { status: 'skipped' })];
  assert.equal(feedHasHistory(rows, 'ba-muse-ink'), true);
  assert.equal(lastImportedDate(rows, 'ba-muse-ink'), '2026-05-09');
});

// ── syncMessage — THE regression lock for "it lied about working" ─────────────
const err = (over = {}) => ({ name: 'Honey - 8002', code: 'ITEM_LOGIN_REQUIRED', message: '', ...over });

test('rows found says so, and counts singular properly', () => {
  assert.deepEqual(syncMessage({ synced: 27, items: 2 }), { text: '27 new transactions in Review', kind: 'ok' });
  assert.equal(syncMessage({ synced: 1, items: 1 }).kind, 'ok');
  assert.match(syncMessage({ synced: 1, items: 1 }).text, /^1 new transaction in Review$/);
});

test('genuinely nothing new is info, and says the feeds are fine', () => {
  const m = syncMessage({ synced: 0, errors: [], items: 2 });
  assert.equal(m.kind, 'info');
  assert.match(m.text, /up to date/);
});

// This is the whole point of the release: a broken feed used to render as
// "No new transactions" — identical to a healthy quiet one.
test('a FAILED sync is never reported as "nothing new"', () => {
  const m = syncMessage({ synced: 0, errors: [err()], items: 1 });
  assert.equal(m.kind, 'err');
  assert.doesNotMatch(m.text, /up to date|no new/i);
  assert.match(m.text, /Honey - 8002/);
});

test('some rows PLUS a broken feed still reports the failure', () => {
  const m = syncMessage({ synced: 12, errors: [err()], items: 2 });
  assert.equal(m.kind, 'err');           // never 'ok' while anything is broken
  assert.match(m.text, /12/);            // both facts must survive
  assert.match(m.text, /Honey - 8002/);
});

test('no feeds at all is not "nothing new"', () => {
  const m = syncMessage({ synced: 0, errors: [], items: 0 });
  assert.equal(m.kind, 'info');
  assert.match(m.text, /no bank feeds/i);
});

test('a partial sync (page guard hit) asks for another sync', () => {
  const m = syncMessage({ synced: 500, errors: [err({ code: 'PARTIAL_SYNC' })], items: 1 });
  assert.equal(m.kind, 'err');
  assert.match(m.text, /again/i);
});

test('several broken feeds are all named', () => {
  const m = syncMessage({ synced: 0, items: 2, errors: [err(), err({ name: 'Parents - 8005' })] });
  assert.equal(m.kind, 'err');
  assert.match(m.text, /Honey - 8002/);
  assert.match(m.text, /Parents - 8005/);
});

// ── plaidErrorText ────────────────────────────────────────────────────────────
test('a known error says what to do, in plain words', () => {
  const t = plaidErrorText(err({ code: 'ITEM_LOGIN_REQUIRED' }));
  assert.match(t, /Honey - 8002/);
  assert.match(t, /sign in/i);
  assert.doesNotMatch(t, /ITEM_LOGIN_REQUIRED/);   // no Plaid internals leaking
});

test('an unknown error never renders undefined', () => {
  for (const e of [err({ code: 'WHATEVER_NEW_CODE' }), err({ code: undefined }), { name: 'X' }, {}]) {
    const t = plaidErrorText(e);
    assert.doesNotMatch(t, /undefined|null|\[object/);
    assert.ok(t.length > 0);
  }
});
