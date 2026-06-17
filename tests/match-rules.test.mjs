import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesRule } from '../js/app/lib/match.js';

const row = (desc, amountCents = -1000) => ({ desc, amountCents });

test('contains / starts / exact / regex match types', () => {
  assert.equal(matchesRule({ conditions: [{ type: 'contains', text: 'SALLY' }] }, row('SALLY BEAUTY SUPPLY')), true);
  assert.equal(matchesRule({ conditions: [{ type: 'contains', text: 'SALLY' }] }, row('COSTCO WHSE')), false);

  assert.equal(matchesRule({ conditions: [{ type: 'starts', text: 'SALLY' }] }, row('SALLY BEAUTY')), true);
  assert.equal(matchesRule({ conditions: [{ type: 'starts', text: 'SALLY' }] }, row('BIG SALLY CO')), false);

  // exact compares normalized desc (lowercased, collapsed whitespace)
  assert.equal(matchesRule({ conditions: [{ type: 'exact', text: 'sally beauty' }] }, row('SALLY   BEAUTY')), true);
  assert.equal(matchesRule({ conditions: [{ type: 'exact', text: 'sally beauty' }] }, row('SALLY BEAUTY 2')), false);

  // regex runs against the raw description, case-insensitive
  assert.equal(matchesRule({ conditions: [{ type: 'regex', text: 'sally\\s*beauty' }] }, row('SALLYBEAUTY.COM')), true);
  assert.equal(matchesRule({ conditions: [{ type: 'regex', text: 'sally\\s*beauty' }] }, row('SALL')), false);
  // a broken regex never throws — it just doesn't match
  assert.equal(matchesRule({ conditions: [{ type: 'regex', text: '(' }] }, row('anything')), false);
});

test('ALL conditions must match', () => {
  const m = { conditions: [{ type: 'contains', text: 'AMZN' }, { type: 'contains', text: 'PRIME' }] };
  assert.equal(matchesRule(m, row('AMZN PRIME *123')), true);
  assert.equal(matchesRule(m, row('AMZN MKTP *123')), false);
});

test('direction gate: deposits-only / withdrawals-only', () => {
  const inOnly = { conditions: [{ type: 'contains', text: 'VENMO' }], direction: 'in' };
  assert.equal(matchesRule(inOnly, row('VENMO PAYMENT', 5000)), true);
  assert.equal(matchesRule(inOnly, row('VENMO CASHOUT', -5000)), false);

  const outOnly = { conditions: [{ type: 'contains', text: 'VENMO' }], direction: 'out' };
  assert.equal(matchesRule(outOnly, row('VENMO', -5000)), true);
  assert.equal(matchesRule(outOnly, row('VENMO', 5000)), false);
});

test('amount-range gate works on the absolute amount', () => {
  const m = { conditions: [{ type: 'contains', text: 'CHECK' }], amountMin: 1000, amountMax: 5000 };
  assert.equal(matchesRule(m, row('CHECK 1042', -2000)), true);
  assert.equal(matchesRule(m, row('CHECK 1042', -200)), false);   // below min
  assert.equal(matchesRule(m, row('CHECK 1042', -6000)), false);  // above max
});

test('no conditions never matches', () => {
  assert.equal(matchesRule({ conditions: [] }, row('anything')), false);
  assert.equal(matchesRule({}, row('anything')), false);
  assert.equal(matchesRule({ conditions: [{ type: 'contains', text: '' }] }, row('anything')), false);
});
