// node --test tests/processor-match.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { helcimDayTotals, ledgerDayDebits, matchDeposit, helcimBatchTotals, matchDepositToBatch } from '../js/app/lib/processor-match.js';

test('helcimDayTotals groups approved txns by Mountain-Time day, refunds subtract', () => {
  const txns = [
    { dateCreated: '2026-06-10 09:12:00', status: 'APPROVED', type: 'purchase', amount: 100.5 },
    { dateCreated: '2026-06-10 18:40:11', status: 'APPROVED', type: 'purchase', amount: 49.5 },
    { dateCreated: '2026-06-10 19:00:00', status: 'APPROVED', type: 'refund', amount: 25 },
    { dateCreated: '2026-06-10 20:00:00', status: 'DECLINED', type: 'purchase', amount: 999 },
    { dateCreated: '2026-06-11 10:00:00', status: 'APPROVED', type: 'purchase', amount: 200 },
  ];
  assert.deepEqual(helcimDayTotals(txns), [
    { date: '2026-06-10', grossCents: 12500 },
    { date: '2026-06-11', grossCents: 20000 },
  ]);
});

test('ledgerDayDebits sums only positive (debit) lines on the clearing accounts', () => {
  const txns = [
    { date: '2026-06-10', status: 'posted', lines: [{ accountId: 'clearing', amountCents: 182300 }, { accountId: 'sales', amountCents: -182300 }] },
    { date: '2026-06-10', status: 'posted', lines: [{ accountId: 'clearing', amountCents: 15000 }, { accountId: 'giftliab', amountCents: -15000 }] },
    // a previously posted deposit transfer credits clearing — must NOT count
    { date: '2026-06-10', status: 'posted', lines: [{ accountId: 'bank', amountCents: 100000 }, { accountId: 'clearing', amountCents: -100000 }] },
    { date: '2026-06-11', status: 'void', lines: [{ accountId: 'clearing', amountCents: 5000 }, { accountId: 'sales', amountCents: -5000 }] },
  ];
  assert.deepEqual(ledgerDayDebits(txns, ['clearing']), [{ date: '2026-06-10', grossCents: 197300 }]);
});

test('matchDeposit prefers an exact (Fee Saver) day, then the smallest plausible fee', () => {
  const days = [
    { date: '2026-06-09', grossCents: 197300 },
    { date: '2026-06-10', grossCents: 150000 },
  ];
  // exact: deposit equals June 9 gross, two days later
  const exact = matchDeposit({ date: '2026-06-11', amountCents: 197300 }, days);
  assert.deepEqual(exact.days, ['2026-06-09']);
  assert.equal(exact.feeCents, 0);
  assert.equal(exact.exact, true);
  // fee case: deposit = June 10 gross minus a 2.5% fee
  const fee = matchDeposit({ date: '2026-06-12', amountCents: 146250 }, days);
  assert.deepEqual(fee.days, ['2026-06-10']);
  assert.equal(fee.feeCents, 3750);
});

test('matchDeposit can span consecutive days and rejects implausible fees', () => {
  const days = [
    { date: '2026-06-08', grossCents: 50000 },
    { date: '2026-06-09', grossCents: 70000 },
  ];
  // weekend batch: one deposit covers both days, small fee
  const span = matchDeposit({ date: '2026-06-11', amountCents: 118000 }, days);
  assert.deepEqual(span.days, ['2026-06-08', '2026-06-09']);
  assert.equal(span.feeCents, 2000);
  // a "fee" of 40% is not a payout match
  assert.equal(matchDeposit({ date: '2026-06-11', amountCents: 42000 }, days), null);
  // deposits larger than any window's gross never match
  assert.equal(matchDeposit({ date: '2026-06-11', amountCents: 500000 }, days), null);
});

test('helcimBatchTotals: gross per batch from APPROVED txns by cardBatchId, dateClosed from batches', () => {
  // verified shapes: batches carry NO amount; txns carry cardBatchId/amount/status/type
  const batches = [
    { id: 6642574, dateClosed: '2026-06-13 17:01:19', batchNumber: 4 },
    { id: 6645892, dateClosed: '0000-00-00 00:00:00', batchNumber: 5 },   // open → null close date
  ];
  const txns = [
    { transactionId: 1, cardBatchId: 6642574, status: 'APPROVED', type: 'purchase', amount: 94 },
    { transactionId: 2, cardBatchId: 6642574, status: 'DECLINED', type: 'purchase', amount: 94 },   // ignored
    { transactionId: 3, cardBatchId: 6642574, status: 'APPROVED', type: 'purchase', amount: 101 },
    { transactionId: 4, cardBatchId: 6642574, status: 'APPROVED', type: 'refund',   amount: 20 },   // subtracts
    { transactionId: 5, cardBatchId: 6645892, status: 'APPROVED', type: 'purchase', amount: 50 },
  ];
  const totals = helcimBatchTotals(txns, batches);
  const b4 = totals.find(t => t.batchId === '6642574');
  assert.equal(b4.grossCents, 17500);            // (94 + 101 − 20) * 100
  assert.equal(b4.txnCount, 3);                  // declined not counted
  assert.equal(b4.dateClosed, '2026-06-13');
  assert.equal(b4.batchNumber, 4);
  const b5 = totals.find(t => t.batchId === '6645892');
  assert.equal(b5.grossCents, 5000);
  assert.equal(b5.dateClosed, null);             // open batch
});

test('matchDepositToBatch: net deposit → batch, fee = gross − net; exact (Fee Saver) wins', () => {
  const totals = [
    { batchId: '1', batchNumber: 1, dateClosed: '2026-06-10', grossCents: 197300, txnCount: 8 },
    { batchId: '2', batchNumber: 2, dateClosed: '2026-06-11', grossCents: 150000, txnCount: 6 },
  ];
  // exact: deposit equals batch 1 gross, lands 1 day after close
  const exact = matchDepositToBatch({ date: '2026-06-11', amountCents: 197300 }, totals);
  assert.equal(exact.batchId, '1');
  assert.equal(exact.feeCents, 0);
  assert.equal(exact.exact, true);
  assert.equal(exact.lagDays, 1);
  // fee case: deposit = batch 2 gross − 2.5%, 2 days later
  const fee = matchDepositToBatch({ date: '2026-06-13', amountCents: 146250 }, totals);
  assert.equal(fee.batchId, '2');
  assert.equal(fee.feeCents, 3750);
  // deposit BEFORE the batch closed never matches that batch
  assert.equal(matchDepositToBatch({ date: '2026-06-09', amountCents: 197300 }, totals), null);
  // an implausible 40% "fee" is not a match
  assert.equal(matchDepositToBatch({ date: '2026-06-11', amountCents: 118380 }, totals), null);
  // open batch (no dateClosed) is never matched
  assert.equal(matchDepositToBatch({ date: '2026-06-12', amountCents: 5000 }, [{ batchId: '9', dateClosed: null, grossCents: 5000 }]), null);
});
