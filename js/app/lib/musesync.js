// ── lib: musesync — Muse → Back Office inbound sync rows (pure, no DOM/IO) ─────
// The sync contract (kickoff §5): Muse pushes finalized daily summary rows; each
// lands as a STAGED row keyed deterministically on sourceApp+sourceId so a
// re-push is a no-op. Each type carries a fixed double-entry direction; which
// ACCOUNTS the two sides hit is the business's saved "Muse mapping"
// (meta.museMapping = { balancing: {type→accountId}, category: {type→accountId} }):
//   in  = balancing account debited  (money/asset in), category credited
//   out = balancing account credited, category debited
// Amounts arrive as POSITIVE integer cents + the type; we store them SIGNED the
// same way bank rows are (+ = in, − = out) so Review renders them identically.

// Why these directions tie out (Muse tender model, square-pos.js): recorded
// tenders sum to the BILL (totalIncome) split cash/card/zelle/gift, tips ride
// the card deposit, and gift cards SOLD are charged ON TOP of the bill (never
// in totalIncome). So:
//   income credited = cash+card+zelle+other (bill money collected today)
//                   + gift_redeemed (bill earned against the old liability)
//                   = totalIncome + tips                                  ✓
//   gift liability  = + gift_sold − gift_redeemed                         ✓
//   money in        = cash+card+zelle+other + gift_sold (rides the charge) ✓
export const MUSE_SYNC_TYPES = {
  sales_cash:    { label: 'Sales — cash',                dir: 'in',  balHint: 'Cash on hand',           catHint: 'Sales income' },
  sales_card:    { label: 'Sales — card (incl. tips)',   dir: 'in',  balHint: 'Card clearing (Helcim)', catHint: 'Sales income' },
  sales_zelle:   { label: 'Sales — Zelle',               dir: 'in',  balHint: 'Bank account',           catHint: 'Sales income' },
  sales_other:   { label: 'Sales — other / untracked',   dir: 'in',  balHint: 'Cash on hand',           catHint: 'Sales income' },
  gift_sold:     { label: 'Gift cards sold',             dir: 'in',  balHint: 'Card clearing (Helcim)', catHint: 'Gift card liability' },
  gift_redeemed: { label: 'Gift cards redeemed',         dir: 'in',  balHint: 'Gift card liability',    catHint: 'Sales income' },
  // Cash drawer over/short (counted − expected at close). Booked against the cash
  // account so it reflects what was ACTUALLY in the drawer, with the difference
  // landing in a Cash over/short account. Over = more cash than sales explain (cash
  // debited, over/short credited); short = less (cash credited, over/short debited).
  // Map BOTH to the same "Cash over/short" account and they net over the period.
  cash_over:     { label: 'Cash drawer — over',          dir: 'in',  balHint: 'Cash on hand',           catHint: 'Cash over/short' },
  cash_short:    { label: 'Cash drawer — short',         dir: 'out', balHint: 'Cash on hand',           catHint: 'Cash over/short' },
  payroll:       { label: 'Payroll (period total)',      dir: 'out', balHint: 'Bank account',           catHint: 'Payroll expense' },
};

const SOURCE_APP_RE = /^[a-z0-9_-]{2,30}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Deterministic staged-row id — same sourceApp+sourceId always maps to the same
// entity key, which is the whole idempotency mechanism.
export function syncRowId(sourceApp, sourceId) {
  return 'sync-' + sourceApp + '-' + String(sourceId).replace(/[^a-zA-Z0-9:_.-]/g, '-');
}

// One inbound row → a validated staged entity (or an error string).
export function shapeSyncRow(sourceApp, r) {
  if (!SOURCE_APP_RE.test(sourceApp || '')) return { error: 'bad sourceApp' };
  if (!r || typeof r !== 'object') return { error: 'bad row' };
  const t = MUSE_SYNC_TYPES[r.type];
  if (!t) return { error: `unknown type ${r.type}` };
  if (!DATE_RE.test(r.date || '')) return { error: 'bad date' };
  if (!Number.isInteger(r.amountCents) || r.amountCents <= 0) return { error: 'amountCents must be a positive integer' };
  if (!r.sourceId || String(r.sourceId).length > 80) return { error: 'bad sourceId' };
  return {
    row: {
      id: syncRowId(sourceApp, r.sourceId),
      importId: 'sync:' + sourceApp,
      syncApp: sourceApp,
      syncType: r.type,
      date: r.date,
      desc: String(r.desc || t.label).slice(0, 120),
      memo: String(r.memo || '').slice(0, 300),
      amountCents: t.dir === 'out' ? -r.amountCents : r.amountCents,
      source: { app: sourceApp, sourceId: String(r.sourceId) },
      status: 'pending',
    },
  };
}

// Batch validation for the Worker route. Returns { rows } or { error }.
export function shapeSyncBatch(sourceApp, rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 200) return { error: 'rows must be an array of 1–200' };
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const s = shapeSyncRow(sourceApp, r);
    if (s.error) return { error: `${s.error} (sourceId ${r?.sourceId ?? '?'})` };
    if (seen.has(s.row.id)) return { error: `duplicate sourceId in batch (${r.sourceId})` };
    seen.add(s.row.id);
    out.push(s.row);
  }
  return { rows: out };
}
