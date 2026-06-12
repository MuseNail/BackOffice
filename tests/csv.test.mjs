// node --test tests/csv.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseDate, detectColumns, normalizeRows, dedupHash } from '../js/app/lib/csv.js';

test('parseCsv handles quotes, embedded commas/newlines, CRLF, blank lines', () => {
  const text = 'Date,Description,Amount\r\n06/08/2026,"SALLY BEAUTY, STORE #10382",-84.17\r\n\r\n06/07/2026,"He said ""hi""\nsecond line",1946.20\r\n';
  const { headers, rows } = parseCsv(text);
  assert.deepEqual(headers, ['Date', 'Description', 'Amount']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0][1], 'SALLY BEAUTY, STORE #10382');
  assert.equal(rows[1][1], 'He said "hi"\nsecond line');
});

test('parseDate covers US bank formats', () => {
  assert.equal(parseDate('2026-06-08'), '2026-06-08');
  assert.equal(parseDate('06/08/2026'), '2026-06-08');
  assert.equal(parseDate('6/8/26'), '2026-06-08');
  assert.equal(parseDate('06-08-2026'), '2026-06-08');
  assert.equal(parseDate('13/40/2026'), null);
  assert.equal(parseDate('not a date'), null);
});

test('detectColumns: chase-style headers', () => {
  const headers = ['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance', 'Check or Slip #'];
  const rows = [['DEBIT', '06/08/2026', 'SALLY BEAUTY', '-84.17', 'DEBIT_CARD', '23409.62', '']];
  const m = detectColumns(headers, rows);
  assert.equal(m.date, 1);
  assert.equal(m.desc, 2);
  assert.equal(m.amount, 3);
  assert.equal(m.debit, null);
});

test('detectColumns: debit/credit pair + headerless sniffing', () => {
  const m = detectColumns(['Date', 'Memo', 'Withdrawals', 'Deposits'], [['6/1/26', 'RENT', '4500.00', '']]);
  assert.equal(m.debit, 2);
  assert.equal(m.credit, 3);
  assert.equal(m.amount, null);

  const sniffed = detectColumns(['A', 'B', 'C'], [
    ['06/01/2026', 'COSTCO WHSE', '-212.46'],
    ['06/02/2026', 'HELCIM PAYOUT', '1946.20'],
    ['06/03/2026', 'NV ENERGY', '-318.40'],
    ['06/04/2026', 'SHELL OIL', '-48.03'],
    ['06/05/2026', 'ZELLE JANE', '600.00'],
  ]);
  assert.equal(sniffed.date, 0);
  assert.equal(sniffed.desc, 1);
  assert.equal(sniffed.amount, 2);
});

test('normalizeRows: single amount, pair, invert, rejects', () => {
  const single = normalizeRows([['06/08/2026', 'SALLY', '-84.17'], ['junk', 'x', 'y']], { date: 0, desc: 1, amount: 2 });
  assert.equal(single.good.length, 1);
  assert.equal(single.good[0].amountCents, -8417);
  assert.equal(single.bad.length, 1);

  const pair = normalizeRows([['6/1/26', 'RENT', '4500.00', ''], ['6/2/26', 'PAYOUT', '', '1946.20']], { date: 0, desc: 1, amount: null, debit: 2, credit: 3 });
  assert.equal(pair.good[0].amountCents, -450000);
  assert.equal(pair.good[1].amountCents, 194620);

  const inv = normalizeRows([['6/1/26', 'CARD CHARGE', '84.17']], { date: 0, desc: 1, amount: 2 }, { invert: true });
  assert.equal(inv.good[0].amountCents, -8417);
});

test('dedupHash is stable across whitespace/case noise', () => {
  const a = { date: '2026-06-08', desc: 'Sally Beauty #10382', amountCents: -8417 };
  const b = { date: '2026-06-08', desc: 'SALLY BEAUTY #10382', amountCents: -8417 };
  assert.equal(dedupHash(a), dedupHash(b));
  assert.notEqual(dedupHash(a), dedupHash({ ...a, amountCents: -8418 }));
});
