// node --test tests/invoice-ledger-status.test.mjs
// Fix B: per-invoice "is this recognized in my Back Office ledger?" classifier. This pins the
// pure rule (data in -> verdict out, no DOM/IO) that drives the invoice-detail badge + list dot.
// Grounded in the real TIE Corp data shapes (see FIXB plan): recognized income = NET income
// credits tagged to the invoice; the boundary is the earliest income date in the ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  incomeCreditsFor, incomeCreditsByInvoice, ledgerIncomeStart, classifyInvoiceLedger, ledgerStateFor, LEDGER_STATES,
} from '../js/app/lib/invoice-ledger-status.js';

// income accounts: general-income + a processing-fees contra (both TYPE income in the real data).
const INCOME = new Set(['general-income', 'processing-fees']);

// tiny txn builder: posted by default, lines = [{accountId, amountCents}]
const tx = (o) => ({ status: 'posted', lines: [], ...o });
// a card payment posting like i2g-cashflow: income -gross, clearing +net, processing-fees +passed
const cardPayment = (invoiceId, gross, passed = 0, date = '2026-01-15', extra = {}) => tx({
  id: 'i2gc-' + Math.round(gross) + '-' + date, date, invoiceId,
  source: { app: 'i2g-cashflow' },
  lines: [
    { accountId: 'general-income', amountCents: -gross },
    { accountId: 'invoice2go-clearing', amountCents: gross - passed },
    ...(passed ? [{ accountId: 'processing-fees', amountCents: passed }] : []),
  ],
  ...extra,
});
const inv = (o) => ({ id: 'inv-' + (o.number || '1'), paidCents: 0, balanceCents: 0, ...o });
const ctx = (txns, over = {}) => ({ txns, incomeIds: INCOME, incomeStart: '2025-10-01', ...over });

// ── incomeCreditsFor ──────────────────────────────────────────────
test('incomeCreditsFor sums NET income credits (gross minus passed-fee contra), posted + tagged only', () => {
  const txns = [cardPayment('inv-1', 10000, 300)]; // gross $100, passed $3 -> net recognized $97
  assert.equal(incomeCreditsFor(txns, 'inv-1', INCOME), 9700);
});

test('incomeCreditsFor ignores txns tagged to other invoices, staged/void txns, and non-income lines', () => {
  const txns = [
    cardPayment('inv-2', 10000),                                   // other invoice
    cardPayment('inv-1', 5000, 0, '2026-02-01', { status: 'staged' }), // not posted
    tx({ id: 'e', invoiceId: 'inv-1', lines: [{ accountId: 'rent', amountCents: 4000 }, { accountId: 'bank', amountCents: -4000 }] }), // no income line
  ];
  assert.equal(incomeCreditsFor(txns, 'inv-1', INCOME), 0);
});

test('incomeCreditsFor can go negative when a refund debits income (net-zero / reversed)', () => {
  const txns = [
    cardPayment('inv-1', 10000),
    tx({ id: 'refund', invoiceId: 'inv-1', lines: [{ accountId: 'general-income', amountCents: 10000 }, { accountId: 'bank', amountCents: -10000 }] }),
  ];
  assert.equal(incomeCreditsFor(txns, 'inv-1', INCOME), 0);
});

// ── ledgerIncomeStart ─────────────────────────────────────────────
test('ledgerIncomeStart = earliest posted income-crediting date; ignores clearing/expense-only + void txns', () => {
  const txns = [
    tx({ id: 'exp', date: '2025-08-01', lines: [{ accountId: 'rent', amountCents: 5000 }, { accountId: 'bank', amountCents: -5000 }] }), // earlier, but no income
    cardPayment('inv-1', 10000, 0, '2025-11-05'),
    cardPayment('inv-2', 20000, 0, '2025-10-01'),
    tx({ id: 'v', date: '2025-09-01', status: 'void', lines: [{ accountId: 'general-income', amountCents: -1 }, { accountId: 'bank', amountCents: 1 }] }), // void, ignored
  ];
  assert.equal(ledgerIncomeStart(txns, INCOME), '2025-10-01');
});

test('ledgerIncomeStart ignores garbage pre-2000 dates so one bad import row cannot collapse the boundary', () => {
  const txns = [
    cardPayment('inv-x', 999, 0, '1970-01-01'), // epoch garbage
    cardPayment('inv-1', 10000, 0, '2025-10-01'),
  ];
  assert.equal(ledgerIncomeStart(txns, INCOME), '2025-10-01');
});

test('ledgerIncomeStart returns null when the ledger has no income', () => {
  const txns = [tx({ id: 'exp', date: '2026-01-01', lines: [{ accountId: 'rent', amountCents: 5000 }, { accountId: 'bank', amountCents: -5000 }] })];
  assert.equal(ledgerIncomeStart(txns, INCOME), null);
});

// ── classifyInvoiceLedger ─────────────────────────────────────────
test('fully recognized (rec ~= paid) -> linked-full green', () => {
  const txns = [cardPayment('inv-1', 20000)];
  const r = classifyInvoiceLedger(inv({ number: '1', id: 'inv-1', paidCents: 20000 }), ctx(txns));
  assert.equal(r.state, 'linked-full');
  assert.equal(r.recognizedCents, 20000);
  assert.equal(LEDGER_STATES[r.state].cls, 'green');
});

test('#4097 shape: Invoice2go shows $0 paid but income IS tagged -> linked-full (rec computed FIRST, never hidden)', () => {
  const txns = [cardPayment('inv-4097', 50000)];
  const r = classifyInvoiceLedger(inv({ number: '4097', id: 'inv-4097', paidCents: 0, totalCents: 0 }), ctx(txns));
  assert.equal(r.state, 'linked-full');
  assert.equal(r.recognizedCents, 50000);
});

test('#4081 shape: only part of the paid amount is recognized -> linked-partial blue (not fake green)', () => {
  const txns = [cardPayment('inv-4081', 201000)]; // $2,010 recognized
  const r = classifyInvoiceLedger(inv({ number: '4081', id: 'inv-4081', paidCents: 830000 }), ctx(txns));
  assert.equal(r.state, 'linked-partial');
  assert.equal(r.recognizedCents, 201000);
  assert.equal(LEDGER_STATES[r.state].cls, 'blue');
});

test('#3983 shape: more income tagged than Invoice2go shows paid -> still linked-full green, real number kept', () => {
  const txns = [cardPayment('inv-3983', 1320000)];
  const r = classifyInvoiceLedger(inv({ number: '3983', id: 'inv-3983', paidCents: 1015000 }), ctx(txns));
  assert.equal(r.state, 'linked-full');
  assert.equal(r.recognizedCents, 1320000);
});

test('#3930 shape: a tagged txn that credits NO income + zero recognized -> unlinked, NOT linked', () => {
  const txns = [tx({ id: 'csv1', date: '2026-04-22', invoiceId: 'inv-3930', source: { app: 'csv' }, lines: [{ accountId: 'invoice2go-clearing', amountCents: 754000 }, { accountId: 'bank', amountCents: -754000 }] })];
  const r = classifyInvoiceLedger(inv({ number: '3930', id: 'inv-3930', paidCents: 754000, date: '2025-09-09', datePaid: '2026-03-31' }), ctx(txns));
  assert.equal(r.state, 'unlinked');
  assert.equal(r.recognizedCents, 0);
});

test('paid before the income boundary, unlinked -> pre-books gray', () => {
  const r = classifyInvoiceLedger(inv({ number: '2759', paidCents: 185000, date: '2022-03-15', datePaid: '2022-08-08' }), ctx([]));
  assert.equal(r.state, 'pre-books');
  assert.equal(LEDGER_STATES[r.state].cls, 'gray');
});

test('datePaid overrides a stale converted-estimate invoice date: in-window + unlinked -> unlinked (not pre-books)', () => {
  const r = classifyInvoiceLedger(inv({ number: 'c', paidCents: 100000, date: '2025-09-01', datePaid: '2026-05-01' }), ctx([]));
  assert.equal(r.state, 'unlinked');
});

test('datePaid override with linked income short-circuits to linked-full regardless of the stale date', () => {
  const txns = [cardPayment('inv-c', 100000)];
  const r = classifyInvoiceLedger(inv({ number: 'c', id: 'inv-c', paidCents: 100000, date: '2025-09-01', datePaid: '2026-05-01' }), ctx(txns));
  assert.equal(r.state, 'linked-full');
});

test('QuickBooks-history (qb-detail) income tagged to an invoice reads linked-full (Decision 2: green = in your ledger)', () => {
  const txns = [tx({ id: 'qb-1', date: '2025-11-01', invoiceId: 'inv-q', source: { app: 'qb-detail' }, lines: [{ accountId: 'general-income', amountCents: -60000 }, { accountId: 'bank', amountCents: 60000 }] })];
  const r = classifyInvoiceLedger(inv({ number: 'q', id: 'inv-q', paidCents: 60000 }), ctx(txns));
  assert.equal(r.state, 'linked-full');
  assert.equal(r.recognizedCents, 60000);
});

test('unpaid (paidCents 0) with no recognized income -> unpaid (indicator hidden)', () => {
  const r = classifyInvoiceLedger(inv({ number: 'u', paidCents: 0 }), ctx([]));
  assert.equal(r.state, 'unpaid');
});

test('a fully-refunded invoice (net income 0) reads not-linked, never linked', () => {
  const txns = [
    cardPayment('inv-r', 10000),
    tx({ id: 'refund', invoiceId: 'inv-r', date: '2026-02-01', lines: [{ accountId: 'general-income', amountCents: 10000 }, { accountId: 'bank', amountCents: -10000 }] }),
  ];
  const r = classifyInvoiceLedger(inv({ number: 'r', id: 'inv-r', paidCents: 10000, datePaid: '2026-01-20' }), ctx(txns));
  assert.notEqual(r.state, 'linked-full');
  assert.notEqual(r.state, 'linked-partial');
});

test('no income in the ledger (incomeStart null): a paid+unlinked invoice reads unlinked, never mislabeled pre-books', () => {
  const r = classifyInvoiceLedger(inv({ number: 'n', paidCents: 5000, date: '2020-01-01', datePaid: '2020-02-01' }), ctx([], { incomeStart: null }));
  assert.equal(r.state, 'unlinked');
});

test('paid but no dates at all + unlinked -> unlinked (falsy paidWhen skips the pre-books test)', () => {
  const r = classifyInvoiceLedger(inv({ number: 'nd', paidCents: 5000, date: undefined, datePaid: undefined }), ctx([]));
  assert.equal(r.state, 'unlinked');
});

test('staged (unposted) income tagged to the invoice does not count as recognized', () => {
  const txns = [cardPayment('inv-s', 30000, 0, '2026-03-01', { status: 'staged' })];
  const r = classifyInvoiceLedger(inv({ number: 's', id: 'inv-s', paidCents: 30000, datePaid: '2026-03-01' }), ctx(txns));
  assert.equal(r.state, 'unlinked');
});

// ── incomeCreditsByInvoice (the list-view one-pass: MUST match incomeCreditsFor per invoice) ──
test('incomeCreditsByInvoice equals incomeCreditsFor for every invoice (list dot can never disagree with the detail badge)', () => {
  const txns = [
    cardPayment('inv-1', 10000, 300),   // +9700
    cardPayment('inv-1', 5000),         // +5000
    tx({ id: 'ref', invoiceId: 'inv-1', date: '2026-02-01', lines: [{ accountId: 'general-income', amountCents: 2000 }, { accountId: 'bank', amountCents: -2000 }] }), // -2000 refund
    cardPayment('inv-2', 20000),
    cardPayment('inv-3', 30000, 0, '2026-01-01', { status: 'staged' }), // unposted -> excluded
  ];
  const byInv = incomeCreditsByInvoice(txns, INCOME);
  for (const id of ['inv-1', 'inv-2']) assert.equal(byInv.get(id), incomeCreditsFor(txns, id, INCOME));
  assert.equal(byInv.get('inv-1'), 12700);
  assert.equal(byInv.has('inv-3'), false); // staged/none -> absent (matches incomeCreditsFor === 0)
});

// ── ledgerStateFor (the list-view path: same decision, from a precomputed recognized total) ──
test('tolerance boundary: rec == paid − tol reads linked-full; one cent less reads linked-partial', () => {
  // paid 100000 -> tol = max(200, 2% = 2000) = 2000
  assert.equal(ledgerStateFor(inv({ paidCents: 100000 }), 98000, '2025-10-01').state, 'linked-full');
  assert.equal(ledgerStateFor(inv({ paidCents: 100000 }), 97999, '2025-10-01').state, 'linked-partial');
});

test('tolerance floor: a small invoice uses the $2 floor, not 2%', () => {
  // paid 5000 -> 2% = 100, floored to 200
  assert.equal(ledgerStateFor(inv({ paidCents: 5000 }), 4800, '2025-10-01').state, 'linked-full');
  assert.equal(ledgerStateFor(inv({ paidCents: 5000 }), 4799, '2025-10-01').state, 'linked-partial');
});


test('ledgerStateFor agrees with classifyInvoiceLedger given the precomputed recognized total', () => {
  const txns = [cardPayment('inv-1', 201000)];
  const full = classifyInvoiceLedger(inv({ number: '1', id: 'inv-1', paidCents: 830000 }), ctx(txns));
  const fast = ledgerStateFor(inv({ number: '1', id: 'inv-1', paidCents: 830000 }), incomeCreditsFor(txns, 'inv-1', INCOME), '2025-10-01');
  assert.deepEqual(fast, full);
  assert.equal(fast.state, 'linked-partial');
});

test('ledgerStateFor: rec 0 + paid before boundary -> pre-books; in-window -> unlinked', () => {
  assert.equal(ledgerStateFor(inv({ paidCents: 5000, datePaid: '2022-01-01' }), 0, '2025-10-01').state, 'pre-books');
  assert.equal(ledgerStateFor(inv({ paidCents: 5000, datePaid: '2026-01-01' }), 0, '2025-10-01').state, 'unlinked');
});

test('ledgerStateFor: rec > 0 -> linked-full; rec 0 + unpaid -> unpaid', () => {
  assert.equal(ledgerStateFor(inv({ paidCents: 5000 }), 5000, '2025-10-01').state, 'linked-full');
  assert.equal(ledgerStateFor(inv({ paidCents: 0 }), 0, '2025-10-01').state, 'unpaid');
});

test('LEDGER_STATES covers every state classifyInvoiceLedger can return, each with a cls', () => {
  for (const k of ['linked-full', 'linked-partial', 'pre-books', 'unlinked', 'unpaid']) {
    assert.ok(LEDGER_STATES[k], `missing meta for ${k}`);
    assert.ok('cls' in LEDGER_STATES[k], `missing cls for ${k}`);
  }
});
