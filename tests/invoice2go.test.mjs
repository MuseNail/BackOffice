// node --test tests/invoice2go.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInvoices } from '../js/app/lib/invoice2go.js';

// Build an outer-CSV field: wrap in quotes and double any inner quote, matching
// how Invoice2go encodes the nested Items/Payments cells.
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

const PAY_HDR = 'transaction_id,amount,fpt_fee_amount,tip_amount,datetime,type,method,status';
const ITEM_HDR = 'code,description,qty,unit_type,unit_price';

const HEADERS = 'Id,DocumentNumber,DocumentDate,Name,EmailRecipient,DocumentStatus,CurrencyCode,SubtotalAmount,TotalTaxAmount,TotalAmount,Items,Payments';

function invoiceRow({ id, num, date, name, status, total, items = '', payments = '' }) {
  return [id, num, date, q(name), 'a@b.com', status, 'USD', total, '', total, q(items), q(payments)].join(',');
}

const CSV = [
  HEADERS,
  // surcharge model: amount in dollars, fpt_fee_amount in CENTS; two payments
  invoiceRow({
    id: 'inv-1', num: '4131', date: '2026-04-09', name: 'Three Petals', status: 'fully_paid', total: '4940',
    items: `${ITEM_HDR};TWK,${'"Twinkle Curtain, with note"'},2,parts,1950`,
    payments: `${PAY_HDR};tx1,1526.26,4426,0,2026-04-09,payment,credit_card,succeeded;tx2,3458,0,0,2026-04-23,payment,manual_payment,succeeded`,
  }),
  // unpaid invoice → full open balance, no payments
  invoiceRow({ id: 'inv-2', num: '4086', date: '2026-02-27', name: 'KISMET', status: 'sent', total: '8624.25', payments: '' }),
  // a failed payment must not count toward paid/balance
  invoiceRow({
    id: 'inv-3', num: '4200', date: '2026-05-01', name: 'Acme', status: 'partially_paid', total: '1000',
    payments: `${PAY_HDR};tx3,400,0,0,2026-05-02,payment,credit_card,succeeded;tx4,600,0,0,2026-05-03,payment,credit_card,failed`,
  }),
].join('\n');

test('parses one object per invoice with stable dedup ids', () => {
  const inv = parseInvoices(CSV);
  assert.equal(inv.length, 3);
  assert.deepEqual(inv.map(i => i.sourceId), ['inv-1', 'inv-2', 'inv-3']);
  assert.equal(inv[0].source.app, 'invoice2go');
});

test('amount is dollars→cents, fpt_fee_amount is already cents', () => {
  const tp = parseInvoices(CSV)[0];
  assert.deepEqual(tp.payments.map(p => p.amountCents), [152626, 345800]);
  assert.equal(tp.payments[0].feeCents, 4426, 'fee stays in cents (=$44.26)');
  assert.equal(tp.payments[0].txId, 'tx1');
  assert.equal(tp.payments[0].method, 'credit_card');
});

test('totals and open balance: multi-payment, surcharge clamps balance at 0', () => {
  const tp = parseInvoices(CSV)[0];
  assert.equal(tp.totalCents, 494000);
  assert.equal(tp.paidCents, 498426, 'sum of payment amounts incl. surcharge');
  assert.equal(tp.balanceCents, 0, 'paid >= total → balance clamps to 0, never negative');
});

test('unpaid invoice carries its full open balance', () => {
  const km = parseInvoices(CSV)[1];
  assert.equal(km.paidCents, 0);
  assert.equal(km.balanceCents, 862425);
  assert.equal(km.payments.length, 0);
});

test('only succeeded payments count toward paid/balance', () => {
  const acme = parseInvoices(CSV)[2];
  assert.equal(acme.payments.length, 2, 'both payments parsed');
  assert.equal(acme.paidCents, 40000, 'failed payment excluded');
  assert.equal(acme.balanceCents, 60000);
});

test('line items: quoted comma/text preserved, amount = qty × unit price', () => {
  const item = parseInvoices(CSV)[0].lineItems[0];
  assert.equal(item.description, 'Twinkle Curtain, with note');
  assert.equal(item.qty, 2);
  assert.equal(item.unitPriceCents, 195000);
  assert.equal(item.amountCents, 390000);
});
