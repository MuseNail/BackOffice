// node --test tests/plaid-dedup.test.mjs
// Cross-feed / cross-source dedup for a Plaid sync.
//
// Plaid's transaction_id is unique PER ITEM, so re-linking a bank hands back brand-new
// ids for transactions already staged — the DO's id-only check couldn't see they were
// the same money. On 2026-07-17 that put Honey - 8002's Apr 20 → Jul 13 range in Review
// twice (83 rows across two feeds).
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshRows, stagedIndex } from '../cloudflare/src/do/plaid-dedup.js';
import { dedupHash } from '../js/app/lib/csv.js';

const row = (over = {}) => ({
  id: 'plaid-new1', bankacctId: 'ba-honey-8002', date: '2026-06-08',
  desc: 'BANH MI MINH NHAT YUCAIPA CA 06/06', amountCents: -5503,
  source: { app: 'plaid' }, status: 'pending', ...over,
});
const hashOf = (r) => dedupHash({ date: r.date, desc: r.desc, amountCents: r.amountCents });
const held = (acct, r, n = 1) => new Map([[acct, new Map([[hashOf(r), n]])]]);

test('a brand-new transaction is staged', () => {
  const out = freshRows([row()], new Map(), new Map(), 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].createdAt, 1);
});

test('the same row from the same feed is skipped (id match)', () => {
  const byId = new Map([['plaid-new1', row()]]);
  assert.deepEqual(freshRows([row()], byId, new Map(), 1), []);
});

// THE fix: a re-linked feed gives the same money a new id.
test('the same money from a DIFFERENT feed is skipped (content match)', () => {
  const out = freshRows([row({ id: 'plaid-DIFFERENT_ITEM_ID' })], new Map(), held('ba-honey-8002', row()), 1);
  assert.deepEqual(out, [], 'a reconnect must not re-stage what is already there');
});

test('money already imported from a statement is skipped', () => {
  const r = row({ bankacctId: 'ba-muse-ink' });
  assert.deepEqual(freshRows([r], new Map(), held('ba-muse-ink', r), 1), []);
});

test('an identical amount on a DIFFERENT account is still staged', () => {
  const out = freshRows([row({ bankacctId: 'ba-parents-8005', id: 'plaid-p1' })], new Map(), held('ba-honey-8002', row()), 1);
  assert.equal(out.length, 1, 'dedup is per-account — same shop, two cards, both real');
});

test('a genuine repeat purchase on another DAY is still staged', () => {
  const later = row({ id: 'plaid-n2', date: '2026-06-09' });
  assert.equal(freshRows([later], new Map(), held('ba-honey-8002', row()), 1).length, 1);
});

// ── the fingerprint is a COUNT, not a set ────────────────────────────────────
// Two $200 ATM withdrawals on one day share a fingerprint and are two real
// transactions. Treating it as a set silently drops the second — money that never
// reaches the books and nothing says so. That is the very failure this area exists to
// cure, so the budget must be spent, not merely consulted.
const atm = (over = {}) => row({ id: 'plaid-atm1', desc: 'WITHDRAWAL 05/26', amountCents: -20000, date: '2026-05-26', ...over });

test('two identical same-day transactions BOTH stage when we hold none', () => {
  const out = freshRows([atm(), atm({ id: 'plaid-atm2' })], new Map(), new Map(), 1);
  assert.equal(out.length, 2, 'two real ATM pulls, not one');
});

test('holding one of an identical pair stages exactly the other', () => {
  const out = freshRows([atm(), atm({ id: 'plaid-atm2' })], new Map(), held('ba-honey-8002', atm(), 1), 1);
  assert.equal(out.length, 1, 'we hold 1, we are offered 2, so 1 is new');
});

test('holding both of an identical pair stages neither', () => {
  const out = freshRows([atm(), atm({ id: 'plaid-atm2' })], new Map(), held('ba-honey-8002', atm(), 2), 1);
  assert.equal(out.length, 0);
});

// ── OFX/QFX provenance ───────────────────────────────────────────────────────
// banking.js stores `ofx:<fitid>` in dedupHash for an OFX row instead of a content
// hash. Trusting the stored field makes every OFX-imported row invisible here — and a
// credit-card statement (Muse Ink) is usually QFX, which is the headline case.
test('an OFX-imported row still blocks its Plaid twin', async () => {
  const ofxRow = { ...row({ id: 'imp-x-r1', source: { app: 'ofx' } }), dedupHash: 'ofx:20260608001' };
  const storage = fakeStorage([['staged:imp-x-r1', ofxRow]]);
  const { countByAcct } = await stagedIndex(storage);
  assert.deepEqual(freshRows([row()], new Map(), countByAcct, 1), [], 'content is recomputed, not trusted');
});

test('a row with no description is skipped, not thrown on', async () => {
  const storage = fakeStorage([['staged:bad', { id: 'bad', bankacctId: 'ba-x', date: '2026-01-01', amountCents: -1 }]]);
  const { countByAcct, byId } = await stagedIndex(storage);
  assert.equal(byId.size, 1);
  assert.equal(countByAcct.size, 0, 'unfingerprintable, so it guards nothing — but must not throw');
});

// ── same-feed edge cases ─────────────────────────────────────────────────────
test('a correction to a still-pending row is applied', () => {
  const byId = new Map([['plaid-new1', row({ amountCents: -5000 })]]);
  const out = freshRows([row()], byId, new Map(), 9);
  assert.equal(out.length, 1);
  assert.equal(out[0].amountCents, -5503);
  assert.equal(out[0].updatedAt, 9);
});

test('an already-approved row is never reverted', () => {
  const byId = new Map([['plaid-new1', row({ amountCents: -5000, status: 'approved' })]]);
  assert.deepEqual(freshRows([row()], byId, new Map(), 9), []);
});

test('the same id in added AND modified is emitted once', () => {
  const out = freshRows([row(), row()], new Map(), new Map(), 1);
  assert.equal(out.length, 1);
});

test('rows with no id do not throw', () => {
  assert.deepEqual(freshRows([{ id: '' }, null, undefined], new Map(), new Map(), 1), []);
});

// ── stagedIndex — the half that touches storage ──────────────────────────────
// storage.list() defaults to 128 keys. A short read here silently under-dedups, which
// is exactly how snapshot() once truncated.
function fakeStorage(entries) {
  const all = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return {
    async list({ prefix = '', limit = 128, startAfter } = {}) {
      let rows = all.filter(([k]) => k.startsWith(prefix));
      if (startAfter) rows = rows.filter(([k]) => k > startAfter);   // EXCLUSIVE
      return new Map(rows.slice(0, limit));
    },
  };
}

test('stagedIndex pages past the list limit', async () => {
  const entries = [];
  for (let i = 0; i < 2500; i++) {
    entries.push([`staged:p-${String(i).padStart(5, '0')}`, {
      id: `p-${i}`, bankacctId: 'ba-honey-8002', date: '2026-06-08', desc: 'ROW ' + i, amountCents: -100 - i,
    }]);
  }
  const { byId, countByAcct } = await stagedIndex(fakeStorage(entries));
  assert.equal(byId.size, 2500, 'every page must be read, or duplicates slip through');
  assert.equal(countByAcct.get('ba-honey-8002').size, 2500);
});

test('stagedIndex counts repeats of the same fingerprint', async () => {
  const same = (i) => [`staged:s${i}`, { id: 's' + i, bankacctId: 'ba-honey-8002', date: '2026-05-26', desc: 'WITHDRAWAL 05/26', amountCents: -20000 }];
  const { countByAcct } = await stagedIndex(fakeStorage([same(1), same(2)]));
  const m = countByAcct.get('ba-honey-8002');
  assert.equal([...m.values()][0], 2, 'two held, so two must be spent before a third stages');
});

// v0.71.11 "remembered delete": a soft-deleted row (status:'deleted') stays counted by
// stagedIndex — in byId (so a same-id re-sync is skipped) AND in countByAcct (so a re-LINKED
// copy with a new id but the same content is skipped too). This is why Delete stays gone.
test('a soft-deleted staged row still suppresses re-sync (same id AND re-linked content)', async () => {
  const deleted = { id: 'plaid-old', bankacctId: 'ba-honey-8002', date: '2026-06-08', desc: 'COSTCO WHSE', amountCents: -8042, status: 'deleted' };
  const { byId, countByAcct } = await stagedIndex(fakeStorage([['staged:plaid-old', deleted]]));
  assert.ok(byId.has('plaid-old'), 'deleted row must stay in byId to block a same-id re-sync');
  // same id → byId suppresses
  assert.deepEqual(freshRows([{ ...deleted, status: 'pending' }], byId, countByAcct, 2), []);
  // re-link (new id, same content) → the counted deleted row suppresses it via the budget
  assert.deepEqual(freshRows([{ ...deleted, id: 'plaid-relinked', status: 'pending' }], new Map(), countByAcct, 2), [],
    'a re-linked copy of a deleted row must not come back');
});

test('stagedIndex ignores rows with no bank account (Muse-sync rows)', async () => {
  const { byId, countByAcct } = await stagedIndex(fakeStorage([
    ['staged:sync-musenail-1', { id: 'sync-musenail-1', syncApp: 'musenail', date: '2026-06-08', desc: 'Cash sales', amountCents: 5000 }],
  ]));
  assert.equal(byId.size, 1);
  assert.equal(countByAcct.size, 0);
});
