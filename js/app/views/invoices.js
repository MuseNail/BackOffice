// ── view: invoices — Invoice2go import + accounts-receivable tracking ──────────
// Phase 2 of the AR module: import the weekly Invoice2go CSV (deduped by stable
// id), then list invoices with running open balances + aging. Posting payments
// to the ledger and bank reconciliation are later phases — this view tracks, it
// does not post.
import { el, clear, toast, fmtMoney, acctAmount, prettyDesc, modal, appendKids } from '../ui.js';
import { todayLocal } from '../lib/day.js';
import { entities, subscribe, getState, usesInvoices, getStateBiz } from '../store.js';
import { dispatch, api } from '../sync.js';
import { combobox } from '../combobox.js';
import { getActiveBiz, canEdit } from '../session.js';
import { parseInvoices } from '../lib/invoice2go.js';
import { buildCashflowImport, cashflowPaymentTxnId, parseBundleInvoices } from '../lib/i2g-cashflow.js';
import { reconcilePayouts } from '../lib/i2g-reconcile.js';
import { validateTxn, invoiceExpensesTotal, simpleTxn } from '../lib/posting.js';
import { accountLabel } from '../lib/coa-templates.js';
import { blankInvoice, recompute, nextInvoiceNumber, addManualPayment } from '../lib/invoice-edit.js';
import { parseMoney } from '../lib/money.js';
import { dateRangeControl, inRange } from '../daterange.js';

let unsub = null;

// Payment methods. Invoice2go exports a hand-marked payment as 'manual_payment';
// the owner records those as Zelle, so the method is editable per payment (and the
// edit survives a weekly re-import, which keeps existing payments).
const METHOD_OPTS = [
  ['zelle', 'Zelle'], ['manual_payment', 'Manual payment'], ['cash', 'Cash'],
  ['check', 'Check'], ['bank_transfer', 'Bank transfer'], ['ach', 'ACH'],
  ['credit_card', 'Credit card'], ['card', 'Card'], ['other', 'Other'],
];
const METHOD_LABELS = Object.fromEntries(METHOD_OPTS);
const methodLabel = (m) => METHOD_LABELS[m] || (m || '').replace(/_/g, ' ') || '—';

// Editable method <select> for one payment row. Reads the live invoice at change
// time so editing several rows in a row doesn't clobber earlier edits, and matches
// the payment by txId (falling back to index) so the right one is updated.
function methodSelect(inv, idx, current) {
  const opts = current && !METHOD_OPTS.some(([v]) => v === current) ? [[current, methodLabel(current)], ...METHOD_OPTS] : METHOD_OPTS;
  const sel = el('select', { class: 'field-input', style: 'margin:0;min-width:150px;font-size:.85em' },
    ...opts.map(([v, l]) => el('option', { value: v, selected: v === current }, l)));
  sel.addEventListener('change', () => {
    const live = entities('invoice').find(x => x.id === inv.id) || inv;
    const target = (inv.payments || [])[idx];
    const payments = (live.payments || []).map((x, i) =>
      ((target?.txId && x.txId === target.txId) || (!target?.txId && i === idx)) ? { ...x, method: sel.value } : x);
    dispatch({ op: 'entity.upsert', kind: 'invoice', value: { ...live, payments, updatedAt: Date.now() } });
    toast('Payment method updated');
  });
  return sel;
}

// Display status from the money, not Invoice2go's label (so it always matches
// what we show for total/paid/open). An open balance more than 30 days past the
// invoice date reads as Overdue.
function statusOf(inv) {
  if (inv.balanceCents <= 0 && inv.paidCents > 0) return { key: 'paid', label: 'Paid', cls: 'green' };
  if (inv.date && daysBetween(inv.date, todayIso()) > 30) return { key: 'overdue', label: 'Overdue', cls: 'red' };
  if (inv.paidCents > 0) return { key: 'partial', label: 'Partial', cls: 'amber' };
  return { key: 'open', label: 'Open', cls: 'gray' };
}

// Manual invoices are created here; everything else is synced from Invoice2go.
const sourceOf = (inv) => inv.source?.app === 'manual'
  ? { label: 'Manual', cls: 'blue' }
  : { label: 'Imported', cls: 'gray' };

const todayIso = () => todayLocal();
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// Which A/R aging bucket an invoice's open balance falls in (−1 = none/paid).
const AGING_BUCKETS = [['Current', 0, 0], ['1–30', 1, 30], ['31–60', 31, 60], ['61–90', 61, 90], ['90+', 91, Infinity]];
function bucketOf(inv, today) {
  if (inv.balanceCents <= 0 || !inv.date) return -1;
  const age = daysBetween(inv.date, today);
  if (age <= 0) return 0;
  const i = AGING_BUCKETS.findIndex(([, lo, hi]) => age >= lo && age <= hi);
  return i < 0 ? 0 : i;
}

// Active aging-chip filter (bucket index, or null for "all"). Reset each mount.
let agingFilter = null;
// Period for the "Collected" KPI. The picker instance + its range persist across the
// list redraws (which fire on every sync) so it keeps its state and selection.
let collectedRange = null;   // {from,to} — null = all time
let collectedCtl = null;     // the shared dateRangeControl element (presets + calendar)
// Free-text list filter (client / invoice # / amount / status). Reset each mount.
let invoiceQuery = '';

// Income collected in a period — ALL of it, from EVERY source (the Invoice2go
// cashflow AND the QuickBooks history import that owns Oct 2025–Feb 2026), so the
// total reflects everything in Back Office, not just one importer. On a cash basis,
// income recognized = cash collected; we sum the credits to income accounts (income
// posts as a credit = negative), dated by each transaction. null range = all time.
function collectedCents(range) {
  const incomeIds = new Set(entities('account').filter(a => a.type === 'income').map(a => a.id));
  let total = 0;
  for (const t of entities('txn')) {
    if (range && !inRange(t.date, range)) continue;
    for (const l of (t.lines || [])) if (incomeIds.has(l.accountId)) total -= l.amountCents;
  }
  return total;
}

export function render(root, detail) {
  const openNew = detail === 'new';
  if (openNew) detail = null;
  if (detail === 'reconcile') { renderReconcile(root); return; }
  if (detail) { renderInvoiceDetail(root, detail); return; }
  agingFilter = null;
  collectedRange = null; collectedCtl = null;
  invoiceQuery = '';
  if (!usesInvoices()) {
    root.append(
      el('h2', {}, 'Invoices'),
      el('p', { class: 'sub' }, 'Invoices aren’t enabled for this business. Turn it on in Settings → Business features.'));
    // The snapshot loads async (a reload lands here before data arrives) and the
    // owner can flip the feature on — re-render the full view if it becomes enabled.
    unsub = subscribe(() => { if (usesInvoices()) { unsub?.(); unsub = null; root.replaceChildren(); render(root); } });
    return;
  }
  const editable = canEdit(getActiveBiz());
  root.append(
    el('h2', {}, 'Invoices'),
    el('p', { class: 'sub' }, 'Imported from Invoice2go. Each weekly export is the full history — re-importing only adds new invoices and applies new payments, never duplicates.'),
  );
  // Count badge on the Reconcile-income button (editable only); refreshed in draw().
  let recBadge = null;
  if (editable) {
    recBadge = el('span', {});
    root.append(
      el('div', { style: 'margin-bottom:8px;display:flex;gap:8px;flex-wrap:wrap' },
        el('button', { class: 'btn sm', onclick: () => invoiceModal(null) }, '＋ New invoice'),
        el('button', { class: 'btn sm ghost', onclick: importBundleModal }, 'Import from Invoice2go'),
        el('button', { class: 'btn sm ghost', onclick: importLineItemsModal }, '＋ Add line items (CSV)')),
      el('div', { style: 'margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap' },
        el('button', { class: 'btn sm ghost', onclick: reconcileIncomeModal }, 'Reconcile income', recBadge),
        el('button', { class: 'btn sm ghost', onclick: () => { location.hash = `#/b/${getActiveBiz()}/invoices/reconcile`; } }, 'Reconcile to bank →')));
  }

  // List area. KPIs + aging chips redraw on every sync; the search box lives in a
  // PERSISTENT toolbar outside those boxes so a background sync can't steal focus while
  // you type (the accounts/vendors/customers pattern). Only the table re-filters per keystroke.
  const headBox = el('div');
  const tableBox = el('div');
  const count = el('span', { class: 'sub', style: 'margin:0;font-weight:600;white-space:nowrap' });
  const search = el('input', {
    class: 'field-input', type: 'search', value: invoiceQuery,
    placeholder: 'Search by client, invoice #, amount, or status…',
    style: 'max-width:320px;margin:0',
    oninput: (e) => { invoiceQuery = e.target.value; drawInvoiceTable(tableBox, count); },
  });
  const toolbar = el('div', { style: 'display:flex;align-items:center;gap:10px;margin:0 0 9px;flex-wrap:wrap' }, search, count);
  const draw = () => {
    if (recBadge) {
      const u = untaggedIncome(); const n = u.auto.length + u.review.length;
      clear(recBadge);
      if (n) recBadge.append(el('span', { class: 'pill amber', style: 'margin-left:5px;font-size:.85em' }, String(n)));
    }
    toolbar.style.display = entities('invoice').length ? 'flex' : 'none';
    drawHead(headBox, draw);
    drawInvoiceTable(tableBox, count);
  };
  root.append(headBox, toolbar, tableBox);
  unsub = subscribe(draw);
  draw();
  if (openNew && usesInvoices() && canEdit(getActiveBiz())) invoiceModal(null);
}

export function unmount() { unsub?.(); unsub = null; invoiceQuery = ''; }

// Both import flows open from a button into a modal — the forms used to sit permanently
// open at the top of the tab, pushing the actual invoice list far down the screen. The
// card content renders "bare" (no card chrome) so it sits flush inside the dialog.
function importBundleModal() {
  const m = modal('Import from Invoice2go');
  const panel = m.body.parentElement;
  if (panel) panel.style.width = '660px';   // the five account pickers need room to lay out
  m.body.append(postCard({ bare: true }));
}
function importLineItemsModal() {
  const m = modal('Add line items (Invoice2go CSV)');
  m.body.append(importCard({ bare: true }));
}

// ── Reconcile untagged Invoice2go income ──
// Invoice2go income that was recognized but never linked to an invoice — usually because
// the payment was made while the doc was still an ESTIMATE, so the doc number the importer
// matches on changed when it became an invoice. The payment's transaction id does NOT
// change, and it lives on both the cashflow txn (source.sourceId) and the invoice's payment
// rows (payments[].txId), so we re-link by that. Returns { auto (1:1 id match), review }.
function untaggedIncome() {
  const incomeIds = new Set(entities('account').filter(a => a.type === 'income').map(a => a.id));
  const incOf = t => (t.lines || []).filter(l => incomeIds.has(l.accountId)).reduce((a, l) => a - l.amountCents, 0);
  const byPayTxId = new Map();
  for (const i of entities('invoice')) for (const pmt of (i.payments || [])) {
    const k = pmt && pmt.txId ? String(pmt.txId) : '';
    if (k) (byPayTxId.get(k) || byPayTxId.set(k, []).get(k)).push(i);
  }
  const auto = [], review = [];
  for (const t of entities('txn')) {
    if (t.source?.app !== 'i2g-cashflow' || t.invoiceId) continue;
    const amt = incOf(t); if (amt <= 0) continue;
    const hit = byPayTxId.get(String(t.source?.sourceId || ''));
    if (hit && hit.length === 1) auto.push({ txn: t, amt, inv: hit[0] });
    else review.push({ txn: t, amt });
  }
  return { auto, review };
}

// One-click cleanup: link recognized-but-untagged Invoice2go income to its invoice by
// payment id. Idempotent — safe to run after each weekly import; never changes amounts.
function reconcileIncomeModal() {
  const m = modal('Reconcile Invoice2go income');
  // Dense 5-column table (with an invoice picker per row) needs more room than the 510px default.
  if (m.body.parentElement) m.body.parentElement.style.width = '760px';
  const stat = (l, v) => el('div', { style: 'flex:1;background:var(--fill);border-radius:10px;padding:9px 12px' },
    el('div', { class: 'sub', style: 'margin:0' }, l), el('div', { style: 'font-size:1.3em;font-weight:800' }, v));
  const closeRow = () => el('div', { style: 'display:flex;justify-content:flex-end;margin-top:12px' }, el('button', { class: 'btn', onclick: m.close }, 'Close'));

  const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const toks = s => new Set(norm(s).split(' ').filter(w => w.length > 2));
  const overlaps = (a, b) => { const B = toks(b); for (const w of toks(a)) if (B.has(w)) return true; return false; };
  const confPill = (c) => el('span', { class: 'pill ' + (c >= 90 ? 'green' : c >= 60 ? 'amber' : 'gray'), style: 'white-space:nowrap' }, `✨ ${c}%`);

  const aiResults = new Map();   // txnId -> { invoiceId, confidence, reason }
  let aiBusy = false;
  let rowsCtx = [];              // [{ txn, amt, cb }] for the current render — AI + bulk read these live

  const linkOne = (txn, invoiceId) => {
    if (!invoiceId) { toast('Pick an invoice first', 'err'); return; }
    dispatch({ op: 'entity.upsert', kind: 'txn', value: { ...txn, invoiceId, updatedAt: Date.now() } });
    aiResults.delete(txn.id);
    toast('Linked to invoice');
    render();
  };

  const askAI = async () => {
    if (aiBusy || !rowsCtx.length) return;
    aiBusy = true; render();
    try {
      const invs = entities('invoice');
      const payments = rowsCtx.slice(0, 40).map(c => ({ id: c.txn.id, date: c.txn.date, payee: c.txn.payee, amountCents: c.amt }));
      const invoices = invs.map(i => ({ id: i.id, number: i.number, clientName: i.clientName, totalCents: i.totalCents, date: i.date, datePaid: i.datePaid }));
      const res = await api(`/b/${getStateBiz()}/ai/match-invoices`, { method: 'POST', body: JSON.stringify({ payments, invoices }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.error === 'ai_budget_reached' ? 'Monthly AI budget reached — raise it in Settings to keep going.'
          : data.error === 'ai_paused' ? 'AI is paused in Settings.'
          : data.error === 'ai_not_configured' ? 'AI isn’t set up yet (no API key).'
          : data.message ? `AI error: ${data.message}` : 'The AI matcher couldn’t run — try again.';
        toast(msg, 'err'); aiBusy = false; render(); return;
      }
      for (const s of (data.suggestions || [])) if (s.invoiceId) aiResults.set(s.id, s);
      const n = (data.suggestions || []).filter(s => s.invoiceId).length;
      toast(n ? `AI suggested ${n} match${n === 1 ? '' : 'es'} — review and link` : 'AI found no confident matches');
      aiBusy = false; render();
    } catch { toast('Couldn’t reach the AI matcher — try again', 'err'); aiBusy = false; render(); }
  };

  const linkHighConf = () => {
    const hi = rowsCtx.filter(c => { const s = aiResults.get(c.txn.id); return s && s.invoiceId && s.confidence >= 90; });
    if (!hi.length) return;
    if (!confirm(`Link ${hi.length} high-confidence match${hi.length === 1 ? '' : 'es'} (90%+) to their invoices? You can change any of them afterward — this only tags them, no totals move.`)) return;
    const vals = hi.map(c => ({ ...c.txn, invoiceId: aiResults.get(c.txn.id).invoiceId, updatedAt: Date.now() }));
    for (let i = 0; i < vals.length; i += 200) dispatch({ op: 'entity.bulkUpsert', kind: 'txn', values: vals.slice(i, i + 200) });
    hi.forEach(c => aiResults.delete(c.txn.id));
    toast(`Linked ${vals.length} payment${vals.length === 1 ? '' : 's'}`);
    render();
  };

  // Candidate invoices for one payment: those whose client name shares a word with the
  // payer in the description ("Likely matches"), then every invoice (searchable) so a
  // near-miss name can still be found by hand.
  const invGroups = (payee, invs) => {
    const opt = i => ({ value: i.id, label: `#${i.number || i.id} · ${i.clientName || '—'} · ${fmtMoney(i.totalCents || 0)}` });
    const likely = invs.filter(i => i.clientName && overlaps(i.clientName, payee));
    const likelyIds = new Set(likely.map(i => i.id));
    const rest = invs.filter(i => !likelyIds.has(i.id));
    const groups = [];
    if (likely.length) groups.push({ label: 'Likely matches', items: likely.map(opt) });
    if (rest.length) groups.push({ label: likely.length ? 'All invoices' : '', items: rest.map(opt) });
    return { groups, single: likely.length === 1 ? likely[0] : null };
  };

  const render = () => {
    const { auto, review } = untaggedIncome();
    clear(m.body);
    rowsCtx = [];
    if (!auto.length && !review.length) { m.body.append(el('p', { class: 'sub' }, 'All Invoice2go income is linked to an invoice. ✓'), closeRow()); return; }
    const total = [...auto, ...review].reduce((a, x) => a + x.amt, 0);
    m.body.append(
      el('p', { class: 'sub' }, 'These payments were recognized as income but aren’t linked to an invoice — usually because they were paid while the document was still an estimate. Linking changes no totals; it only attaches each payment to its invoice.'),
      el('div', { style: 'display:flex;gap:10px;margin:2px 0 12px' },
        stat('Unlinked payments', String(auto.length + review.length)), stat('Amount', fmtMoney(total))));
    if (auto.length) m.body.append(
      el('div', { class: 'card', style: 'background:var(--green-soft);border-color:#b9e0c6;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px' },
        el('div', {},
          el('div', { style: 'font-weight:800;color:var(--green)' }, `${auto.length} can be linked automatically`),
          el('div', { class: 'sub', style: 'margin:0' }, 'Matched to an invoice by payment ID — exact, no guessing.')),
        el('button', { class: 'btn sm green', onclick: () => {
          const vals = auto.map(a => ({ ...a.txn, invoiceId: a.inv.id, updatedAt: Date.now() }));
          for (let i = 0; i < vals.length; i += 200) dispatch({ op: 'entity.bulkUpsert', kind: 'txn', values: vals.slice(i, i + 200) });
          toast(`Linked ${vals.length} payment${vals.length === 1 ? '' : 's'} to ${vals.length === 1 ? 'its' : 'their'} invoice${vals.length === 1 ? '' : 's'}`);
          render();
        } }, `Link ${auto.length} payment${auto.length === 1 ? '' : 's'}`)));
    if (review.length) {
      const invs = entities('invoice').slice().sort((a, b) => String(b.number || '').localeCompare(String(a.number || '')));
      const hiCount = review.filter(r => { const s = aiResults.get(r.txn.id); return s && s.invoiceId && s.confidence >= 90; }).length;
      m.body.append(el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0 8px' },
        el('div', { style: 'font-weight:800;flex:1' }, `${review.length} need your review`),
        el('button', { class: 'btn sm', disabled: aiBusy, onclick: askAI }, aiBusy ? '✨ Asking Claude…' : '✨ Suggest matches with AI'),
        hiCount ? el('button', { class: 'btn sm green', onclick: linkHighConf }, `Link all ${hiCount} at 90%+`) : el('span')));
      const tbody = el('tbody');
      for (const r of review.slice(0, 200)) {
        const { groups, single } = invGroups(r.txn.payee, invs);
        const sug = aiResults.get(r.txn.id);
        const cb = combobox({ groups, value: sug?.invoiceId || (single ? single.id : ''), placeholder: 'Search invoices…', minWidth: 0, emptyText: 'No matching invoice — import it first', scrollToEnd: false });
        cb.style.cssText = 'width:100%;min-width:0';
        rowsCtx.push({ txn: r.txn, amt: r.amt, cb });
        const hint = sug ? el('span', { title: sug.reason || '', style: 'display:inline-flex;align-items:center;gap:5px' }, confPill(sug.confidence), sug.reason ? el('span', { class: 'sub', style: 'margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px' }, sug.reason) : el('span'))
          : el('span', { class: 'sub', style: 'margin:0' }, single ? 'name match' : '');
        tbody.append(el('tr', {},
          el('td', { style: 'white-space:nowrap' }, r.txn.date || '—'),
          el('td', {}, prettyDesc(r.txn.payee) || '—'),
          el('td', { class: 'num' }, acctAmount(r.amt, { colored: false })),
          el('td', { style: 'min-width:210px' }, el('div', { style: 'display:flex;flex-direction:column;gap:3px' }, cb, hint)),
          el('td', {}, el('button', { class: 'btn sm', onclick: () => linkOne(r.txn, cb.value) }, 'Link'))));
      }
      m.body.append(el('div', { class: 'card', style: 'padding:0' },
        el('table', { class: 'data xl', style: 'table-layout:fixed;width:100%' },
          el('colgroup', {},
            el('col', { style: 'width:82px' }), el('col', {}), el('col', { style: 'width:92px' }),
            el('col', { style: 'width:250px' }), el('col', { style: 'width:60px' })),
          el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Client'), el('th', { class: 'num' }, 'Amount'), el('th', {}, 'Match to invoice'), el('th', {}, ''))),
          tbody)));
    }
    m.body.append(el('p', { class: 'sub', style: 'margin-top:12px' }, 'Income totals are unaffected — this only links payments to their invoices.'), closeRow());
  };
  render();
}

// ── Invoice2go import: bundle (money) + CSV (line items) — neither clobbers the other ──
// Ownership split, since entity.upsert is a full replace: the one-click API bundle
// owns the money (total/paid/balance/status — always the current truth), the CSV
// owns line-item detail. So a weekly bundle re-import keeps any line items a CSV
// backfill added, and a CSV backfill never overwrites the money the bundle posted.
function invoiceResolver() {
  const byId = new Map(), byNum = new Map();
  for (const e of entities('invoice')) { byId.set(e.id, e); if (e.number) byNum.set(String(e.number).trim(), e); }
  return (id, number) => byId.get(id) || (number ? byNum.get(String(number).trim()) : null) || null;
}

function mergeBundleInvoice(p, resolve, now) {
  const ex = resolve(p.id, p.number);
  if (ex && ex.source?.app === 'manual') return null; // never overwrite a hand-made invoice
  if (!ex) return { ...p, updatedAt: now };
  const keepLines = Array.isArray(ex.lineItems) && ex.lineItems.length > 0; // preserve CSV-backfilled lines
  return {
    ...ex, id: ex.id,
    number: p.number || ex.number, date: p.date || ex.date, dueDate: p.dueDate || ex.dueDate,
    createdDate: p.createdDate || ex.createdDate, datePaid: p.datePaid || ex.datePaid,
    clientName: p.clientName || ex.clientName, clientEmail: p.clientEmail || ex.clientEmail,
    totalCents: p.totalCents, paidCents: p.paidCents, balanceCents: p.balanceCents,
    docStatus: p.docStatus, docType: p.docType,
    lineItems: keepLines ? ex.lineItems : [],
    subtotalCents: keepLines ? ex.subtotalCents : p.subtotalCents,
    taxCents: keepLines ? (ex.taxCents || 0) : p.taxCents,
    source: { app: 'invoice2go-api', sourceId: p.id }, // marks money as bundle-owned
    importedAt: ex.importedAt || now, updatedAt: now,
  };
}

// LINE ITEMS ONLY. This card decorates invoices the JSON import already brought in
// — it must never create an invoice (the JSON owns the invoice set + the cutoff) and
// never touch money/status/ownership (the card's promise). So: no match → skip; manual
// → skip; otherwise return the existing invoice byte-for-byte except its line items.
function mergeCsvInvoice(c, resolve, now) {
  const ex = resolve(c.sourceId, c.number);
  if (!ex) return null;                            // not in Back Office → never create from the CSV
  if (ex.source?.app === 'manual') return null;    // never touch a hand-made invoice
  if (!Array.isArray(c.lineItems) || !c.lineItems.length) return null;   // nothing to add
  return {
    ...ex,                                          // every money/status/source/id field preserved
    lineItems: c.lineItems,
    subtotalCents: c.subtotalCents,                 // the breakdown that backs the lines
    taxCents: c.taxCents,
    clientName: ex.clientName || c.clientName,      // only fill blanks
    clientEmail: ex.clientEmail || c.clientEmail,
    updatedAt: now,
  };
}

// ── Add line-item detail (Invoice2go CSV) ──
// The one-click JSON brings every invoice and its money but no line items (the
// list API omits them). This optional card layers line-item detail onto invoices
// you already have — matched by number/id — and only ever fills line items.
function importCard({ bare = false } = {}) {
  const card = bare ? el('div', { style: 'margin:0' }) : el('div', { class: 'card', style: 'max-width:640px;margin-bottom:16px' });
  const file = el('input', { type: 'file', accept: '.csv', class: 'field-input', style: 'max-width:320px' });
  const preview = el('div', { style: 'margin-top:10px' });
  const importBtn = el('button', { class: 'btn sm', disabled: true }, 'Add line items');
  let pending = null;

  const scan = async () => {
    pending = null; importBtn.disabled = true; clear(preview);
    const f = file.files?.[0]; if (!f) return;
    let all;
    try { all = parseInvoices(await f.text()); }
    catch { preview.append(el('p', { class: 'sub' }, 'Could not read that file.')); return; }
    if (!all.length) { preview.append(el('p', { class: 'sub' }, 'No invoices found in that file.')); return; }
    const resolve = invoiceResolver();
    let willUpdate = 0, notInBo = 0, manualSkip = 0;
    for (const inv of all) {
      const ex = resolve(inv.sourceId, inv.number);
      if (!ex) { notInBo++; continue; }
      if (ex.source?.app === 'manual') { manualSkip++; continue; }
      if (inv.lineItems?.length) willUpdate++;
    }
    pending = { invoices: all };
    preview.append(
      el('p', {}, el('b', {}, `${willUpdate} invoices will get line items`), '. ',
        `${notInBo} aren’t in Back Office, so they’re skipped — nothing is created.`,
        manualSkip ? ` ${manualSkip} manual invoices left untouched.` : ''),
      el('p', { class: 'sub', style: 'margin:2px 0 0' }, 'Totals, payments, and status are never changed here — only line items are added.'),
    );
    importBtn.disabled = willUpdate === 0;
  };
  file.addEventListener('change', scan);

  importBtn.addEventListener('click', () => {
    if (!pending) return;
    const now = Date.now();
    const resolve = invoiceResolver();
    const values = pending.invoices.map(inv => mergeCsvInvoice(inv, resolve, now)).filter(Boolean);
    for (let i = 0; i < values.length; i += 200) dispatch({ op: 'entity.bulkUpsert', kind: 'invoice', values: values.slice(i, i + 200) });
    toast(`Line items added to ${values.length} invoices`);
    clear(preview).append(el('p', { class: 'sub' }, `Updated ${values.length} invoices with line-item detail. Totals and payments were left untouched.`));
    importBtn.disabled = true; pending = null; file.value = '';
  });

  card.append(...[
    bare ? null : el('div', { class: 'cardtitle' }, 'Add line-item detail (Invoice2go CSV)'),
    el('p', { class: 'sub' }, 'Optional. The one-click import brings every invoice and its money, but not the itemized lines. Upload the Invoice2go invoice CSV whenever you like (monthly or quarterly is fine) to fill in line items on the invoices you already have — matched by number. It only adds line items; it never changes totals or payments.'),
    el('div', { style: 'display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap' },
      el('div', {}, el('label', { class: 'field-label' }, 'Invoice CSV'), file),
      importBtn),
    preview,
  ].filter(Boolean));
  return card;
}

// ── Post the Invoice2go cashflow (payments + payouts) to the ledger ──
// Uploads the Invoice2go "banking/adyen/transactions" export, which carries the
// REAL fees, nets, and payouts — so income, the passed/absorbed fee split, and the
// 1% instant-payout fee are exact (no estimation). Each payment's net lands in the
// clearing account; bank deposits relieve it (when clearing nets to $0, every
// payment is matched to a deposit). Idempotent — already-posted entries are skipped.
function postCard({ bare = false } = {}) {
  const card = bare ? el('div', { style: 'margin:0' }) : el('div', { class: 'card', style: 'max-width:680px;margin-bottom:16px' });
  const draw = () => {
    const map = getState().meta?.i2gMapping || {};
    const byId = new Map(entities('account').map(a => [a.id, a]));
    const opts = (type, sel) => el('select', { class: 'field-input', style: 'min-width:190px' },
      el('option', { value: '' }, '— select —'),
      ...entities('account').filter(a => a.active !== false && a.type === type).sort((a, b) => accountLabel(a, byId).localeCompare(accountLabel(b, byId)))
        .map(a => el('option', { value: a.id, selected: a.id === sel }, accountLabel(a, byId))));
    const incomeSel = opts('income', map.incomeId);
    const clearingSel = opts('asset', map.clearingId);
    const feePassedSel = opts('income', map.feePassedId);     // contra-income: fee the customer covered
    const feeAbsorbedSel = opts('cogs', map.feeAbsorbedId);    // COGS: fee you absorbed
    const payoutSel = opts('expense', map.payoutFeeId);        // expense: 1% instant-payout fee
    const curMapping = () => ({ incomeId: incomeSel.value, clearingId: clearingSel.value, feePassedId: feePassedSel.value, feeAbsorbedId: feeAbsorbedSel.value, payoutFeeId: payoutSel.value });

    const ensureBtn = el('button', { class: 'linklike', onclick: () => {
      const have = entities('account');
      const find = (type, re) => have.find(x => x.type === type && (re.test(x.name) || re.test(x.qbName || '')));
      const mk = (name, type, qbType, existing) => {
        let a = existing || have.find(x => x.type === type && x.name.toLowerCase() === name.toLowerCase());
        if (!a) {
          const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
          const taken = new Set(have.map(x => x.id)); let id = base, n = 2; while (taken.has(id)) id = `${base}-${n++}`;
          a = { id, name, type, qbType, qbName: name, parentId: null, active: true, updatedAt: Date.now() };
          dispatch({ op: 'entity.upsert', kind: 'account', value: a });
        }
        return a;
      };
      // A DEDICATED clearing account (not QuickBooks' shared Undeposited Funds) so the
      // Invoice2go balance is purely its own money awaiting a deposit — clean to reconcile.
      const clr = mk('Invoice2go Clearing', 'asset', 'OCASSET', find('asset', /invoice ?2 ?go clearing/i));
      const cogs = mk('Card processing fees', 'cogs', 'COGS', find('cogs', /processing|card fee/i));
      const passed = mk('Processing Fees', 'income', 'INC', find('income', /processing fee/i));
      const payout = mk('Payout Fee', 'expense', 'EXP', find('expense', /payout/i));
      dispatch({ op: 'meta.set', value: { ...getState().meta, i2gMapping: { ...(getState().meta?.i2gMapping || {}), clearingId: clr.id, feeAbsorbedId: cogs.id, feePassedId: passed.id, payoutFeeId: payout.id } } });
      toast('Clearing + fee accounts ready');
      draw();
    } }, 'Create / link the standard clearing + fee accounts');

    const file = el('input', { type: 'file', accept: '.json', class: 'field-input', style: 'max-width:300px' });
    const cutoffInput = el('input', { type: 'date', class: 'field-input', style: 'max-width:170px', value: getState().meta?.i2gCutoff || '2025-10-01' });
    const preview = el('div', { style: 'margin-top:10px' });
    const importBtn = el('button', { class: 'btn sm green', disabled: true }, 'Import');
    let built = null; // { invoiceValues, invNew, invUpd, cf, hasInvoices }

    const scan = async () => {
      built = null; importBtn.disabled = true; clear(preview);
      const f = file.files?.[0]; if (!f) return;
      let raw;
      try { raw = JSON.parse(await f.text()); } catch { preview.append(el('p', { class: 'sub' }, 'Could not read that file — expected the one-click Invoice2go export (invoice2go-export.json).')); return; }
      const now = Date.now();
      const cutoff = cutoffInput.value || '';
      // 1) invoices (bundle only — the plain cashflow file has none)
      const parsedInv = parseBundleInvoices(raw, now, cutoff);
      const resolve = invoiceResolver();
      const invoiceValues = []; let invNew = 0, invUpd = 0;
      if (parsedInv) for (const pInv of parsedInv) {
        const existed = !!resolve(pInv.id, pInv.number);
        const m = mergeBundleInvoice(pInv, resolve, now);
        if (!m) continue;
        invoiceValues.push(m); existed ? invUpd++ : invNew++;
      }
      // 2) cashflow — tag against the bundle's invoices (id match) + what's already here
      const existingForTag = parsedInv ? [...parsedInv, ...entities('invoice')] : entities('invoice');
      const cf = buildCashflowImport(raw, { existingInvoices: existingForTag, mapping: curMapping(), existingTxnIds: new Set(entities('txn').map(t => t.id)), now, cutoff });
      built = { invoiceValues, invNew, invUpd, cf, hasInvoices: !!parsedInv };
      const p = cf.preview || {};
      if (cf.errors.length) preview.append(el('p', { style: 'color:var(--red)' }, cf.errors.join(' ')));
      if (parsedInv) preview.append(el('p', {}, el('b', {}, `${parsedInv.length} invoices`), ' — ', el('b', {}, `${invNew} new`), `, ${invUpd} updated`));
      if (p.payments != null) preview.append(
        el('p', {}, el('b', {}, `${p.payments} payments`), `, ${p.payouts} payouts (${p.payoutsWithFee} with a 1% fee) · `, el('b', {}, `${p.toPost} to post`), p.alreadyPosted ? `, ${p.alreadyPosted} already posted` : ''),
        el('p', { class: 'sub', style: 'margin:2px 0' }, `income ${fmtMoney(p.income)} · absorbed ${fmtMoney(p.absorbed)} (COGS) · passed ${fmtMoney(p.passed)} (contra-income) · payout fees ${fmtMoney(p.payoutFees)}`),
        el('p', { class: 'sub', style: 'margin:2px 0' }, `${p.tagged} tagged to invoices${p.unmatchedInvoices.length ? ` · ${p.unmatchedInvoices.length} not matched (income still posts)` : ''}${p.dateRange ? ` · ${p.dateRange[0]} → ${p.dateRange[1]}` : ''}`),
        p.unmatchedInvoices.length ? el('details', {}, el('summary', { class: 'sub', style: 'cursor:pointer' }, `${p.unmatchedInvoices.length} invoice/estimate #s not matched`), el('div', { class: 'sub', style: 'max-height:120px;overflow:auto' }, p.unmatchedInvoices.slice(0, 100).map(u => '#' + u.number).join(', '))) : el('span'),
      );
      if (!parsedInv && p.payments == null) preview.append(el('p', { class: 'sub' }, 'That file has no invoices or cashflow — is it the one-click export (invoice2go-export.json)?'));
      importBtn.disabled = (!invoiceValues.length && !p.toPost) || cf.errors.length > 0;
    };
    file.addEventListener('change', scan);
    cutoffInput.addEventListener('change', scan);

    importBtn.addEventListener('click', () => {
      if (!built) return;
      const now = Date.now();
      dispatch({ op: 'meta.set', value: { ...getState().meta, i2gMapping: curMapping(), i2gCutoff: cutoffInput.value || '' } });
      // 1) invoices
      if (built.invoiceValues.length) for (let i = 0; i < built.invoiceValues.length; i += 200) dispatch({ op: 'entity.bulkUpsert', kind: 'invoice', values: built.invoiceValues.slice(i, i + 200) });
      // 2) cashflow (only valid balanced entries; never into a locked period)
      let posted = 0, bad = 0;
      if (built.cf?.txns?.length) {
        const ctx = { accountsById: new Map(entities('account').map(a => [a.id, a])), locks: new Set(entities('lock').map(l => l.id)) };
        const good = built.cf.txns.filter(t => validateTxn(t, ctx).ok);
        bad = built.cf.txns.length - good.length;
        if (good.length) {
          for (let i = 0; i < good.length; i += 200) dispatch({ op: 'entity.bulkUpsert', kind: 'txn', values: good.slice(i, i + 200) });
          posted = good.length;
        } else if (built.cf.txns.length) { toast('Could not post cashflow — check the accounts (and that the period isn’t locked)', 'err'); }
      }
      // 3) payout records for reconciliation — merge to preserve any deposit match already made
      if (built.cf?.payoutEntities?.length) {
        const exById = new Map(entities('i2gpayout').map(p => [p.id, p]));
        const vals = built.cf.payoutEntities.map(p => ({ ...p, matchedDepositId: exById.get(p.id)?.matchedDepositId, updatedAt: now }));
        for (let i = 0; i < vals.length; i += 200) dispatch({ op: 'entity.bulkUpsert', kind: 'i2gpayout', values: vals.slice(i, i + 200) });
      }
      toast(`Imported ${built.invoiceValues.length} invoices · posted ${posted} cashflow entries${bad ? ` · ${bad} skipped` : ''}`);
      importBtn.disabled = true; built = null; file.value = '';
      clear(preview).append(el('p', { class: 'sub' }, 'Done — invoices and their real fees are on the books. Your bank deposits relieve the clearing account; when it nets to $0, every payment is matched to a deposit.'));
    });

    const field = (label, node) => el('div', {}, el('label', { class: 'field-label' }, label), node);
    clear(card).append(...[
      bare ? null : el('div', { class: 'cardtitle' }, 'Import from Invoice2go (one file)'),
      el('p', { class: 'sub' }, 'Upload the one-click Invoice2go export (invoice2go-export.json) — it brings in every invoice plus the real cashflow in one step. Each payment posts with its actual fees: the part you absorbed to COGS, the part the customer covered as contra-income, plus the 1% instant-payout fees, all tagged to their invoice. Income lands net in the clearing account; your bank deposits relieve it. Safe to re-run weekly — nothing duplicates.'),
      el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end' },
        field('Income account', incomeSel), field('Clearing account', clearingSel),
        field('Fees passed (income)', feePassedSel), field('Fees absorbed (COGS)', feeAbsorbedSel), field('Payout fee (expense)', payoutSel)),
      el('div', { style: 'margin-top:6px' }, ensureBtn),
      el('div', { style: 'display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-top:10px' },
        field('Start date (skip anything QuickBooks already has)', cutoffInput),
        el('div', { style: 'display:flex;gap:10px;align-items:center' }, file, importBtn)),
      preview,
    ].filter(Boolean));
  };
  draw();
  return card;
}

// ── Manual invoicing (P5): create / edit / record payment / delete ──
function invoiceModal(existing) {
  const m = modal(existing ? `Edit invoice #${existing.number}` : 'New invoice');
  const inv = existing || blankInvoice('inv-man-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), nextInvoiceNumber(entities('invoice')));
  const fi = (val, ph, extra = {}) => el('input', { class: 'field-input', value: val ?? '', placeholder: ph, ...extra });
  const name = fi(inv.clientName, 'Client name');
  const email = fi(inv.clientEmail, 'Email (optional)');
  const number = fi(inv.number, '#', { style: 'max-width:120px' });
  const date = el('input', { type: 'date', class: 'field-input', style: 'max-width:170px', value: inv.date || todayIso() });

  const linesBox = el('div');
  const totalLbl = el('div', { style: 'font-weight:800;margin-top:8px' });
  const rows = [];
  const recalc = () => {
    let sum = 0;
    for (const r of rows) {
      if (!r.tr.isConnected) continue;
      const qty = parseFloat(r.qty.value) || 0;
      const price = parseMoney(r.price.value) || 0;
      const amt = Math.round(qty * price);
      r.amt.textContent = fmtMoney(amt);
      sum += amt;
    }
    totalLbl.textContent = 'Total: ' + fmtMoney(sum);
  };
  const addRow = (li = { description: '', qty: 1, unitPriceCents: 0 }) => {
    const desc = fi(li.description, 'Description', { style: 'flex:1;min-width:160px' });
    const qty = fi(li.qty, 'Qty', { inputmode: 'decimal', style: 'width:64px', 'data-nocents': '1' });
    const price = fi(li.unitPriceCents ? (li.unitPriceCents / 100).toFixed(2) : '', 'Unit $', { inputmode: 'decimal', style: 'width:90px' });
    const amt = el('span', { class: 'num', style: 'min-width:80px;text-align:right' }, '$0.00');
    const rm = el('button', { class: 'linklike', style: 'color:var(--red)', onclick: () => { tr.remove(); recalc(); } }, '✕');
    const tr = el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:6px' }, desc, qty, price, amt, rm);
    [desc, qty, price].forEach(i => i.addEventListener('input', recalc));
    rows.push({ tr, desc, qty, price, amt });
    linesBox.append(tr);
  };
  (inv.lineItems?.length ? inv.lineItems : [{ description: '', qty: 1, unitPriceCents: 0 }]).forEach(addRow);
  recalc();

  m.body.append(
    el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' },
      el('div', { style: 'flex:1;min-width:200px' }, el('label', { class: 'field-label' }, 'Client'), name),
      el('div', {}, el('label', { class: 'field-label' }, 'Invoice #'), number),
      el('div', {}, el('label', { class: 'field-label' }, 'Date'), date)),
    el('label', { class: 'field-label' }, 'Email'), email,
    el('label', { class: 'field-label', style: 'margin-top:10px' }, 'Line items'),
    linesBox,
    el('button', { class: 'btn sm ghost', onclick: () => { addRow(); } }, '＋ Add line'),
    totalLbl,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:14px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: () => {
        if (!name.value.trim()) { toast('Enter a client name', 'err'); return; }
        if (!date.value) { toast('Pick a date', 'err'); return; }
        const lineItems = rows.filter(r => r.tr.isConnected && (r.desc.value.trim() || parseMoney(r.price.value)))
          .map(r => ({ code: '', description: r.desc.value.trim(), qty: parseFloat(r.qty.value) || 0, unitType: '', unitPriceCents: parseMoney(r.price.value) || 0 }));
        if (!lineItems.length) { toast('Add at least one line item', 'err'); return; }
        const saved = recompute({ ...inv, clientName: name.value.trim(), clientEmail: email.value.trim(), number: number.value.trim() || inv.number, date: date.value, lineItems });
        dispatch({ op: 'entity.upsert', kind: 'invoice', value: { ...saved, importedAt: inv.importedAt || Date.now(), updatedAt: Date.now() } });
        toast(existing ? 'Invoice updated' : 'Invoice created');
        m.close();
      } }, existing ? 'Save' : 'Create invoice')),
  );
  setTimeout(() => name.focus(), 0);
}

function paymentModal(inv) {
  const m = modal(`Record a payment — #${inv.number}`);
  const date = el('input', { type: 'date', class: 'field-input', style: 'max-width:170px', value: todayIso() });
  const amount = el('input', { class: 'field-input', inputmode: 'decimal', placeholder: (inv.balanceCents / 100).toFixed(2) });
  const method = el('select', { class: 'field-input' },
    ...METHOD_OPTS.map(([v, l]) => el('option', { value: v }, l)));
  m.body.append(
    el('p', { class: 'sub' }, `Open balance: ${fmtMoney(inv.balanceCents)}. Recorded payments post to the ledger from the Invoices list ("Post payments to the ledger").`),
    el('label', { class: 'field-label' }, 'Date'), date,
    el('label', { class: 'field-label' }, 'Amount ($)'), amount,
    el('label', { class: 'field-label' }, 'Method'), method,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn green', onclick: () => {
        const cents = parseMoney(amount.value);
        if (cents == null || cents <= 0) { toast('Enter a valid amount', 'err'); return; }
        if (!date.value) { toast('Pick a date', 'err'); return; }
        const txId = 'man-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const updated = addManualPayment(inv, { txId, date: date.value, amountCents: cents, method: method.value });
        dispatch({ op: 'entity.upsert', kind: 'invoice', value: { ...updated, updatedAt: Date.now() } });
        toast('Payment recorded');
        m.close();
      } }, 'Record payment')),
  );
  setTimeout(() => amount.focus(), 0);
}

// Instant-payout fee shortcut — Invoice2go's 1% "get paid now" charge, which isn't in
// any export. Books a Payout-Fee expense TAGGED to this invoice (so it counts in the
// job's profit margin), offset against a clearing account (not the bank — the bank
// balance is already correct from the QuickBooks import). Defaults to 1% of the net paid.
function payoutFeeModal(inv) {
  const accts = entities('account');
  const byId = new Map(accts.map(a => [a.id, a]));
  const bankish = (a) => a.qbType === 'BANK' || a.qbType === 'CCARD';
  const findBy = (re, ok) => accts.find(a => a.active !== false && ok(a) && (re.test(a.name || '') || re.test(a.qbName || '')));
  const feeAccts = accts.filter(a => a.active !== false && ['expense', 'cogs', 'other-expense'].includes(a.type));
  const clearingAccts = accts.filter(a => a.active !== false && a.type === 'asset' && !bankish(a));
  if (!feeAccts.length || !clearingAccts.length) { toast('Add an expense account and a non-bank asset (clearing) account first', 'err'); return; }
  const defFee = findBy(/payout/i, a => ['expense', 'cogs', 'other-expense'].includes(a.type)) || findBy(/fee/i, a => ['expense', 'cogs', 'other-expense'].includes(a.type)) || feeAccts[0];
  const i2gClear = byId.get(getState().meta?.i2gMapping?.clearingId);
  const defClear = findBy(/undeposited/i, a => a.type === 'asset' && !bankish(a)) || (i2gClear && !bankish(i2gClear) ? i2gClear : null) || clearingAccts[0];

  const succeeded = (inv.payments || []).filter(p => p.status === 'succeeded');
  const netCents = succeeded.reduce((s, p) => s + (p.amountCents | 0) - (p.feeCents | 0), 0) || inv.paidCents || 0;
  const lastDate = succeeded.map(p => p.date).filter(Boolean).sort().at(-1) || todayIso();

  const m = modal(`Instant-payout fee — #${inv.number}`);
  const payout = el('input', { class: 'field-input', inputmode: 'decimal', value: (netCents / 100).toFixed(2) });
  const feeIn = el('input', { class: 'field-input', inputmode: 'decimal', value: (Math.round(netCents * 0.01) / 100).toFixed(2) });
  payout.addEventListener('input', () => { const p = parseMoney(payout.value); if (p != null) feeIn.value = (Math.round(p * 0.01) / 100).toFixed(2); });
  const feeSel = el('select', { class: 'field-input' }, ...feeAccts.map(a => el('option', { value: a.id, selected: a.id === defFee?.id }, accountLabel(a, byId))));
  const clrSel = el('select', { class: 'field-input' }, ...clearingAccts.map(a => el('option', { value: a.id, selected: a.id === defClear?.id }, accountLabel(a, byId))));
  const date = el('input', { type: 'date', class: 'field-input', style: 'max-width:170px', value: lastDate });

  m.body.append(
    el('p', { class: 'sub' }, 'Invoice2go’s 1% instant-payout fee. Booked as a Payout-Fee expense tagged to this invoice (counts against its profit), taken from the clearing account so your bank balance isn’t touched.'),
    el('label', { class: 'field-label' }, 'Amount paid out ($)'), payout,
    el('label', { class: 'field-label' }, 'Fee (1%) ($)'), feeIn,
    el('label', { class: 'field-label' }, 'Fee account'), feeSel,
    el('label', { class: 'field-label' }, 'Taken from (clearing)'), clrSel,
    el('label', { class: 'field-label' }, 'Date'), date,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn green', onclick: () => {
        const feeCents = parseMoney(feeIn.value);
        if (feeCents == null || feeCents <= 0) { toast('Enter a fee amount', 'err'); return; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date.value)) { toast('Pick a date', 'err'); return; }
        if (feeSel.value === clrSel.value) { toast('Fee and clearing accounts must differ', 'err'); return; }
        const txn = {
          id: 'i2gpf-' + (inv.id || inv.sourceId) + '-' + date.value + '-' + feeCents,
          date: date.value, payee: (inv.clientName || 'Customer') + (inv.number ? ' — #' + inv.number : ''),
          memo: 'Invoice2go instant-payout fee (1%)', invoiceId: inv.id,
          lines: [{ accountId: feeSel.value, amountCents: feeCents }, { accountId: clrSel.value, amountCents: -feeCents }],
          status: 'posted', source: { app: 'manual' },
        };
        const v = validateTxn(txn, { accountsById: byId, locks: new Set(entities('lock').map(l => l.id)) });
        if (!v.ok) { toast(v.error, 'err'); return; }
        dispatch({ op: 'entity.upsert', kind: 'txn', value: txn });
        toast('Payout fee recorded');
        m.close();
      } }, 'Record fee')),
  );
  setTimeout(() => feeIn.focus(), 0);
}

function confirmDeleteInvoice(inv) {
  const posted = entities('txn').some(t => t.invoiceId === inv.id && (t.source?.app === 'i2g-cashflow' || t.source?.app === 'invoice2go'));
  const m = modal('Delete this invoice?');
  m.body.append(
    el('p', {}, `Delete invoice #${inv.number} for ${inv.clientName || 'this client'}? This removes the A/R record.`),
    posted ? el('p', { class: 'sub' }, 'Some payments were already posted to the ledger — those transactions stay posted (remove them in the Ledger if needed).') : el('span'),
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Keep it'),
      el('button', { class: 'btn', style: 'background:var(--red)', onclick: () => {
        dispatch({ op: 'entity.delete', kind: 'invoice', id: inv.id });
        toast('Invoice deleted');
        m.close();
        location.hash = `#/b/${getActiveBiz()}/invoices`;
      } }, 'Delete')),
  );
}

// ── List + aging ──
// The KPI strip + aging chips (redraw on every sync). Split from the table so the search
// box can sit in a persistent toolbar between them — see render().
function drawHead(headBox, redraw) {
  const invoices = entities('invoice');
  if (!invoices.length) { clear(headBox); return; }
  const totalOpen = invoices.reduce((s, i) => s + i.balanceCents, 0);
  const openCount = invoices.filter(i => i.balanceCents > 0).length;

  // AR aging on open balances, by days since invoice date.
  const t = todayIso();
  const aging = AGING_BUCKETS.map(() => 0);
  for (const inv of invoices) { const bi = bucketOf(inv, t); if (bi >= 0) aging[bi] += inv.balanceCents; }

  const kpi = (label, val, cls) => el('div', { class: 'card', style: 'flex:1;min-width:150px;padding:12px 16px' },
    el('div', { class: 'sub', style: 'margin:0' }, label),
    el('div', { style: `font-size:1.4em;font-weight:800;${cls || ''}` }, val));

  // "Collected" KPI with its own date-range picker (presets + custom calendar).
  if (!collectedCtl) collectedCtl = dateRangeControl({ initial: 'all', onChange: (r) => { collectedRange = r; redraw(); } });
  const collected = collectedCents(collectedRange);
  const collectedCard = el('div', { class: 'card', style: 'flex:1;min-width:210px;padding:12px 16px' },
    el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap' },
      el('div', { class: 'sub', style: 'margin:0' }, 'Collected'),
      el('div', { class: 'collected-range' }, collectedCtl.el)),
    el('div', { style: 'font-size:1.4em;font-weight:800;color:var(--green,#2a8);margin-top:4px' }, fmtMoney(collected)));

  // Aging chips: tap one to filter the list to that bucket's open invoices.
  const chip = (label, cls, idx, amount) => {
    const on = agingFilter === idx;
    return el('button', {
      class: 'pill ' + cls,
      style: 'cursor:pointer;border:1.5px solid transparent;' + (on ? 'box-shadow:0 0 0 2px var(--brand) inset' : ''),
      onclick: () => { agingFilter = on ? null : idx; redraw(); },
    }, amount != null ? `${label} · ${fmtMoney(amount)}` : label);
  };
  const agingChips = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px' },
    el('span', { class: 'sub', style: 'margin:0 4px 0 0;font-weight:700' }, 'A/R aging'),
    chip('All open', 'gray', null),
    ...AGING_BUCKETS.map(([l], i) => chip(l, aging[i] > 0 ? 'amber' : 'gray', i, aging[i])));

  clear(headBox).append(
    el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px' },
      kpi('Open balance', fmtMoney(totalOpen), 'color:var(--red)'),
      kpi('Open invoices', String(openCount)),
      collectedCard,
      kpi('Invoices', String(invoices.length)),
    ),
    agingChips,
  );
}

// Everything one search term is matched against: client, invoice #, status, source, and
// each amount in a few forms ("1250", "1250.00", "$1,250.00") so typing any of them hits.
function invHaystack(inv) {
  const st = statusOf(inv);
  const money = (c) => { c = c || 0; return `${(Math.abs(c) / 100).toFixed(2)} ${Math.round(Math.abs(c) / 100)} ${fmtMoney(c)}`; };
  return [inv.number, '#' + (inv.number || ''), inv.clientName, inv.clientEmail, st.label, st.key, sourceOf(inv).label,
    money(inv.totalCents), money(inv.paidCents), money(inv.balanceCents), inv.date].join(' ').toLowerCase();
}

// The invoice table — re-filtered by the active aging chip AND the search box. Each search
// term must match (AND), so "harbor partial" or "overdue 880" both narrow as expected.
function drawInvoiceTable(tableBox, count) {
  const biz = getActiveBiz();
  const invoices = entities('invoice').slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (!invoices.length) {
    if (count) count.textContent = '';
    clear(tableBox).append(el('p', { class: 'sub' }, 'No invoices yet. Use the “Import from Invoice2go” button above to get started.'));
    return;
  }
  const t = todayIso();
  let shown = agingFilter == null ? invoices : invoices.filter(inv => bucketOf(inv, t) === agingFilter);
  const q = invoiceQuery.trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    shown = shown.filter(inv => { const h = invHaystack(inv); return terms.every(tm => h.includes(tm)); });
  }
  if (count) count.textContent = `${shown.length} ${shown.length === 1 ? 'invoice' : 'invoices'}`;

  const rows = shown.map(inv => {
    const st = statusOf(inv);
    const src = sourceOf(inv);
    const tr = el('tr', { style: 'cursor:pointer' },
      el('td', {}, el('span', { style: 'font-weight:700;color:var(--brand)' }, '#' + (inv.number || '—'))),
      el('td', {}, inv.date || '—'),
      el('td', {}, inv.clientName || '—'),
      el('td', {}, el('span', { class: 'pill ' + src.cls }, src.label)),
      el('td', { class: 'num' }, acctAmount(inv.totalCents, { colored: false })),
      el('td', { class: 'num' }, acctAmount(inv.paidCents, { colored: false })),
      el('td', { class: 'num ' + (inv.balanceCents > 0 ? 'neg' : '') }, acctAmount(inv.balanceCents, { colored: false })),
      el('td', {}, el('span', { class: 'pill ' + st.cls }, st.label)),
    );
    tr.addEventListener('click', () => { location.hash = `#/b/${biz}/invoices/${inv.id}`; });
    return tr;
  });

  appendKids(clear(tableBox),
    el('div', { class: 'card', style: 'padding:0;overflow:hidden' },
      el('table', { class: 'data xl' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Invoice'), el('th', {}, 'Invoice date'), el('th', {}, 'Client'), el('th', {}, 'Source'),
          el('th', { class: 'num' }, 'Total'), el('th', { class: 'num' }, 'Paid'), el('th', { class: 'num' }, 'Open'), el('th', {}, 'Status'))),
        el('tbody', {}, ...rows))),
    !rows.length ? el('p', { class: 'sub', style: 'margin:12px 0 0' }, q ? 'No invoices match your search.' : 'No open invoices in this aging bucket.') : null,
  );
}

// ── Drill-down ──
// The Invoice2go cashflow entries (payments/payouts) are system bookings for fees —
// they belong in the profit breakdown, not the "Linked expenses" (job-cost) list.
const isI2gSystemTxn = (t) => t.source?.app === 'i2g-cashflow' || t.source?.app === 'i2g-cashflow-payout';

// Drill-down: the full double-entry for one transaction.
function txnDetailModal(t, accountsById) {
  const m = modal(`Transaction · ${t.date || ''}`);
  m.body.append(
    el('p', { class: 'sub', style: 'margin-top:0' }, `${t.payee || '—'}${t.memo ? ' · ' + t.memo : ''}`),
    el('table', { class: 'data xl' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Account'), el('th', { class: 'num' }, 'Debit'), el('th', { class: 'num' }, 'Credit'))),
      el('tbody', {}, ...(t.lines || []).map(l => {
        const a = accountsById.get(l.accountId);
        return el('tr', {},
          el('td', {}, a ? accountLabel(a, accountsById) : l.accountId),
          el('td', { class: 'num' }, l.amountCents > 0 ? acctAmount(l.amountCents, { colored: false }) : ''),
          el('td', { class: 'num' }, l.amountCents < 0 ? acctAmount(-l.amountCents, { colored: false }) : ''));
      }))),
    el('div', { style: 'display:flex;justify-content:flex-end;margin-top:12px' }, el('button', { class: 'btn', onclick: m.close }, 'Close')));
}

// Drill-down: the transactions behind a profit-panel line (a fee or job-cost total).
function txnListModal(title, txns, accountsById, amountFor) {
  const m = modal(title);
  m.body.append(txns.length
    ? el('table', { class: 'data xl' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Payee'), el('th', { class: 'num' }, 'Amount'), el('th', {}, ''))),
        el('tbody', {}, ...txns.map(t => el('tr', {},
          el('td', {}, t.date || '—'),
          el('td', {}, prettyDesc(t.payee) || '—'),
          el('td', { class: 'num' }, acctAmount(amountFor ? amountFor(t) : 0, { colored: false })),
          el('td', {}, el('button', { class: 'linklike', onclick: () => txnDetailModal(t, accountsById) }, 'View'))))))
    : el('p', { class: 'sub' }, 'No entries.'));
  m.body.append(el('div', { style: 'display:flex;justify-content:flex-end;margin-top:12px' }, el('button', { class: 'btn', onclick: m.close }, 'Close')));
}

// Clearly labeled dates — Invoice2go gives an invoice date, a created date, a due
// date, and (when paid) a paid date. "Created" is hidden when it equals the invoice
// date (the common case) to avoid noise. There is no structured "event date".
function dateBlock(inv) {
  const chip = (label, val) => el('div', {},
    el('div', { class: 'field-label', style: 'margin:0' }, label),
    el('div', { style: 'font-weight:600' }, val || '—'));
  const chips = [chip('Invoice date', inv.date)];
  if (inv.createdDate && inv.createdDate !== inv.date) chips.push(chip('Created', inv.createdDate));
  if (inv.dueDate) chips.push(chip('Due', inv.dueDate));
  if (inv.datePaid) chips.push(chip('Paid', inv.datePaid));
  return el('div', { style: 'display:flex;flex-wrap:wrap;gap:24px;margin:8px 0 2px' }, ...chips);
}

// ── Reconcile Invoice2go payouts ↔ bank deposits ──
const payoutMethodLabel = (m) => ({ rtp: 'instant payout', same_day_ach: 'same-day ACH' }[m] || (m || '').replace(/_/g, ' '));
const kpiCard = (label, value, note) => el('div', { class: 'card', style: 'flex:1;min-width:190px' },
  el('div', { class: 'kpilbl' }, label), el('div', { class: 'kpi' }, value),
  note ? el('div', { class: 'sub', style: 'margin:0' }, note) : null);

function reconTable(title, headers, rows, note, collapsible = false) {
  const isNum = (h) => /amount/i.test(h);
  const tableEl = rows.length
    ? el('div', { class: 'card', style: 'padding:0;overflow:auto;max-width:880px' },
        el('table', { class: 'data xl' },
          el('thead', {}, el('tr', {}, ...headers.map(h => el('th', { class: isNum(h) ? 'num' : '' }, h)))),
          el('tbody', {}, ...rows.map(r => el('tr', {}, ...r.map((c, i) => el('td', { class: isNum(headers[i]) ? 'num' : '' }, c)))))))
    : el('p', { class: 'sub' }, 'None — all clear. 🎉');
  const noteEl = note ? el('p', { class: 'sub', style: 'max-width:880px;margin-top:4px' }, note) : null;
  // Long lists collapse to keep the screen scannable; open it when you need the detail.
  if (collapsible && rows.length) return el('details', { style: 'margin-bottom:16px' },
    el('summary', { class: 'cardtitle', style: 'cursor:pointer;margin-bottom:6px' }, `${title} (${rows.length})`),
    tableEl, noteEl);
  return el('div', { style: 'margin-bottom:16px' },
    title ? el('div', { class: 'cardtitle', style: 'margin-bottom:6px' }, title) : null,
    tableEl, noteEl);
}

function renderReconcile(root) {
  const biz = getActiveBiz();
  const banks = entities('bankacct');
  root.append(
    el('a', { class: 'btn sm ghost', href: `#/b/${biz}/invoices` }, '← Invoices'),
    el('h2', { style: 'margin-top:10px' }, 'Reconcile Invoice2go to the bank'),
    el('p', { class: 'sub' }, 'Each Invoice2go payout should equal one bank deposit. Matches are found automatically by amount and date — the two lists below are what needs your eyes: payouts with no matching deposit, and bank deposits that aren’t Invoice2go (your other income). Scoped to the app-owned period (your import start date onward); earlier deposits belong to QuickBooks.'));
  if (!banks.length) { root.append(el('p', { class: 'sub' }, 'Add a bank account in Banking first.')); return; }
  let bankId = (banks.find(b => /0116/.test(b.name)) || banks[0]).id;
  const sel = el('select', { class: 'field-input', style: 'max-width:260px', onchange: (e) => { bankId = e.target.value; draw(); } },
    ...banks.map(b => el('option', { value: b.id, selected: b.id === bankId }, b.name)));
  const body = el('div');
  root.append(el('div', { style: 'margin:10px 0 14px' }, el('label', { class: 'field-label' }, 'Bank account that receives Invoice2go deposits'), sel), body);

  // AI "match a bank deposit → the invoice it paid" state, kept across redraws.
  const aiResults = new Map();   // depositId -> { invoiceId, confidence, reason }
  let aiBusy = false;
  const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const toks = s => new Set(norm(s).split(' ').filter(w => w.length > 2));
  const confPill = c => el('span', { class: 'pill ' + (c >= 90 ? 'green' : c >= 60 ? 'amber' : 'gray'), style: 'white-space:nowrap' }, `✨ ${c}%`);
  const aiErrMsg = data => data.error === 'ai_budget_reached' ? 'Monthly AI budget reached — raise it in Settings to keep going.'
    : data.error === 'ai_paused' ? 'AI is paused in Settings.'
    : data.error === 'ai_not_configured' ? 'AI isn’t set up yet (no API key).'
    : data.message ? `AI error: ${data.message}` : 'The AI matcher couldn’t run — try again.';
  const invGroups = (payee, invs) => {
    const B = toks(payee);
    const overlaps = name => { for (const w of toks(name)) if (B.has(w)) return true; return false; };
    const opt = i => ({ value: i.id, label: `#${i.number || i.id} · ${i.clientName || '—'} · ${fmtMoney(i.totalCents || 0)}` });
    const likely = invs.filter(i => i.clientName && overlaps(i.clientName));
    const likelyIds = new Set(likely.map(i => i.id));
    const rest = invs.filter(i => !likelyIds.has(i.id));
    const groups = [];
    if (likely.length) groups.push({ label: 'Likely matches', items: likely.map(opt) });
    if (rest.length) groups.push({ label: likely.length ? 'All invoices' : '', items: rest.map(opt) });
    return { groups, single: likely.length === 1 ? likely[0] : null };
  };

  const draw = () => {
    const bank = banks.find(b => b.id === bankId), acct = bank.accountId;
    // Scope to the app-owned period (Invoice2go start date) — earlier deposits belong to
    // QuickBooks (already reconciled) and would just be noise in this Invoice2go view.
    const cutoff = getState().meta?.i2gCutoff || '2026-03-01';
    // deposits = money IN on this bank, on/after the cutoff: posted txns + newly imported (staged) rows
    const posted = entities('txn').filter(t => t.status === 'posted' && !/^(i2gc-|i2gpo-)/.test(t.id) && (t.date || '') >= cutoff)
      .map(t => ({ id: t.id, date: t.date, amountCents: (t.lines || []).reduce((s, l) => s + (l.accountId === acct ? l.amountCents : 0), 0), kind: 'posted', payee: t.payee || '—', invoiceId: t.invoiceId || '' }))
      .filter(d => d.amountCents > 0);
    const staged = entities('staged').filter(s => s.bankacctId === bankId && s.status === 'pending' && (s.amountCents || 0) > 0 && (s.date || '') >= cutoff)
      .map(s => ({ id: s.id, date: s.date, amountCents: s.amountCents, kind: 'new', payee: s.desc || '—' }));
    const deposits = [...posted, ...staged];
    // Scope payouts to the SAME app-owned period as the deposits above. Pre-cutoff payouts
    // (Oct'25–Feb'26) belong to the QuickBooks-reconciled period; their bank deposits are
    // intentionally excluded here, so without this filter they could never match and every
    // one showed as a false "no matching bank deposit".
    const payouts = entities('i2gpayout').filter(p => (p.date || '') >= cutoff);
    const { matches, unmatchedPayouts, unmatchedDeposits } = reconcilePayouts(payouts, deposits);
    const sumP = arr => arr.reduce((s, x) => s + (x.netToBankCents || 0), 0);
    const sumD = arr => arr.reduce((s, x) => s + (x.amountCents || 0), 0);

    // Post matched deposits → relieve the Invoice2go Clearing account. Only the
    // not-yet-posted (staged) matches need posting; already-posted ones are done.
    const ctx = { accountsById: new Map(entities('account').map(a => [a.id, a])), locks: new Set(entities('lock').map(l => l.id)) };
    const clearingId = getState().meta?.i2gMapping?.clearingId;
    const clearingName = (entities('account').find(a => a.id === clearingId) || {}).name || 'clearing';
    const clearingBal = entities('txn').reduce((s, t) => s + (t.lines || []).reduce((a, l) => a + (l.accountId === clearingId ? l.amountCents : 0), 0), 0);
    const toPost = matches.filter(m => m.deposit.kind === 'new');
    const postMatches = () => {
      if (!clearingId) { toast('Set the clearing account first (Invoices → Import card).', 'err'); return; }
      if (!confirm(`Post ${toPost.length} matched deposits to “${clearingName}”? Each is recorded in your bank and relieves the clearing account.`)) return;
      let n = 0;
      for (const m of toPost) {
        const row = entities('staged').find(s => s.id === m.deposit.id);
        if (!row || row.status !== 'pending') continue;
        const txn = simpleTxn({ id: 't-' + row.id, date: row.date, payee: row.desc || 'Invoice2go payout', memo: 'Invoice2go payout (matched)', amountCents: Math.abs(row.amountCents), direction: 'in', bankAccountId: acct, categoryAccountId: clearingId, source: { app: 'csv', importId: row.importId, sourceId: row.id } });
        if (!validateTxn(txn, ctx).ok) continue;
        dispatch({ op: 'entity.upsert', kind: 'txn', value: txn });
        dispatch({ op: 'entity.upsert', kind: 'staged', value: { ...row, status: 'approved', txnId: txn.id, categoryId: clearingId } });
        n++;
      }
      toast(`Posted ${n} matched deposits to ${clearingName}`);
      draw();
    };

    // ── "Other income" → match each non-Invoice2go deposit to the invoice it paid ──
    const incomeId = getState().meta?.i2gMapping?.incomeId;
    const incomeName = (entities('account').find(a => a.id === incomeId) || {}).name || 'invoice income';
    const invs = entities('invoice').slice().sort((a, b) => String(b.number || '').localeCompare(String(a.number || '')));
    // Needs-attention list: drop deposits already linked to an invoice (posted + tagged).
    const otherIncome = unmatchedDeposits.filter(d => !d.invoiceId).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const linkedCount = unmatchedDeposits.length - otherIncome.length;

    // Posting a matched deposit RECOGNIZES the income (these were never on the books) to the
    // invoice-income account and tags the invoice. Already-posted deposits are only tagged.
    const postDeposit = (dep, invoiceId, { quiet = false } = {}) => {
      if (!invoiceId) { toast('Pick an invoice first', 'err'); return false; }
      const inv = invs.find(i => i.id === invoiceId);
      if (dep.kind === 'new') {
        if (!incomeId) { toast('Set the invoice income account first (Invoices → Import card).', 'err'); return false; }
        if (!quiet && !confirm(`Post ${fmtMoney(Math.abs(dep.amountCents))} as income to “${incomeName}” and link it to invoice #${inv?.number || '?'}?`)) return false;
        const row = entities('staged').find(s => s.id === dep.id);
        if (!row || row.status !== 'pending') return false;
        const txn = simpleTxn({ id: 't-' + row.id, date: row.date, payee: row.desc || 'Customer payment', memo: `Invoice payment — matched to #${inv?.number || ''}`, amountCents: Math.abs(row.amountCents), direction: 'in', bankAccountId: acct, categoryAccountId: incomeId, source: { app: 'csv', importId: row.importId, sourceId: row.id } });
        txn.invoiceId = invoiceId;
        if (!validateTxn(txn, ctx).ok) { toast('Could not post — the income account may be in a locked period.', 'err'); return false; }
        dispatch({ op: 'entity.upsert', kind: 'txn', value: txn });
        dispatch({ op: 'entity.upsert', kind: 'staged', value: { ...row, status: 'approved', txnId: txn.id, categoryId: incomeId, invoiceId } });
      } else {
        if (!quiet && !confirm(`Link this ${fmtMoney(Math.abs(dep.amountCents))} deposit (already recorded as income) to invoice #${inv?.number || '?'}?`)) return false;
        const t = entities('txn').find(x => x.id === dep.id);
        if (!t) return false;
        dispatch({ op: 'entity.upsert', kind: 'txn', value: { ...t, invoiceId, updatedAt: Date.now() } });
      }
      aiResults.delete(dep.id);
      return true;
    };
    const postOne = (dep, invoiceId) => { if (postDeposit(dep, invoiceId)) { toast('Posted as income'); draw(); } };
    const askAIDeposits = async () => {
      if (aiBusy || !otherIncome.length) return;
      aiBusy = true; draw();
      try {
        const payments = otherIncome.slice(0, 40).map(d => ({ id: d.id, date: d.date, payee: d.payee, amountCents: d.amountCents }));
        const invoices = invs.map(i => ({ id: i.id, number: i.number, clientName: i.clientName, totalCents: i.totalCents, date: i.date, datePaid: i.datePaid }));
        const res = await api(`/b/${getStateBiz()}/ai/match-invoices`, { method: 'POST', body: JSON.stringify({ payments, invoices }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { toast(aiErrMsg(data), 'err'); aiBusy = false; draw(); return; }
        for (const s of (data.suggestions || [])) if (s.invoiceId) aiResults.set(s.id, s);
        const n = (data.suggestions || []).filter(s => s.invoiceId).length;
        toast(n ? `AI matched ${n} deposit${n === 1 ? '' : 's'} to invoices — review and post` : 'AI found no invoice matches among these');
        aiBusy = false; draw();
      } catch { toast('Couldn’t reach the AI matcher — try again', 'err'); aiBusy = false; draw(); }
    };
    const postHighConf = () => {
      const hi = otherIncome.filter(d => { const s = aiResults.get(d.id); return s && s.invoiceId && s.confidence >= 90; });
      if (!hi.length) return;
      if (!incomeId) { toast('Set the invoice income account first (Invoices → Import card).', 'err'); return; }
      const totalC = hi.reduce((s, d) => s + Math.abs(d.amountCents), 0);
      if (!confirm(`Post ${hi.length} deposit${hi.length === 1 ? '' : 's'} (${fmtMoney(totalC)} total) as income to “${incomeName}”, each linked to its matched invoice?`)) return;
      let n = 0;
      for (const d of hi) if (postDeposit(d, aiResults.get(d.id).invoiceId, { quiet: true })) n++;
      toast(`Posted ${n} deposit${n === 1 ? '' : 's'} as income`);
      draw();
    };
    const otherIncomeSection = () => {
      const hiCount = otherIncome.filter(d => { const s = aiResults.get(d.id); return s && s.invoiceId && s.confidence >= 90; }).length;
      const head = el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0 8px' },
        el('div', { class: 'cardtitle', style: 'flex:1;margin:0' }, `⚠️ Bank deposits that aren’t Invoice2go (other income) (${otherIncome.length})`),
        el('button', { class: 'btn sm', disabled: aiBusy || !otherIncome.length, onclick: askAIDeposits }, aiBusy ? '✨ Asking Claude…' : '✨ Suggest invoice matches with AI'),
        hiCount ? el('button', { class: 'btn sm green', onclick: postHighConf }, `Post all ${hiCount} at 90%+`) : el('span'));
      if (!otherIncome.length) return el('div', { style: 'margin-bottom:16px' }, head, el('p', { class: 'sub' }, 'None — all clear. 🎉'));
      const tbody = el('tbody');
      for (const d of otherIncome.slice(0, 200)) {
        const { groups, single } = invGroups(d.payee, invs);
        const sug = aiResults.get(d.id);
        const cb = combobox({ groups, value: sug?.invoiceId || (single ? single.id : ''), placeholder: 'Search invoices…', minWidth: 0, emptyText: 'No matching invoice — import it first', scrollToEnd: false });
        cb.style.cssText = 'width:100%;min-width:0';
        const hint = sug ? el('span', { title: sug.reason || '', style: 'display:inline-flex;align-items:center;gap:5px' }, confPill(sug.confidence), sug.reason ? el('span', { class: 'sub', style: 'margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px' }, sug.reason) : el('span')) : el('span', { class: 'sub', style: 'margin:0' }, single ? 'name match' : '');
        tbody.append(el('tr', {},
          el('td', { style: 'white-space:nowrap' }, d.date || '—'),
          el('td', { class: 'num' }, acctAmount(d.amountCents, { colored: false })),
          el('td', {}, prettyDesc(d.payee) || '—'),
          el('td', {}, el('div', { style: 'display:flex;flex-direction:column;gap:3px' }, cb, hint)),
          el('td', {}, el('button', { class: 'btn sm green', onclick: () => postOne(d, cb.value) }, d.kind === 'new' ? 'Post → link' : 'Link'))));
      }
      return el('div', { style: 'margin-bottom:16px' },
        head,
        el('p', { class: 'sub', style: 'max-width:900px;margin:0 0 8px' }, `Deposits received outside Invoice2go (Zelle, checks, etc.). Match one to the invoice it paid and it posts as income to “${incomeName}” and links to that invoice. Deposits that aren’t invoice payments — categorize as usual in Review.${otherIncome.length > 40 ? ' AI matches the first 40 at a time.' : ''}${linkedCount ? ` · ${linkedCount} already linked` : ''}`),
        el('div', { class: 'card', style: 'padding:0' },
          el('table', { class: 'data xl', style: 'table-layout:fixed;width:100%;max-width:900px' },
            el('colgroup', {}, el('col', { style: 'width:92px' }), el('col', { style: 'width:100px' }), el('col', {}), el('col', { style: 'width:250px' }), el('col', { style: 'width:96px' })),
            el('thead', {}, el('tr', {}, el('th', {}, 'Deposit date'), el('th', { class: 'num' }, 'Amount'), el('th', {}, 'Description'), el('th', {}, 'Match to invoice'), el('th', {}, ''))),
            tbody)));
    };

    clear(body).append(
      el('div', { class: 'row', style: 'margin-bottom:14px' },
        kpiCard('Payouts matched', `${matches.length} / ${payouts.length}`, fmtMoney(matches.reduce((s, m) => s + m.payout.netToBankCents, 0))),
        kpiCard('Payouts not matched', String(unmatchedPayouts.length), fmtMoney(sumP(unmatchedPayouts)) + ' — investigate'),
        kpiCard('Deposits not Invoice2go', String(otherIncome.length), fmtMoney(sumD(otherIncome)) + ' — other income')),
      el('div', { style: 'display:flex;gap:14px;align-items:center;margin-bottom:16px;flex-wrap:wrap' },
        el('button', { class: 'btn green', disabled: !toPost.length || !clearingId, onclick: postMatches }, toPost.length ? `Post ${toPost.length} matched deposits → ${clearingName}` : 'All matched deposits posted ✓'),
        el('span', { class: 'sub' }, `${clearingName} balance: `, el('b', {}, fmtMoney(clearingBal)), ' — drains toward $0 as matches post')),
      reconTable('⚠️ Invoice2go payouts with no matching bank deposit', ['Payout date', 'Amount', 'Method'],
        unmatchedPayouts.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(p => [p.date, fmtMoney(p.netToBankCents), payoutMethodLabel(p.method)]),
        'These need either the bank statement for that period imported, or a manual match (coming next). Each should eventually tie to a real deposit.'),
      otherIncomeSection(),
      el('details', {},
        el('summary', { class: 'sub', style: 'cursor:pointer;margin-bottom:6px' }, `✅ ${matches.length} matched payouts (click to view)`),
        reconTable('', ['Payout date', 'Amount', '→ Deposit date', 'Source'],
          matches.map(m => [m.payout.date, fmtMoney(m.payout.netToBankCents), m.deposit.date, m.deposit.kind === 'new' ? 'new import' : 'on file']))));
  };
  draw();
}

function renderInvoiceDetail(root, id) {
  const biz = getActiveBiz();
  const inv = entities('invoice').find(i => i.id === id);
  const back = el('a', { class: 'btn sm ghost', href: `#/b/${biz}/invoices` }, '← Invoices');
  if (!inv) { root.append(el('p', { class: 'sub' }, 'That invoice is no longer here.'), back); return; }
  const st = statusOf(inv);
  const editable = canEdit(biz);
  const isManual = inv.source?.app === 'manual';

  // Per-invoice margin (#3): billed total − expenses tagged to this invoice (txn.invoiceId).
  const accountsById = new Map(entities('account').map(a => [a.id, a]));
  const allTxns = entities('txn');
  const isExpenseTxn = (t) => t.lines.some(l => { const a = accountsById.get(l.accountId); return a && (a.type === 'expense' || a.type === 'cogs'); });
  const expenseAmt = (t) => { let s = 0; for (const l of t.lines) { const a = accountsById.get(l.accountId); if (a && (a.type === 'expense' || a.type === 'cogs')) s += l.amountCents; } return s; };
  const expensesTotal = invoiceExpensesTotal(allTxns, accountsById, inv.id);
  const marginCents = inv.totalCents - expensesTotal;
  const marginPct = inv.totalCents > 0 ? Math.round((marginCents / inv.totalCents) * 100) : null;
  // Break the tagged costs into card-fee-absorbed (COGS), payout fee, and the rest
  // (job costs), and read the fee passed to the customer straight off the invoice.
  const i2gMap = getState().meta?.i2gMapping || {};
  const taggedExpLines = [];
  for (const t of allTxns) if (t.status === 'posted' && t.invoiceId === inv.id)
    for (const l of t.lines) { const a = accountsById.get(l.accountId); if (a && (a.type === 'expense' || a.type === 'cogs')) taggedExpLines.push({ l, a }); }
  const sumWhere = (pred) => taggedExpLines.reduce((s, x) => s + (pred(x.a) ? x.l.amountCents : 0), 0);
  const cardAbsorbed = sumWhere(a => a.id === i2gMap.feeAbsorbedId || (a.type === 'cogs' && /processing|card fee/i.test(a.name || '')));
  const payoutFee = sumWhere(a => /payout/i.test(a.name || ''));
  const jobExpenses = expensesTotal - cardAbsorbed - payoutFee;
  // Fee the customer covered = the contra-income tagged to this invoice (real, from the
  // cashflow). Falls back to the CSV surcharge (paid over total) for CSV-only invoices.
  let feePassedTagged = 0;
  for (const t of allTxns) if (t.status === 'posted' && t.invoiceId === inv.id)
    for (const l of t.lines) { if (l.accountId === i2gMap.feePassedId) feePassedTagged += l.amountCents; }
  const feePassed = feePassedTagged || Math.max(0, (inv.paidCents | 0) - (inv.totalCents | 0));
  // Contributing entries behind each profit line (for the drill-downs).
  const tagged = allTxns.filter(t => t.status === 'posted' && t.invoiceId === inv.id);
  const lineSum = (t, pred) => t.lines.reduce((s, l) => s + (pred(accountsById.get(l.accountId), l) ? l.amountCents : 0), 0);
  const isAbsorbedAcct = (a) => a && (a.id === i2gMap.feeAbsorbedId || (a.type === 'cogs' && /processing|card fee/i.test(a.name || '')));
  const isPayoutAcct = (a) => a && /payout/i.test(a.name || '');
  const absorbedTxns = tagged.filter(t => lineSum(t, isAbsorbedAcct) !== 0);
  const payoutTxns = tagged.filter(t => lineSum(t, isPayoutAcct) !== 0);
  const passedTxns = tagged.filter(t => t.lines.some(l => l.accountId === i2gMap.feePassedId));
  // "Linked expenses" = genuine job costs only — not the Invoice2go fee bookings (those
  // live in the profit lines above), and not zero-expense entries (confusing "$0.00").
  const linkedExpenses = tagged.filter(t => !isI2gSystemTxn(t) && expenseAmt(t) !== 0).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const candidates = allTxns.filter(t => t.status === 'posted' && t.invoiceId !== inv.id && isExpenseTxn(t) && !isI2gSystemTxn(t)).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 100);
  const linkSel = el('select', { class: 'field-input', style: 'max-width:360px' },
    el('option', { value: '' }, '— pick an expense to link —'),
    ...candidates.map(t => el('option', { value: t.id }, `${t.date} · ${(t.payee || '—').slice(0, 30)} · ${fmtMoney(expenseAmt(t))}`)));
  const expenseRows = linkedExpenses.map(t => el('tr', { style: 'cursor:pointer', title: 'View transaction', onclick: () => txnDetailModal(t, accountsById) },
    el('td', {}, t.date),
    el('td', {}, prettyDesc(t.payee) || '—'),
    el('td', { class: 'num' }, acctAmount(expenseAmt(t), { colored: false })),
    el('td', {}, editable ? el('button', { class: 'linklike', onclick: (e) => { e.stopPropagation(); dispatch({ op: 'entity.upsert', kind: 'txn', value: { ...t, invoiceId: undefined } }); toast('Unlinked'); } }, 'Unlink') : '')));
  const expensesCard = (editable || linkedExpenses.length)
    ? el('div', { class: 'card', style: 'max-width:640px;margin-bottom:14px' },
        el('div', { class: 'cardtitle' }, 'Linked expenses'),
        linkedExpenses.length
          ? el('table', { class: 'data xl' },
              el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Payee'), el('th', { class: 'num' }, 'Expense'), el('th', {}, ''))),
              el('tbody', {}, ...expenseRows))
          : el('p', { class: 'sub' }, 'No job expenses linked yet.'),
        editable ? el('div', { style: 'display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap' },
          linkSel,
          el('button', { class: 'btn sm', onclick: () => {
            const t = allTxns.find(x => x.id === linkSel.value);
            if (!t) { toast('Pick an expense to link', 'err'); return; }
            dispatch({ op: 'entity.upsert', kind: 'txn', value: { ...t, invoiceId: inv.id } });
            toast('Expense linked');
          } }, 'Link expense'),
          el('button', { class: 'btn sm ghost', title: 'Record Invoice2go’s 1% instant-payout fee against this invoice', onclick: () => payoutFeeModal(inv) }, '＋ Payout fee')) : el('span'))
    : el('span');

  const actions = el('div', { style: 'display:flex;gap:8px;margin:10px 0 4px;flex-wrap:wrap' });
  if (editable && isManual) {
    actions.append(
      el('button', { class: 'btn sm', onclick: () => invoiceModal(inv) }, 'Edit'),
      inv.balanceCents > 0 ? el('button', { class: 'btn sm green', onclick: () => paymentModal(inv) }, 'Record payment') : el('span'),
      el('button', { class: 'btn sm ghost', style: 'color:var(--red)', onclick: () => confirmDeleteInvoice(inv) }, 'Delete'));
  } else if (!isManual) {
    actions.append(el('span', { class: 'sub', style: 'margin:0' }, 'Synced from Invoice2go — edit it there; weekly imports keep it current.'));
  }

  const itemRows = (inv.lineItems || []).map(it => el('tr', {},
    el('td', {}, it.description || it.code || '—'),
    el('td', { class: 'num' }, String(it.qty ?? '')),
    el('td', { class: 'num' }, acctAmount(it.unitPriceCents, { colored: false })),
    el('td', { class: 'num' }, acctAmount(it.amountCents, { colored: false }))));

  // Per-payment fee view for review: the estimated Invoice2go cut (derived at the card
  // rate) and the surcharge passed to the customer (real data, from the export).
  const cardRate = i2gMap.cardRate != null ? i2gMap.cardRate : 0.029;
  const payRows = (inv.payments || []).map((p, i) => {
    const estFee = /card/i.test(p.method || '') ? Math.round((p.amountCents | 0) * cardRate) : 0;
    return el('tr', {},
      el('td', {}, p.date || '—'),
      el('td', {}, editable ? methodSelect(inv, i, p.method || '') : methodLabel(p.method)),
      el('td', { class: 'num' }, acctAmount(p.amountCents, { colored: false })),
      el('td', { class: 'num', title: 'Invoice2go card fee, estimated at ' + (cardRate * 100).toFixed(2).replace(/\.?0+$/, '') + '%' }, estFee ? acctAmount(estFee, { colored: false }) : '—'),
      el('td', { class: 'num', title: 'Surcharge passed to the customer (from Invoice2go)' }, p.feeCents ? acctAmount(p.feeCents, { colored: false }) : '—'),
      el('td', {}, el('span', { class: 'pill ' + (p.status === 'succeeded' ? 'green' : 'gray') }, p.status || '—')));
  });

  root.append(
    el('div', { class: 'crumb no-print' },
      el('a', { class: 'crumb-link', href: `#/b/${biz}/invoices` }, 'Invoices'),
      el('span', { class: 'crumb-sep' }, '›'),
      el('span', { class: 'crumb-cur' }, `Invoice #${inv.number || '—'}`)),
    back,
    el('h2', { style: 'margin-top:10px' }, `Invoice #${inv.number || '—'} `, el('span', { class: 'pill ' + st.cls, style: 'font-size:.5em;vertical-align:middle' }, st.label)),
    el('p', { class: 'sub' }, `${inv.clientName || ''}${inv.clientEmail ? ' · ' + inv.clientEmail : ''}`),
    dateBlock(inv),
    actions,
    el('div', { class: 'card', style: 'max-width:460px;margin-bottom:14px' },
      el('table', { class: 'data' },
        el('tr', {}, el('td', {}, el('b', {}, 'Revenue (invoice total)')), el('td', { class: 'num' }, el('b', {}, acctAmount(inv.totalCents, { colored: false })))),
        el('tr', {}, el('td', {}, 'Paid'), el('td', { class: 'num' }, acctAmount(inv.paidCents, { colored: false }))),
        inv.balanceCents ? el('tr', {}, el('td', {}, 'Open balance'), el('td', { class: 'num' }, acctAmount(inv.balanceCents, { colored: false }))) : null,
        el('tr', linkedExpenses.length ? { style: 'cursor:pointer', title: 'View linked expenses', onclick: () => txnListModal('Job expenses', linkedExpenses, accountsById, expenseAmt) } : {}, el('td', {}, 'Job expenses'), el('td', { class: 'num' }, acctAmount(jobExpenses, { colored: false }))),
        cardAbsorbed ? el('tr', { style: 'cursor:pointer', title: 'View entries', onclick: () => txnListModal('Card fee absorbed (COGS)', absorbedTxns, accountsById, t => lineSum(t, isAbsorbedAcct)) }, el('td', {}, 'Card fee absorbed (COGS)'), el('td', { class: 'num' }, acctAmount(cardAbsorbed, { colored: false }))) : null,
        payoutFee ? el('tr', { style: 'cursor:pointer', title: 'View entries', onclick: () => txnListModal('Payout fee', payoutTxns, accountsById, t => lineSum(t, isPayoutAcct)) }, el('td', {}, 'Payout fee'), el('td', { class: 'num' }, acctAmount(payoutFee, { colored: false }))) : null,
        el('tr', {}, el('td', {}, el('b', {}, 'Profit')), el('td', { class: 'num ' + (marginCents >= 0 ? 'pos' : 'neg') }, el('b', {}, fmtMoney(marginCents) + (marginPct != null ? ` (${marginPct}%)` : '')))),
        feePassed ? el('tr', passedTxns.length ? { style: 'color:var(--mut);cursor:pointer', title: 'View entries', onclick: () => txnListModal('Fee passed to customer', passedTxns, accountsById, t => lineSum(t, a => a && a.id === i2gMap.feePassedId)) } : { style: 'color:var(--mut)' }, el('td', {}, 'Fee passed to customer (from Invoice2go)'), el('td', { class: 'num' }, acctAmount(feePassed, { colored: false }))) : null)),
    expensesCard,
    itemRows.length ? el('div', { class: 'card', style: 'padding:0;overflow:hidden;margin-bottom:14px;max-width:640px' },
      el('table', { class: 'data xl' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Line item'), el('th', { class: 'num' }, 'Qty'), el('th', { class: 'num' }, 'Unit'), el('th', { class: 'num' }, 'Amount'))),
        el('tbody', {}, ...itemRows))) : el('span'),
    payRows.length ? el('div', { class: 'card', style: 'padding:0;overflow:hidden;max-width:640px' },
      el('table', { class: 'data xl' },
        el('thead', {},
          el('tr', {}, el('th', { colspan: '6', style: 'text-align:left' }, 'Payments')),
          el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Method'), el('th', { class: 'num' }, 'Amount'), el('th', { class: 'num' }, 'Card fee (est.)'), el('th', { class: 'num' }, 'Passed'), el('th', {}, 'Status'))),
        el('tbody', {}, ...payRows))) : el('p', { class: 'sub' }, 'No payments recorded.'),
  );
}
