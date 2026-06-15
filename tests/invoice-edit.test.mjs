// node --test tests/invoice-edit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { recompute, nextInvoiceNumber, blankInvoice, addManualPayment } from '../js/app/lib/invoice-edit.js';

test('recompute derives line amounts, subtotal, total, paid, balance, status', () => {
  const inv = recompute({
    lineItems: [{ description: 'A', qty: 2, unitPriceCents: 195000 }, { description: 'B', qty: 1, unitPriceCents: 5000 }],
    payments: [{ amountCents: 100000, status: 'succeeded' }, { amountCents: 999, status: 'failed' }],
  });
  assert.equal(inv.lineItems[0].amountCents, 390000);
  assert.equal(inv.subtotalCents, 395000);
  assert.equal(inv.totalCents, 395000);
  assert.equal(inv.paidCents, 100000, 'failed payment excluded');
  assert.equal(inv.balanceCents, 295000);
  assert.equal(inv.docStatus, 'partially_paid');
});

test('status: open with no payments, fully_paid when covered, overpay clamps balance', () => {
  assert.equal(recompute({ lineItems: [{ qty: 1, unitPriceCents: 1000 }], payments: [] }).docStatus, 'open');
  const paid = recompute({ lineItems: [{ qty: 1, unitPriceCents: 1000 }], payments: [{ amountCents: 1000, status: 'succeeded' }] });
  assert.equal(paid.docStatus, 'fully_paid');
  assert.equal(paid.balanceCents, 0);
  const over = recompute({ lineItems: [{ qty: 1, unitPriceCents: 1000 }], payments: [{ amountCents: 1500, status: 'succeeded' }] });
  assert.equal(over.balanceCents, 0, 'never negative');
});

test('nextInvoiceNumber is max+1 across all invoices', () => {
  assert.equal(nextInvoiceNumber([{ number: '4129' }, { number: '4086' }, { number: 'abc' }]), '4130');
  assert.equal(nextInvoiceNumber([]), '1001');
});

test('blankInvoice is recomputed and tagged manual; id is collision-proof', () => {
  const b = blankInvoice('inv-man-x', '1001');
  assert.equal(b.source.app, 'manual');
  assert.equal(b.id, 'inv-man-x');
  assert.equal(b.totalCents, 0);
  assert.equal(b.docStatus, 'open');
});

test('addManualPayment appends a succeeded payment and recomputes', () => {
  let inv = blankInvoice('inv-man-y', '1002');
  inv = recompute({ ...inv, lineItems: [{ description: 'Job', qty: 1, unitPriceCents: 50000 }] });
  inv = addManualPayment(inv, { txId: 'man-1', date: '2026-06-01', amountCents: 20000, method: 'check' });
  assert.equal(inv.payments.length, 1);
  assert.equal(inv.payments[0].txId, 'man-1');
  assert.equal(inv.payments[0].status, 'succeeded');
  assert.equal(inv.paidCents, 20000);
  assert.equal(inv.balanceCents, 30000);
  assert.equal(inv.docStatus, 'partially_paid');
});
