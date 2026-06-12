// node --test tests/match.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestFor, normalizeDesc, guessVendorName } from '../js/app/lib/match.js';

const vendors = [
  { id: 'v-nv', name: 'NV Energy', defaultAccountId: 'utilities', matchers: { exact: ['NV ENERGY 7733 BILL PAY'], keywords: [] } },
  { id: 'v-sally', name: 'Sally Beauty', defaultAccountId: 'supplies', matchers: { exact: [], keywords: ['sally beauty'] } },
  { id: 'v-broken', name: 'No category', defaultAccountId: null, matchers: { keywords: ['orphan'] } },
];

test('exact rule beats keyword rule regardless of vendor order', () => {
  const kw = { id: 'v-kw', name: 'KW', defaultAccountId: 'wrong', matchers: { keywords: ['energy'] } };
  for (const order of [[kw, ...vendors], [...vendors, kw]]) {
    const s = suggestFor({ desc: 'nv energy 7733 bill pay' }, { vendors: order });
    assert.equal(s.vendorId, 'v-nv');
    assert.equal(s.by, 'rule');
  }
});

test('keyword matches case/whitespace-insensitively', () => {
  const s = suggestFor({ desc: '  SALLY   BEAUTY, #10382 ' }, { vendors });
  assert.equal(s.vendorId, 'v-sally');
  assert.equal(s.accountId, 'supplies');
});

test('rule without a category is skipped — and must not block the history fallback', () => {
  assert.equal(suggestFor({ desc: 'ORPHAN STORE' }, { vendors }), null);
  // the real-world bug: a category-less rule matched first and aborted everything
  const history = [{ desc: 'ORPHAN STORE', status: 'approved', categoryId: 'from-history', updatedAt: 1 }];
  assert.deepEqual(suggestFor({ desc: 'ORPHAN STORE' }, { vendors, history }), { accountId: 'from-history', by: 'history' });
});

test('history: most recent approved same-description wins; rules beat history', () => {
  const history = [
    { desc: 'COSTCO WHSE #1021', status: 'approved', categoryId: 'old-pick', updatedAt: 1 },
    { desc: 'costco  whse #1021', status: 'approved', categoryId: 'new-pick', updatedAt: 9 },
    { desc: 'COSTCO WHSE #1021', status: 'skipped', categoryId: 'skipped-pick', updatedAt: 99 },
    { desc: 'COSTCO WHSE #1021', status: 'pending', updatedAt: 100 },
  ];
  const s = suggestFor({ desc: 'COSTCO WHSE #1021' }, { vendors: [], history });
  assert.deepEqual(s, { accountId: 'new-pick', by: 'history' });

  const ruled = suggestFor({ desc: 'SALLY BEAUTY' }, { vendors, history: [{ desc: 'SALLY BEAUTY', status: 'approved', categoryId: 'other', updatedAt: 5 }] });
  assert.equal(ruled.by, 'rule');
});

test('no match → null; empty desc → null', () => {
  assert.equal(suggestFor({ desc: 'NEVER SEEN THIS' }, { vendors, history: [] }), null);
  assert.equal(suggestFor({ desc: '' }, { vendors }), null);
});

test('normalizeDesc + guessVendorName', () => {
  assert.equal(normalizeDesc('  Sally   BEAUTY  '), 'sally beauty');
  assert.equal(guessVendorName('SALLY BEAUTY, #10382'), 'Sally Beauty');
  assert.equal(guessVendorName('NV ENERGY 7733 BILL PAY'), 'Nv Energy Bill');
  assert.equal(guessVendorName('CHECK #1182'), 'Check');
});
