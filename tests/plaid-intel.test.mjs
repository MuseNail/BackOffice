// node --test tests/plaid-intel.test.mjs
// Per-card bank-feed status derived from GET /b/:biz/plaid/accounts. The load-bearing
// safety rule: a name-parsed last-four only DECIDES WHICH CARD shows the recovery strip;
// it never binds a feed (plaid-connect.js forces a human identity-confirm). These tests
// pin the matching so it can't silently mis-attribute, false-match, or drop the exact
// accounts the feature exists to recover.
import test from 'node:test';
import assert from 'node:assert/strict';
import { plaidIntel } from '../js/app/lib/plaid-intel.js';

const ba = (over = {}) => ({ id: 'ba-x', name: 'Account', kind: 'checking', institution: '', plaid: null, ...over });
const acc = (over = {}) => ({ plaidAccountId: 'acc_x', name: 'Acct', mask: '8002', subtype: 'checking', mappedTo: null, ...over });
const item = (accounts, over = {}) => ({ itemId: 'item-1', institution: 'Chase', startDate: '2026-06-13', lastSyncAt: 1784263000000, lastError: null, accounts, ...over });

test('a mapped account is linked, never offered', () => {
  const bankaccts = [ba({ id: 'ba-6494', name: 'Business - 6494' })];
  const items = [item([acc({ plaidAccountId: 'p6494', mask: '6494', mappedTo: 'ba-6494' })])];
  assert.equal(plaidIntel(bankaccts, items)['ba-6494'].status, 'linked');
});

test('an account already carrying bankacct.plaid is linked even if the items cache is stale', () => {
  const bankaccts = [ba({ id: 'ba-6494', name: 'Business - 6494', plaid: { itemId: 'item-1', mask: '6494' } })];
  const items = [item([acc({ plaidAccountId: 'p6494', mask: '6494', mappedTo: null })])];   // stale: still unmapped
  assert.equal(plaidIntel(bankaccts, items)['ba-6494'].status, 'linked');
});

test('an offered, unmapped account whose mask matches the card name is offered with a candidate', () => {
  const bankaccts = [ba({ id: 'ba-honey', name: 'Honey - 8002' })];
  const items = [item([acc({ plaidAccountId: 'p8002', name: 'Honey', mask: '8002', subtype: 'checking', mappedTo: null })])];
  const r = plaidIntel(bankaccts, items)['ba-honey'];
  assert.equal(r.status, 'offered');
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].plaidAccountId, 'p8002');
  assert.equal(r.candidates[0].itemId, 'item-1');
  assert.equal(r.candidates[0].mask, '8002');
  assert.equal(r.candidates[0].subtype, 'checking');
});

test('a cash account never gets an offer strip, even named with a matching digit run', () => {
  const bankaccts = [ba({ id: 'ba-drawer', name: 'Drawer 8002', kind: 'cash' })];
  const items = [item([acc({ mask: '8002', mappedTo: null })])];
  assert.equal(plaidIntel(bankaccts, items)['ba-drawer'].status, 'none');
});

test('a re-linked bank (same mask offered by two Items) stays offered, synced Item first', () => {
  const bankaccts = [ba({ id: 'ba-honey', name: 'Honey - 8002' })];
  const items = [
    item([acc({ plaidAccountId: 'a1', mask: '8002', mappedTo: null })], { itemId: 'item-A', lastSyncAt: 1784263000000 }),
    item([acc({ plaidAccountId: 'a2', mask: '8002', mappedTo: null })], { itemId: 'item-B', lastSyncAt: null }),
  ];
  const r = plaidIntel(bankaccts, items)['ba-honey'];
  assert.equal(r.status, 'offered');
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[0].itemId, 'item-A');   // synced item preferred for honest copy + linking
});

test('an offered account with an empty mask matches nothing', () => {
  const bankaccts = [ba({ id: 'ba-x', name: 'Something 8002' })];
  const items = [item([acc({ mask: '', mappedTo: null })])];
  assert.equal(plaidIntel(bankaccts, items)['ba-x'].status, 'none');
});

test('a book account with no digit run in its name is never offered', () => {
  const bankaccts = [ba({ id: 'ba-petty', name: 'Petty Cash', kind: 'checking' })];
  const items = [item([acc({ mask: '8002', mappedTo: null })])];
  assert.equal(plaidIntel(bankaccts, items)['ba-petty'].status, 'none');
});

test('when two cards derive the same mask, neither is offered (ambiguous card side)', () => {
  const bankaccts = [ba({ id: 'ba-honey', name: 'Honey 8002' }), ba({ id: 'ba-backup', name: 'Backup 8002' })];
  const items = [item([acc({ mask: '8002', mappedTo: null })])];
  const r = plaidIntel(bankaccts, items);
  assert.equal(r['ba-honey'].status, 'none');
  assert.equal(r['ba-backup'].status, 'none');
});

test('matching ignores institution (the confirm is the guard) — a blank institution still matches', () => {
  const bankaccts = [ba({ id: 'ba-honey', name: 'Honey - 8002', institution: '' })];
  const items = [item([acc({ mask: '8002', mappedTo: null })], { institution: 'JPMorgan Chase' })];
  assert.equal(plaidIntel(bankaccts, items)['ba-honey'].status, 'offered');
});

test('empty / missing inputs do not throw', () => {
  assert.deepEqual(plaidIntel([], []), {});
  assert.deepEqual(plaidIntel(undefined, undefined), {});
});

test('a 3-digit mask matches; a shorter offered mask cannot false-match a longer name run', () => {
  assert.equal(plaidIntel([ba({ id: 'ba-a', name: 'Acct 123' })], [item([acc({ mask: '123', mappedTo: null })])])['ba-a'].status, 'offered');
  assert.equal(plaidIntel([ba({ id: 'ba-b', name: 'Acct 5123' })], [item([acc({ mask: '123', mappedTo: null })])])['ba-b'].status, 'none');
});
