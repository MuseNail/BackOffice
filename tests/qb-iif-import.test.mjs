// node --test tests/qb-iif-import.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIifAccounts } from '../js/app/lib/qb-iif-import.js';

// A realistic QB Desktop export: the !ACCNT section interleaved with another
// section, mixed column orders, a subaccount, a credit card, a non-posting
// account, and an unrecognized type.
const IIF = [
  '!ACCNT\tNAME\tACCNTTYPE\tDESC',
  'ACCNT\tChecking\tBANK\tMain operating',
  'ACCNT\tVisa Card\tCCARD\t',
  'ACCNT\tSales\tINC\t',
  'ACCNT\tSupplies\tEXP\t',
  'ACCNT\tSupplies:Nail Polish\tEXP\t',
  'ACCNT\t"Cost of Goods, Sold"\tCOGS\t',
  'ACCNT\tEstimates\tNONPOSTING\t',
  'ACCNT\tWeird Account\tBOGUSTYPE\t',
  '!CUST\tNAME',
  'CUST\tNot an account\t',
].join('\r\n');

test('parseIifAccounts reads the !ACCNT section and maps QB types', () => {
  const { accounts } = parseIifAccounts(IIF);
  const byName = Object.fromEntries(accounts.map(a => [a.qbName, a]));

  assert.deepEqual(
    { type: byName['Checking'].type, qbType: byName['Checking'].qbType },
    { type: 'asset', qbType: 'BANK' });
  // CCARD lands as qbType CCARD → becomes a transfer target in pickers
  assert.deepEqual(
    { type: byName['Visa Card'].type, qbType: byName['Visa Card'].qbType },
    { type: 'liability', qbType: 'CCARD' });
  assert.equal(byName['Sales'].type, 'income');
  assert.equal(byName['Cost of Goods, Sold'].type, 'cogs', 'quoted field with comma');
});

test('subaccounts split into leaf name + parent path', () => {
  const { accounts } = parseIifAccounts(IIF);
  const sub = accounts.find(a => a.qbName === 'Supplies:Nail Polish');
  assert.equal(sub.name, 'Nail Polish');
  assert.equal(sub.parentName, 'Supplies');
});

test('non-posting and unknown types are skipped with a reason, not imported', () => {
  const { accounts, skipped } = parseIifAccounts(IIF);
  assert.ok(!accounts.some(a => a.qbName === 'Estimates'));
  assert.ok(!accounts.some(a => a.qbName === 'Weird Account'));
  assert.ok(!accounts.some(a => a.qbName === 'Not an account'), 'other sections ignored');
  assert.equal(skipped.find(s => s.qbName === 'Estimates').reason, 'non-posting');
  assert.equal(skipped.find(s => s.qbName === 'Weird Account').reason, 'unrecognized type');
});

test('column order is read from the header, not assumed', () => {
  const reordered = [
    '!ACCNT\tACCNTTYPE\tNAME',
    'ACCNT\tBANK\tSavings',
  ].join('\n');
  const { accounts } = parseIifAccounts(reordered);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].name, 'Savings');
  assert.equal(accounts[0].qbType, 'BANK');
});

test('empty / no-ACCNT input yields empty results, no throw', () => {
  assert.deepEqual(parseIifAccounts(''), { accounts: [], skipped: [] });
  assert.deepEqual(parseIifAccounts('!TRNS\tDATE\nTRNS\t6/1/2026'), { accounts: [], skipped: [] });
});
