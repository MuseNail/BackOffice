// node --test tests/resolve-vendor-field.test.mjs
// A client's vendor suggestion (an existing vendor id OR a typed name) must OVERRIDE any memorized
// rule / AI vendor in the Review row's Vendor field. Only when the client suggested NO vendor do we
// fall back to the rule/AI tag. (Regression: a client-typed vendor name was being replaced by a rule.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVendorField } from '../js/app/lib/review-source.js';

const RULE = { vendorId: 'v-rule', vendorName: 'Rule Vendor' };

test('client picked an existing vendor (id) → that id wins, even over a matching rule', () => {
  assert.deepEqual(
    resolveVendorField({ suggestedVendorId: 'v-client' }, RULE, 'AI Vendor'),
    { vendPreselect: 'v-client', vendPrefillText: '' });
});

test('client TYPED a vendor name → prefill the name, NOT the rule vendor (the bug)', () => {
  assert.deepEqual(
    resolveVendorField({ suggestedVendorName: 'Bob’s Supply' }, RULE, 'AI Vendor'),
    { vendPreselect: '', vendPrefillText: 'Bob’s Supply' });
});

test('client typed name, no rule/AI → still prefills the client name', () => {
  assert.deepEqual(
    resolveVendorField({ suggestedVendorName: 'Bob’s Supply' }, null, ''),
    { vendPreselect: '', vendPrefillText: 'Bob’s Supply' });
});

test('NO client vendor + a rule → the rule vendor fills in (unchanged)', () => {
  assert.deepEqual(
    resolveVendorField({ desc: 'ARCO 123' }, RULE, ''),
    { vendPreselect: 'v-rule', vendPrefillText: '' });
});

test('NO client vendor, no rule, AI prefill → the AI name prefills (unchanged)', () => {
  assert.deepEqual(
    resolveVendorField({ desc: 'X' }, null, 'AI Vendor'),
    { vendPreselect: '', vendPrefillText: 'AI Vendor' });
});

test('nothing suggested anywhere → empty', () => {
  assert.deepEqual(resolveVendorField({ desc: 'X' }, null, ''), { vendPreselect: '', vendPrefillText: '' });
  assert.deepEqual(resolveVendorField({}, null), { vendPreselect: '', vendPrefillText: '' });
});

test('client id wins over both a rule AND a client name (id takes priority)', () => {
  assert.deepEqual(
    resolveVendorField({ suggestedVendorId: 'v-client', suggestedVendorName: 'typed too' }, RULE, ''),
    { vendPreselect: 'v-client', vendPrefillText: '' });
});

test('client name is trimmed; whitespace-only name is treated as no name', () => {
  assert.deepEqual(
    resolveVendorField({ suggestedVendorName: '  Padded  ' }, null, ''),
    { vendPreselect: '', vendPrefillText: 'Padded' });
  // whitespace-only → no client vendor → falls back to the rule
  assert.deepEqual(
    resolveVendorField({ suggestedVendorName: '   ' }, RULE, ''),
    { vendPreselect: 'v-rule', vendPrefillText: '' });
});
