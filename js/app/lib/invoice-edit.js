// ── lib: invoice-edit — build/recompute manually-entered invoices (pure) ───────
// Manual invoices share the exact shape of imported (Invoice2go) ones so the
// list, drill-down, ledger posting, and reconciliation all treat them the same.
// They carry source.app === 'manual' and an id that can't collide with an
// Invoice2go id, so a weekly re-import never touches them.

const lineAmount = (it) => Math.round((Number(it.qty) || 0) * (it.unitPriceCents | 0));

// Recompute every derived total from line items + payments. Single source of
// truth — call after any edit. Open balance clamps at 0 (overpayment ≠ negative).
export function recompute(inv) {
  const lineItems = (inv.lineItems || []).map(it => ({ ...it, amountCents: lineAmount(it) }));
  const subtotalCents = lineItems.reduce((s, it) => s + it.amountCents, 0);
  const taxCents = inv.taxCents | 0;
  const totalCents = subtotalCents + taxCents;
  const paidCents = (inv.payments || []).filter(p => p.status === 'succeeded').reduce((s, p) => s + (p.amountCents | 0), 0);
  const balanceCents = Math.max(0, totalCents - paidCents);
  const docStatus = paidCents <= 0 ? 'open' : (balanceCents <= 0 ? 'fully_paid' : 'partially_paid');
  return { ...inv, lineItems, subtotalCents, taxCents, totalCents, paidCents, balanceCents, docStatus };
}

// Next sequential invoice number across all invoices (manual + imported).
export function nextInvoiceNumber(invoices) {
  let max = 1000;
  for (const i of invoices || []) { const n = parseInt(i.number, 10); if (Number.isFinite(n) && n > max) max = n; }
  return String(max + 1);
}

// A blank manual invoice ready for the editor. `id` must be supplied by the
// caller (it needs to be unique + collision-proof vs Invoice2go ids).
export function blankInvoice(id, number) {
  return recompute({
    id, sourceId: id, number: String(number || ''), date: '', clientName: '', clientEmail: '',
    currency: 'USD', taxCents: 0,
    lineItems: [{ code: '', description: '', qty: 1, unitType: '', unitPriceCents: 0 }],
    payments: [], source: { app: 'manual', sourceId: id },
  });
}

// Append a hand-recorded payment (always 'succeeded') and recompute. txId must
// be unique so ledger posting (id i2gp-<txId>) stays idempotent.
export function addManualPayment(inv, { txId, date, amountCents, method = 'manual_payment' }) {
  const payments = [...(inv.payments || []), {
    txId, date, amountCents: amountCents | 0, feeCents: 0, tipCents: 0,
    method, type: 'payment', status: 'succeeded',
  }];
  return recompute({ ...inv, payments });
}
