// ── lib: invoice2go — parse an Invoice2go CSV export into invoices ──────────────
// Pure (no DOM/IO). Invoice2go's weekly export is a FULL dump (no date range),
// so every import must dedup — invoices by their stable `Id`, payments by their
// `transaction_id` (verified present on 100% of payments).
//
// Two columns hold nested sub-tables in a single cell, semicolon-delimited rows
// with a header row, comma-delimited fields, quote-aware (line-item descriptions
// contain commas and newlines):
//   Items    — code,description,qty,unit_type,unit_price,…
//   Payments — transaction_id,…,amount,fpt_fee_amount,tip_amount,datetime,type,method,status,…
//
// UNIT QUIRK (verified against real data): money columns and payment `amount`
// are in DOLLARS (may be decimal); `fpt_fee_amount` and `tip_amount` inside the
// Payments sub-table are in CENTS. We normalize everything to integer cents.

import { parseCsv } from './csv.js';

const dollarsToCents = (v) => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const centsField = (v) => {
  const n = parseInt(String(v == null ? '' : v).replace(/[^0-9\-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
};
const isoDay = (v) => {
  const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

// Quote-aware split of a nested sub-table cell into objects keyed by its header
// row. Rows separated by ';', fields by ',', "" escapes a literal quote.
function parseSubTable(cell) {
  const text = String(cell == null ? '' : cell);
  if (!text.trim()) return [];
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === ';') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  row.push(field); rows.push(row);
  if (rows.length < 2) return [];
  const cols = rows[0].map(s => s.trim());
  return rows.slice(1)
    .filter(r => r.some(x => x !== ''))
    .map(r => { const o = {}; cols.forEach((c, i) => { o[c] = r[i]; }); return o; });
}

function parseLineItems(cell) {
  return parseSubTable(cell).map(it => {
    const qty = parseFloat(it.qty || '0') || 0;
    const unitPriceCents = dollarsToCents(it.unit_price);
    return {
      code: (it.code || '').trim(),
      description: (it.description || '').replace(/\s+/g, ' ').trim(),
      qty,
      unitType: (it.unit_type || '').trim(),
      unitPriceCents,
      amountCents: Math.round(qty * unitPriceCents),
    };
  });
}

function parsePayments(cell) {
  const out = [];
  for (const p of parseSubTable(cell)) {
    const amountCents = dollarsToCents(p.amount);
    if (!amountCents) continue;
    out.push({
      txId: (p.transaction_id || '').trim(),
      date: isoDay(p.datetime),
      amountCents,            // what the customer paid (includes any surcharge)
      feeCents: centsField(p.fpt_fee_amount), // processing/surcharge fee, in cents
      tipCents: centsField(p.tip_amount),
      method: (p.method || '').trim(),
      type: (p.type || '').trim(),
      status: (p.status || '').trim(),
    });
  }
  return out;
}

// Parse an Invoice2go invoice-export CSV. Returns one object per invoice with
// line items, payments, and derived totals — ready to upsert (dedup on sourceId)
// and to drive AR (open balance = totalCents − sum of succeeded payment amounts).
export function parseInvoices(csvText) {
  const { headers, rows } = parseCsv(csvText);
  if (!headers.length) return [];
  const ix = {};
  for (const h of headers) ix[h] = headers.indexOf(h);
  const get = (r, name) => (ix[name] != null ? r[ix[name]] : undefined);

  const invoices = [];
  for (const r of rows) {
    const sourceId = (get(r, 'Id') || '').trim();
    if (!sourceId) continue;
    const payments = parsePayments(get(r, 'Payments'));
    const succeeded = payments.filter(p => p.status === 'succeeded');
    const totalCents = dollarsToCents(get(r, 'TotalAmount'));
    const paidCents = succeeded.reduce((s, p) => s + p.amountCents, 0);
    invoices.push({
      sourceId,
      number: (get(r, 'DocumentNumber') || '').trim(),
      date: isoDay(get(r, 'DocumentDate')),
      clientName: (get(r, 'Name') || '').trim(),
      clientEmail: (get(r, 'EmailRecipient') || '').trim(),
      currency: (get(r, 'CurrencyCode') || 'USD').trim(),
      docStatus: (get(r, 'DocumentStatus') || '').trim(), // fully_paid | partially_paid | sent | unsent
      subtotalCents: dollarsToCents(get(r, 'SubtotalAmount')),
      taxCents: dollarsToCents(get(r, 'TotalTaxAmount')),
      totalCents,
      paidCents,
      // open balance from the invoice value, not Invoice2go's BalanceDueAmount
      // (which mirrors the total even when fully paid). Surcharges can push
      // paid above total, so clamp at zero.
      balanceCents: Math.max(0, totalCents - paidCents),
      lineItems: parseLineItems(get(r, 'Items')),
      payments,
      source: { app: 'invoice2go', sourceId },
    });
  }
  return invoices;
}

export { parseSubTable, dollarsToCents, centsField };
