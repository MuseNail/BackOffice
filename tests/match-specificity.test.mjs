// node --test tests/match-specificity.test.mjs
// Word-aware matching + "most specific (longest matched term) wins" in suggestFor/vendorForRow,
// and the deliberate asymmetry: contains goes whole-word (stricter, kills false positives) while
// not-contains stays substring (keeps exclusion guards strong).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestFor, vendorForRow, matchesRule } from '../js/app/lib/match.js';

const V = (id, name, acct, matchers) => ({ id, name, defaultAccountId: acct, matchers });

test('word-aware kills the Arco↔Marco collision (both directions)', () => {
  const arco = V('arco', 'Arco', 'gas', { keywords: ['arco'] });
  const marco = V('marco', 'Marco Corona', 'labor', { keywords: ['marco tropoya'] });
  // Arco is listed FIRST, yet a Marco row no longer matches Arco at all
  assert.equal(suggestFor({ desc: 'zelle payment to marco tropoya ozuna' }, { vendors: [arco, marco] }).vendorId, 'marco');
  assert.equal(suggestFor({ desc: 'arco 914146 fullerton ca' }, { vendors: [arco, marco] }).vendorId, 'arco');
});

test('longest/most-specific wins for nested vendor names (Bijan case), regardless of list order', () => {
  const ahd = V('ahd', 'American Home Design', 'a', { keywords: ['american home design'] });
  const bijan = V('bijan', 'Bijan - American Home Design', 'b', { keywords: ['bijan - american home design'] });
  // American Home Design listed FIRST; the more-specific Bijan rule still wins the Bijan row
  assert.equal(suggestFor({ desc: 'bijan - american home design inv. 3972' }, { vendors: [ahd, bijan] }).vendorId, 'bijan');
  // a plain "american home design" row (no "bijan") still goes to AHD
  assert.equal(suggestFor({ desc: 'american home design' }, { vendors: [ahd, bijan] }).vendorId, 'ahd');
});

test('exact match (tier) beats any keyword regardless of order', () => {
  const exV = V('ex', 'Exact', 'x', { exact: ['nv energy'] });
  const kwV = V('kw', 'KW', 'y', { keywords: ['energy'] });
  for (const order of [[kwV, exV], [exV, kwV]]) {
    assert.equal(suggestFor({ desc: 'nv energy' }, { vendors: order }).vendorId, 'ex');
  }
});

test('specificity uses the single matched term length — never the SUM of a vendor’s keywords', () => {
  // A matches only on 'x' (len 1); its other keyword 'abcdefghij' is NOT present, so must NOT count.
  const a = V('a', 'A', 'x', { keywords: ['x', 'abcdefghij'] });
  const b = V('b', 'B', 'y', { keywords: ['tropoya'] });          // matched len 7
  assert.equal(suggestFor({ desc: 'x tropoya' }, { vendors: [a, b] }).vendorId, 'b');
});

test('OR-condition rule is scored by the matched branch (max), not the sum of all branches', () => {
  const marco = V('m', 'Marco', 'x', { conditions: [{ type: 'contains', text: 'marco tropoya' }, { type: 'contains', text: '1infiniteloop', conn: 'or' }] });
  const other = V('o', 'O', 'y', { keywords: ['zelle to marco'] });   // matched len 14 > branch 'marco tropoya' (13)
  // If branches were summed (13+13=26) marco would wrongly win; with max, the 14-char rule wins.
  assert.equal(suggestFor({ desc: 'zelle to marco tropoya' }, { vendors: [marco, other] }).vendorId, 'o');
});

test('a rule matched ONLY via negation ranks below any positive match, but still matches alone', () => {
  const neg = V('neg', 'Neg', 'x', { conditions: [{ type: 'not-contains', text: 'refund' }] });
  const pos = V('pos', 'Pos', 'y', { keywords: ['arco'] });
  assert.equal(suggestFor({ desc: 'arco 914' }, { vendors: [neg, pos] }).vendorId, 'pos');
  assert.equal(suggestFor({ desc: 'sale 123' }, { vendors: [neg] }).vendorId, 'neg');
});

test('contains conditions are word-aware', () => {
  assert.equal(matchesRule({ conditions: [{ type: 'contains', text: 'arco' }] }, { desc: 'marco tropoya' }), false);
  assert.equal(matchesRule({ conditions: [{ type: 'contains', text: 'arco' }] }, { desc: 'arco 914' }), true);
});

test('not-contains stays SUBSTRING so exclusions keep blocking glued variants', () => {
  const m = { conditions: [{ type: 'contains', text: 'amzn' }, { type: 'not-contains', text: 'prime' }] };
  assert.equal(matchesRule(m, { desc: 'amzn mktp us' }), true);
  assert.equal(matchesRule(m, { desc: 'amzn primevideo' }), false);   // 'prime' substring still excludes
});

test('vendorForRow also uses longest-wins and word-aware', () => {
  const ahd = { id: 'ahd', name: 'American Home Design', defaultAccountId: '', matchers: { keywords: ['american home design'] } };
  const bijan = { id: 'bijan', name: 'Bijan - American Home Design', defaultAccountId: '', matchers: { keywords: ['bijan - american home design'] } };
  assert.deepEqual(vendorForRow({ desc: 'bijan - american home design' }, [ahd, bijan]), { vendorId: 'bijan', vendorName: 'Bijan - American Home Design' });
  const arco = { id: 'arco', name: 'Arco', matchers: { keywords: ['arco'] } };
  assert.equal(vendorForRow({ desc: 'marco tropoya' }, [arco]), null);   // no longer mis-tags Marco as Arco
});
