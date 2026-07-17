// node --test tests/plaid-accounts.test.mjs
// Which bank accounts Plaid Link offers, and which we accept back from /accounts/get.
// Credit cards were excluded until 2026-07; Muse Ink Unlimited - 7978 is a real CCARD
// in the books that could only be fed by hand-imported CSV.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_FILTERS, isSupportedAccount } from '../cloudflare/src/routes/plaid.js';

// A deliberate tripwire, not a tautology: this file's shape is what Plaid Link accepts
// verbatim ('credit card' with a SPACE, not credit_card), and the 2026-06 sandbox
// incident came from exactly this kind of unreviewed edit to Plaid config. Changing it
// should require changing this test on purpose.
test('the Link filter is pinned: checking, savings, credit card', () => {
  assert.deepEqual(ACCOUNT_FILTERS, {
    depository: { account_subtypes: ['checking', 'savings'] },
    credit: { account_subtypes: ['credit card'] },
  });
});

test('a depository account is accepted', () => {
  assert.equal(isSupportedAccount({ type: 'depository', subtype: 'checking' }), true);
  assert.equal(isSupportedAccount({ type: 'depository', subtype: 'savings' }), true);
});

test('a credit card is accepted', () => {
  assert.equal(isSupportedAccount({ type: 'credit', subtype: 'credit card' }), true);
});

// Feeding a mortgage/401k into a bank register would be nonsense, and Link's filters
// are a UI hint — /accounts/get can still return the whole item.
test('account types we have no register for are rejected', () => {
  for (const type of ['loan', 'investment', 'brokerage', 'other', '', null, undefined]) {
    assert.equal(isSupportedAccount({ type }), false, `type=${type} must be rejected`);
  }
  assert.equal(isSupportedAccount(null), false);
  assert.equal(isSupportedAccount(undefined), false);
  assert.equal(isSupportedAccount({}), false);
});

// Pins the accept-check as TYPE-only. Looser than the Link filter on purpose: some
// institutions return a null subtype, so enforcing the subtype list would reject working
// accounts. The consequence is that a credit/paypal or depository/cd account is accepted
// if the owner picks it — acceptable, since the picker shows exactly what they're mapping.
test('subtype is not checked — only the type', () => {
  assert.equal(isSupportedAccount({ type: 'loan', subtype: 'checking' }), false);
  assert.equal(isSupportedAccount({ type: 'credit', subtype: 'paypal' }), true);
  assert.equal(isSupportedAccount({ type: 'depository', subtype: 'cd' }), true);
  assert.equal(isSupportedAccount({ type: 'depository', subtype: null }), true);
});
