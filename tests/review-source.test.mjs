// node --test tests/review-source.test.mjs
// The Review screen classifies each row by WHERE its suggestion came from (client / rule /
// AI / seen-before / none) to drive both the per-row chip AND a new source filter. This pins
// that ONE classifier so the chip and the filter can never disagree — it reproduces review.js
// rowCard's exact resolution (inactive-account nulling, AI fold, vendor-rule / ai-vendor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRowSuggestion, sourceMatches, SOURCE_META } from '../js/app/lib/review-source.js';

const acctMap = (...ids) => new Map(ids.map(([id, active]) => [id, { id, active }]));
const ACTIVE = acctMap(['a-exp', true], ['a-dead', false]);
const RULE_VENDOR = { id: 'v-costco', name: 'Costco', defaultAccountId: 'a-exp', matchers: { keywords: ['costco'] } };
const VENDOR_ONLY = { id: 'v-amz', name: 'Amazon', matchers: { keywords: ['amazon'] } }; // no defaultAccountId
const ctx = (over = {}) => ({ vendors: [], history: [], accountsById: ACTIVE, aiSug: null, ...over });

test('a client-suggested row is "client" even when a rule also matches', () => {
  const row = { desc: 'COSTCO #55', suggestedAt: 123, suggestedAccountId: 'a-exp' };
  assert.equal(resolveRowSuggestion(row, ctx({ vendors: [RULE_VENDOR] })).source, 'client');
});

test('a client split suggestion is "client"', () => {
  const row = { desc: 'X', suggestedSplit: [{ accountId: 'a-exp', amountCents: 100 }, { accountId: 'a-exp', amountCents: 200 }] };
  assert.equal(resolveRowSuggestion(row, ctx()).source, 'client');
});

test('a rule with an active account is "rule"', () => {
  const r = resolveRowSuggestion({ desc: 'COSTCO #9' }, ctx({ vendors: [RULE_VENDOR] }));
  assert.equal(r.source, 'rule');
  assert.equal(r.sug.by, 'rule');
  assert.equal(r.vendorTag.vendorName, 'Costco');
});

test('a rule whose account went INACTIVE folds to "vendor-rule" (account nulled, vendor still matches)', () => {
  const deadRule = { ...RULE_VENDOR, defaultAccountId: 'a-dead' };
  const r = resolveRowSuggestion({ desc: 'COSTCO #9' }, ctx({ vendors: [deadRule] }));
  assert.equal(r.source, 'vendor-rule');
  assert.equal(r.sug, null, 'the inactive-account suggestion must be nulled');
});

test('an AI suggestion with an active account (no rule/history) is "ai"', () => {
  const r = resolveRowSuggestion({ desc: 'SQ *BLUE BOTTLE' }, ctx({ aiSug: { accountId: 'a-exp', confidence: 88 } }));
  assert.equal(r.source, 'ai');
  assert.equal(r.sug.by, 'ai');
});

test('an AI suggestion whose account is inactive falls through to "none"', () => {
  const r = resolveRowSuggestion({ desc: 'SQ *X' }, ctx({ aiSug: { accountId: 'a-dead', confidence: 90 } }));
  assert.equal(r.source, 'none');
});

test('a prior approved row with the same description is "history" (seen before)', () => {
  const history = [{ desc: 'PG&E BILL', status: 'approved', categoryId: 'a-exp', updatedAt: 1 }];
  const r = resolveRowSuggestion({ desc: 'PG&E BILL' }, ctx({ history }));
  assert.equal(r.source, 'history');
  assert.equal(r.sug.by, 'history');
});

test('a vendor-only rule (no default account) is "vendor-rule"', () => {
  const r = resolveRowSuggestion({ desc: 'AMAZON MKTP' }, ctx({ vendors: [VENDOR_ONLY] }));
  assert.equal(r.source, 'vendor-rule');
  assert.equal(r.vendorTag.vendorName, 'Amazon');
});

test('an AI-extracted vendor name with no matching vendor is "ai-vendor"', () => {
  const r = resolveRowSuggestion({ desc: 'TST* SOME CAFE' }, ctx({ aiSug: { vendorName: 'Some Cafe' } }));
  assert.equal(r.source, 'ai-vendor');
  assert.equal(r.vendPrefillText, 'Some Cafe');
});

test('an AI vendor name that MATCHES an existing vendor becomes a vendor tag, not ai-vendor', () => {
  const r = resolveRowSuggestion({ desc: 'X' }, ctx({ vendors: [VENDOR_ONLY], aiSug: { vendorName: 'amazon' } }));
  assert.equal(r.source, 'vendor-rule');
  assert.equal(r.vendPrefillText, '');
});

test('nothing matches → "none"', () => {
  assert.equal(resolveRowSuggestion({ desc: 'MYSTERY CHARGE' }, ctx()).source, 'none');
});

test('sourceMatches folds vendor-rule under "rule" and ai-vendor under "ai"', () => {
  assert.equal(sourceMatches('all', 'none'), true);
  assert.equal(sourceMatches('rule', 'rule'), true);
  assert.equal(sourceMatches('rule', 'vendor-rule'), true);
  assert.equal(sourceMatches('rule', 'ai'), false);
  assert.equal(sourceMatches('ai', 'ai'), true);
  assert.equal(sourceMatches('ai', 'ai-vendor'), true);
  assert.equal(sourceMatches('client', 'client'), true);
  assert.equal(sourceMatches('none', 'history'), false);
});

test('SOURCE_META covers every source key the resolver can return', () => {
  for (const k of ['client', 'rule', 'ai', 'history', 'vendor-rule', 'ai-vendor', 'none']) {
    assert.ok(SOURCE_META[k] && SOURCE_META[k].icon && SOURCE_META[k].label, `missing meta for ${k}`);
  }
});
