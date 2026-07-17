// node --test tests/plaid-accounts-view.test.mjs
// The client-safe view of a Plaid item. The DO's own /_plaid/items returns access
// TOKENS and is 404'd at the router for exactly that reason (a member could read the
// production token until 2026-07-17). This is the half that may be exposed, so the
// load-bearing assertion is that a token cannot survive the mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { publicItem } from '../cloudflare/src/routes/plaid.js';

const item = (over = {}) => ({
  accessToken: 'access-production-86524423-d1c7-41de-9ac7-750daeb346e1',
  itemId: 'vvLJDRg0OjfD5bVJVVMKfvjyJ6QgpaFMzX8oa',
  institution: 'Chase',
  cursor: 'CURSOR_SECRET_ISH',
  startDate: '2026-06-13',
  lastSyncAt: 1784263000000,
  bankacctByPlaidAcct: { acc_6494: 'ba-business-6494' },
  accounts: [
    { plaidAccountId: 'acc_6494', name: 'Business', mask: '6494', subtype: 'checking' },
    { plaidAccountId: 'acc_8002', name: 'Honey', mask: '8002', subtype: 'checking' },
    { plaidAccountId: 'acc_ink', name: 'INK BUSINESS UNLIMITED', mask: '7978', subtype: 'credit card' },
  ],
  ...over,
});

test('an access token can never survive the mapping', () => {
  const out = JSON.stringify(publicItem(item()));
  assert.doesNotMatch(out, /access-production|access-sandbox|accessToken/);
});

test('the cursor is not exposed either', () => {
  assert.doesNotMatch(JSON.stringify(publicItem(item())), /CURSOR_SECRET_ISH|cursor/);
});

test('it shows what the bank offered and where each account is mapped', () => {
  const p = publicItem(item());
  assert.equal(p.institution, 'Chase');
  assert.equal(p.startDate, '2026-06-13');
  assert.equal(p.accounts.length, 3);
  assert.deepEqual(p.accounts.map(a => a.mask), ['6494', '8002', '7978']);
  assert.equal(p.accounts.find(a => a.mask === '6494').mappedTo, 'ba-business-6494');
  assert.equal(p.accounts.find(a => a.mask === '8002').mappedTo, null);   // offered, not mapped
  assert.equal(p.accounts.find(a => a.mask === '7978').subtype, 'credit card');
});

test('a feed with no accounts or no mapping does not throw', () => {
  const bare = publicItem({ itemId: 'x' });
  assert.deepEqual(bare.accounts, []);
  assert.equal(bare.institution, 'Bank');
  assert.equal(bare.startDate, null);
});

test('a broken feed reports its error here too', () => {
  const p = publicItem(item({ lastError: { code: 'ITEM_LOGIN_REQUIRED', at: 1784263000000 } }));
  assert.equal(p.lastError.code, 'ITEM_LOGIN_REQUIRED');
});
