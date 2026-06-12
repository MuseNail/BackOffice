// node --test tests/qb-iif.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIif, qbAccountName, qbTypeFor } from '../js/app/lib/qb-iif.js';

const accounts = [
  { id: 'checking', name: 'Checking', type: 'asset', qbType: 'BANK', qbName: 'Checking' },
  { id: 'income', name: 'Service income', type: 'income', qbType: 'INC', qbName: 'Service Income' },
  { id: 'fees', name: 'Bank & processing fees', type: 'expense' },                      // no qbType → fallback
  { id: 'supplies', name: 'Supplies', type: 'expense', qbType: 'EXP' },
  { id: 'salon-sub', name: 'Salon', type: 'expense', qbType: 'EXP', parentId: 'supplies' },
];

const txns = [
  { id: 't1', date: '2026-06-10', payee: 'Muse - card sales', memo: 'includes\ttips', status: 'posted',
    lines: [{ accountId: 'checking', amountCents: 182300 }, { accountId: 'income', amountCents: -182300 }] },
  { id: 't2', date: '2026-06-11', payee: 'Supply run', checkNo: '1042', status: 'posted',
    lines: [{ accountId: 'salon-sub', amountCents: 4500 }, { accountId: 'checking', amountCents: -4500 }] },
  { id: 't3', date: '2026-06-12', payee: 'Void me', status: 'void',
    lines: [{ accountId: 'checking', amountCents: 100 }, { accountId: 'income', amountCents: -100 }] },
  { id: 't4', date: '2026-07-01', payee: 'Out of range', status: 'posted',
    lines: [{ accountId: 'checking', amountCents: 100 }, { accountId: 'income', amountCents: -100 }] },
];

test('qbTypeFor falls back by account type', () => {
  assert.equal(qbTypeFor(accounts[0]), 'BANK');
  assert.equal(qbTypeFor(accounts[2]), 'EXP');
  assert.equal(qbTypeFor({ type: 'liability' }), 'OCLIAB');
});

test('qbAccountName uses qbName and Parent:Child for subaccounts', () => {
  const byId = new Map(accounts.map(a => [a.id, a]));
  assert.equal(qbAccountName(accounts[1], byId), 'Service Income');
  assert.equal(qbAccountName(accounts[4], byId), 'Supplies:Salon');
});

test('buildIif writes the ACCNT section then balanced TRNS/SPL blocks', () => {
  const { text, count } = buildIif({ accounts, txns, from: '2026-06-01', to: '2026-06-30' });
  const lines = text.split('\r\n');
  assert.equal(lines[0], '!ACCNT\tNAME\tACCNTTYPE');
  assert.ok(lines.includes('ACCNT\tChecking\tBANK'));
  assert.ok(lines.includes('ACCNT\tSupplies:Salon\tEXP'));
  assert.ok(lines.includes('ACCNT\tBank & processing fees\tEXP'), 'fallback qbType');
  assert.equal(count, 2, 'void + out-of-range excluded');

  const t1trns = lines.find(l => l.startsWith('TRNS') && l.includes('Muse - card sales'));
  assert.equal(t1trns, 'TRNS\t\tGENERAL JOURNAL\t6/10/2026\tChecking\tMuse - card sales\t1823.00\t\tincludes tips');
  const t1spl = lines.find(l => l.startsWith('SPL') && l.includes('Muse - card sales'));
  assert.ok(t1spl.includes('\t-1823.00\t'), 'split side negative');

  const t2trns = lines.find(l => l.startsWith('TRNS') && l.includes('Supply run'));
  assert.ok(t2trns.includes('\tSupplies:Salon\t'), 'subaccount colon name in txn');
  assert.ok(t2trns.includes('\t1042\t'), 'checkNo rides DOCNUM');

  // every TRNS..ENDTRNS block sums to zero
  let sum = 0;
  for (const l of lines) {
    const c = l.split('\t');
    if (l.startsWith('TRNS') || l.startsWith('SPL')) sum += Math.round(parseFloat(c[6]) * 100);
    if (l === 'ENDTRNS') { assert.equal(sum, 0, 'block balanced'); sum = 0; }
  }
});

test('buildIif sanitizes tabs/newlines and ends with CRLF', () => {
  const { text } = buildIif({ accounts, txns: [txns[0]], from: '2026-06-01', to: '2026-06-30' });
  assert.ok(!text.includes('includes\ttips'), 'tab inside memo flattened');
  assert.ok(text.endsWith('\r\n'));
});
