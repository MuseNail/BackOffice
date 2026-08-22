// node --test tests/word-aware-match.test.mjs
// The word-aware matching primitive that fixes substring collisions (arco↔marco, aaa↔junk-id)
// while still matching whole tokens the bank jams together (arco914, ubereats). Letter-only
// boundary: digits & punctuation are boundaries, so a keyword must appear as a whole LETTER-run,
// not buried inside a bigger word. Also the search ranker (matchRank) built on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordAwareMatch, escapeRegex, matchRank } from '../js/app/lib/match.js';

test('matches a whole word, not a fragment inside a bigger word', () => {
  assert.equal(wordAwareMatch('arco 914146 fullerton ca', 'arco'), true);
  assert.equal(wordAwareMatch('zelle payment to marco tropoya ozuna', 'arco'), false); // m·arco
  assert.equal(wordAwareMatch('...p1baaaa00399419314', 'aaa'), false);                 // b·aaa·a
});

test('digits and punctuation are boundaries (jammed store numbers still match)', () => {
  assert.equal(wordAwareMatch('arco914', 'arco'), true);         // digit boundary
  assert.equal(wordAwareMatch('sq *bluebottle', 'bluebottle'), true);
  assert.equal(wordAwareMatch('amazon.com*abc', 'amazon'), true);
  assert.equal(wordAwareMatch('restaurant ubereats', 'ubereats'), true); // the jammed token itself
  assert.equal(wordAwareMatch('restaurant ubereats', 'eats'), false);    // fragment of it
});

test('multi-word terms match across a space, bounded by non-letters', () => {
  assert.equal(wordAwareMatch('sally beauty, #10382', 'sally beauty'), true);
  assert.equal(wordAwareMatch('special event insurance refund', 'special event insurance'), true);
  assert.equal(wordAwareMatch('specialeventinsurancexyz', 'special event insurance'), false);
});

test('terms with leading/trailing punctuation behave', () => {
  assert.equal(wordAwareMatch('check #1182 paid', '#1182'), true);
});

test('case- and whitespace-insensitive (inputs get normalized)', () => {
  assert.equal(wordAwareMatch('  ARCO   914 ', 'ArCo'), true);
});

test('empty term or empty desc → false', () => {
  assert.equal(wordAwareMatch('arco', ''), false);
  assert.equal(wordAwareMatch('', 'arco'), false);
});

test('never throws on regex-special terms; treats them literally', () => {
  assert.doesNotThrow(() => wordAwareMatch('buy a+b store', 'a+b'));
  assert.equal(wordAwareMatch('buy a+b store', 'a+b'), true);   // literal +, whole token
  assert.doesNotThrow(() => wordAwareMatch('anything', '('));
  assert.equal(wordAwareMatch('cost (net) 5', '(net)'), true);
});

test('escapeRegex escapes regex metacharacters', () => {
  assert.equal(escapeRegex('a+b.c'), 'a\\+b\\.c');
});

test('matchRank: exact 3 > whole-word 2 > partial 1 > none 0', () => {
  assert.equal(matchRank('Arco', 'arco'), 3);
  assert.equal(matchRank('Arco Gas Station', 'arco'), 2);
  assert.equal(matchRank('Marco Corona', 'arco'), 1);   // partial (inside marco)
  assert.equal(matchRank('Home Depot', 'arco'), 0);
  assert.equal(matchRank('Arco', ''), 0);
});
