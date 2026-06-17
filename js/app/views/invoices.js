// ── view: invoices — Invoice2go import + accounts-receivable tracking ──────────
// Phase 2 of the AR module: import the weekly Invoice2go CSV (deduped by stable
// id), then list invoices with running open balances + aging. Posting payments
// to the ledger and bank reconciliation are later phases — this view tracks, it
// does not post.
import { el, clear, toast, fmtMoney, modal } from '../ui.js';
import { entities, subscribe, getState, usesInvoices } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { parseInvoices } from '../lib/invoice2go.js';
import { buildCashflowImport, cashflowPaymentTxnId, parseBundleInvoices } from '../lib/i2g-cashflow.js';
import { reconcilePayouts } from '../lib/i2g-reconcile.js';
import { validateTxn, invoiceExpensesTotal, simpleTxn } from '../lib/posting.js';
import { accountLabel } from '../lib/coa-templates.js';
import { blankInvoice, recompute, nextInvoiceNumber, addManualPayment } from '../lib/invoice-edit.js';
import { parseMoney } from '../lib/money.js';

let unsub = null;

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

const todayIso = () => new Date().toISOString().slice(0, 10);
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

export function render(root, detail) {
  if (detail === 'reconcile') { renderReconcile(root); return; }
  if (detail) { renderInvoiceDetail(root, detail); return; }
  agingFilter = null;
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
  if (editable) root.append(
    el('div', { style: 'margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap' },
      el('button', { class: 'btn sm', onclick: () => invoiceModal(null) }, '＋ New invoice'),
      el('button', { class: 'btn sm', onclick: () => { location.hash = `#/b/${getActiveBiz()}/invoices/reconcile`; } }, 'Reconcile to bank →')),
    postCard(), importCard());
  const body = el('div');
  root.append(body);
  const draw = () => drawList(body);
  unsub = subscribe(draw);
  draw();
}

export function unmount() { unsub?.(); unsub = null; }

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

function mergeCsvInvoice(c, resolve, now) {
  const ex = resolve(c.sourceId, c.number);
  const hasLines = Array.isArray(c.lineItems) && c.lineItems.length > 0;
  if (!ex) return { ...c, id: c.sourceId, importedAt: now, updatedAt: now }; // CSV-first: full create
  if (ex.source?.app === 'manual') return null;
  const bundleOwnsMoney = ex.source?.app === 'invoice2go-api';
  return {
    ...ex, id: ex.id,
    lineItems: hasLines ? c.lineItems : ex.lineItems,
    subtotalCents: hasLines ? c.subtotalCents : ex.subtotalCents,
    taxCents: hasLines ? c.taxCents : ex.taxCents,
    clientName: ex.clientName || c.clientName, clientEmail: ex.clientEmail || c.clientEmail,
    date: ex.date || c.date, number: ex.number || c.number,
    ...(bundleOwnsMoney ? {} : { totalCents: c.totalCents, paidCents: c.paidCents, balanceCents: c.balanceCents, docStatus: c.docStatus }),
    source: ex.source, updatedAt: now, // keep the ownership marker
  };
}

// ── Add line-item detail (Invoice2go CSV) ──
// The one-click JSON brings every invoice and its money but no line items (the
// list API omits them). This optional card layers line-item detail onto invoices
// you already have — matched by number/id — and only ever fills line items.
function importCard() {
  const card = el('div', { class: 'card', style: 'max-width:640px;margin-bottom:16px' });
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
    let matched = 0, created = 0, withLines = 0;
    for (const inv of all) {
      if (resolve(inv.sourceId, inv.number)) matched++; else created++;
      if (inv.lineItems?.length) withLines++;
    }
    pending = { invoices: all };
    preview.append(
      el('p', {}, el('b', {}, `${all.length} invoices in the file`), ' — ',
        el('b', {}, `${matched} matched`), ` (line items added), ${created} not yet in Back Office`),
      el('p', { class: 'sub', style: 'margin:2px 0 0' }, `${withLines} have line-item detail · money is never changed here`),
    );
    importBtn.disabled = false;
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

  card.append(
    el('div', { class: 'cardtitle' }, 'Add line-item detail (Invoice2go CSV)'),
    el('p', { class: 'sub' }, 'Optional. The one-click import brings every invoice and its money, but not the itemized lines. Upload the Invoice2go invoice CSV whenever you like (monthly or quarterly is fine) to fill in line items on the invoices you already have — matched by number. It only adds line items; it never changes totals or payments.'),
    el('div', { style: 'display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap' },
      el('div', {}, el('label', { class: 'field-label' }, 'Invoice CSV'), file),
      importBtn),
    preview,
  );
  return card;
}

// ── Post the Invoice2go cashflow (payments + payouts) to the ledger ──
// Uploads the Invoice2go "banking/adyen/transactions" export, which carries the
// REAL fees, nets, and payouts — so income, the passed/absorbed fee split, and the
// 1% instant-payout fee are exact (no estimation). Each payment's net lands in the
// clearing account; bank deposits relieve it (when clearing nets to $0, every
// payment is matched to a deposit). Idempotent — already-posted entries are skipped.
function postCard() {
  const card = el('div', { class: 'card', style: 'max-width:680px;margin-bottom:16px' });
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
    clear(card).append(
      el('div', { class: 'cardtitle' }, 'Import from Invoice2go (one file)'),
      el('p', { class: 'sub' }, 'Upload the one-click Invoice2go export (invoice2go-export.json) — it brings in every invoice plus the real cashflow in one step. Each payment posts with its actual fees: the part you absorbed to COGS, the part the customer covered as contra-income, plus the 1% instant-payout fees, all tagged to their invoice. Income lands net in the clearing account; your bank deposits relieve it. Safe to re-run weekly — nothing duplicates.'),
      el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end' },
        field('Income account', incomeSel), field('Clearing account', clearingSel),
        field('Fees passed (income)', feePassedSel), field('Fees absorbed (COGS)', feeAbsorbedSel), field('Payout fee (expense)', payoutSel)),
      el('div', { style: 'margin-top:6px' }, ensureBtn),
      el('div', { style: 'display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-top:10px' },
        field('Start date (skip anything QuickBooks already has)', cutoffInput),
        el('div', { style: 'display:flex;gap:10px;align-items:center' }, file, importBtn)),
      preview,
    );
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
    const qty = fi(li.qty, 'Qty', { inputmode: 'decimal', style: 'width:64px' });
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
    ...['manual_payment', 'cash', 'check', 'bank_transfer', 'credit_card', 'other'].map(v =>
      el('option', { value: v }, v.replace(/_/g, ' '))));
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
function drawList(body) {
  const biz = getActiveBiz();
  const invoices = entities('invoice').slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (!invoices.length) {
    clear(body).append(el('p', { class: 'sub' }, 'No invoices yet. Import an Invoice2go CSV above to get started.'));
    return;
  }
  const totalOpen = invoices.reduce((s, i) => s + i.balanceCents, 0);
  const totalPaid = invoices.reduce((s, i) => s + i.paidCents, 0);
  const openCount = invoices.filter(i => i.balanceCents > 0).length;

  // AR aging on open balances, by days since invoice date.
  const t = todayIso();
  const aging = AGING_BUCKETS.map(() => 0);
  for (const inv of invoices) { const bi = bucketOf(inv, t); if (bi >= 0) aging[bi] += inv.balanceCents; }

  const kpi = (label, val, cls) => el('div', { class: 'card', style: 'flex:1;min-width:150px;padding:12px 16px' },
    el('div', { class: 'sub', style: 'margin:0' }, label),
    el('div', { style: `font-size:1.4em;font-weight:800;${cls || ''}` }, val));

  // Aging chips: tap one to filter the list to that bucket's open invoices.
  const chip = (label, cls, idx, amount) => {
    const on = agingFilter === idx;
    const c = el('button', {
      class: 'pill ' + cls,
      style: 'cursor:pointer;border:1.5px solid transparent;' + (on ? 'box-shadow:0 0 0 2px var(--brand) inset' : ''),
      onclick: () => { agingFilter = on ? null : idx; drawList(body); },
    }, amount != null ? `${label} · ${fmtMoney(amount)}` : label);
    return c;
  };
  const agingChips = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px' },
    el('span', { class: 'sub', style: 'margin:0 4px 0 0;font-weight:700' }, 'A/R aging'),
    chip('All open', 'gray', null),
    ...AGING_BUCKETS.map(([l], i) => chip(l, aging[i] > 0 ? 'amber' : 'gray', i, aging[i])));

  const shown = agingFilter == null ? invoices : invoices.filter(inv => bucketOf(inv, t) === agingFilter);
  const rows = shown.map(inv => {
    const st = statusOf(inv);
    const src = sourceOf(inv);
    const tr = el('tr', { style: 'cursor:pointer' },
      el('td', {}, el('span', { style: 'font-weight:700;color:var(--brand)' }, '#' + (inv.number || '—'))),
      el('td', {}, inv.date || '—'),
      el('td', {}, inv.clientName || '—'),
      el('td', {}, el('span', { class: 'pill ' + src.cls }, src.label)),
      el('td', { class: 'num' }, fmtMoney(inv.totalCents)),
      el('td', { class: 'num' }, fmtMoney(inv.paidCents)),
      el('td', { class: 'num ' + (inv.balanceCents > 0 ? 'neg' : '') }, fmtMoney(inv.balanceCents)),
      el('td', {}, el('span', { class: 'pill ' + st.cls }, st.label)),
    );
    tr.addEventListener('click', () => { location.hash = `#/b/${biz}/invoices/${inv.id}`; });
    return tr;
  });

  clear(body).append(
    el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px' },
      kpi('Open balance', fmtMoney(totalOpen), 'color:var(--red)'),
      kpi('Open invoices', String(openCount)),
      kpi('Collected', fmtMoney(totalPaid), 'color:var(--green,#2a8)'),
      kpi('Invoices', String(invoices.length)),
    ),
    agingChips,
    el('div', { class: 'card', style: 'padding:0;overflow:hidden' },
      el('table', { class: 'data' },
        el('tr', {}, el('th', {}, 'Invoice'), el('th', {}, 'Invoice date'), el('th', {}, 'Client'), el('th', {}, 'Source'),
          el('th', { class: 'num' }, 'Total'), el('th', { class: 'num' }, 'Paid'), el('th', { class: 'num' }, 'Open'), el('th', {}, 'Status')),
        ...rows)),
    agingFilter != null && !rows.length ? el('p', { class: 'sub', style: 'margin:12px 0 0' }, 'No open invoices in this aging bucket.') : null,
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
    el('table', { class: 'data' },
      el('tr', {}, el('th', {}, 'Account'), el('th', { class: 'num' }, 'Debit'), el('th', { class: 'num' }, 'Credit')),
      ...(t.lines || []).map(l => {
        const a = accountsById.get(l.accountId);
        return el('tr', {},
          el('td', {}, a ? accountLabel(a, accountsById) : l.accountId),
          el('td', { class: 'num' }, l.amountCents > 0 ? fmtMoney(l.amountCents) : ''),
          el('td', { class: 'num' }, l.amountCents < 0 ? fmtMoney(-l.amountCents) : ''));
      })),
    el('div', { style: 'display:flex;justify-content:flex-end;margin-top:12px' }, el('button', { class: 'btn', onclick: m.close }, 'Close')));
}

// Drill-down: the transactions behind a profit-panel line (a fee or job-cost total).
function txnListModal(title, txns, accountsById, amountFor) {
  const m = modal(title);
  m.body.append(txns.length
    ? el('table', { class: 'data' },
        el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Payee'), el('th', { class: 'num' }, 'Amount'), el('th', {}, '')),
        ...txns.map(t => el('tr', {},
          el('td', {}, t.date || '—'),
          el('td', {}, t.payee || '—'),
          el('td', { class: 'num' }, fmtMoney(amountFor ? amountFor(t) : 0)),
          el('td', {}, el('button', { class: 'linklike', onclick: () => txnDetailModal(t, accountsById) }, 'View')))))
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

function reconTable(title, headers, rows, note) {
  const isNum = (h) => /amount/i.test(h);
  return el('div', { style: 'margin-bottom:16px' },
    title ? el('div', { class: 'cardtitle', style: 'margin-bottom:6px' }, title) : null,
    rows.length
      ? el('div', { class: 'card', style: 'padding:0;overflow:hidden;max-width:880px' },
          el('table', { class: 'data' },
            el('tr', {}, ...headers.map(h => el('th', { class: isNum(h) ? 'num' : '' }, h))),
            ...rows.map(r => el('tr', {}, ...r.map((c, i) => el('td', { class: isNum(headers[i]) ? 'num' : '' }, c))))))
      : el('p', { class: 'sub' }, 'None — all clear. 🎉'),
    note ? el('p', { class: 'sub', style: 'max-width:880px;margin-top:4px' }, note) : null);
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

  const draw = () => {
    const bank = banks.find(b => b.id === bankId), acct = bank.accountId;
    // Scope to the app-owned period (Invoice2go start date) — earlier deposits belong to
    // QuickBooks (already reconciled) and would just be noise in this Invoice2go view.
    const cutoff = getState().meta?.i2gCutoff || '2026-03-01';
    // deposits = money IN on this bank, on/after the cutoff: posted txns + newly imported (staged) rows
    const posted = entities('txn').filter(t => t.status === 'posted' && !/^(i2gc-|i2gpo-)/.test(t.id) && (t.date || '') >= cutoff)
      .map(t => ({ id: t.id, date: t.date, amountCents: (t.lines || []).reduce((s, l) => s + (l.accountId === acct ? l.amountCents : 0), 0), kind: 'posted', payee: t.payee || '—' }))
      .filter(d => d.amountCents > 0);
    const staged = entities('staged').filter(s => s.bankacctId === bankId && s.status === 'pending' && (s.amountCents || 0) > 0 && (s.date || '') >= cutoff)
      .map(s => ({ id: s.id, date: s.date, amountCents: s.amountCents, kind: 'new', payee: s.desc || '—' }));
    const deposits = [...posted, ...staged];
    const payouts = entities('i2gpayout');
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

    clear(body).append(
      el('div', { class: 'row', style: 'margin-bottom:14px' },
        kpiCard('Payouts matched', `${matches.length} / ${payouts.length}`, fmtMoney(matches.reduce((s, m) => s + m.payout.netToBankCents, 0))),
        kpiCard('Payouts not matched', String(unmatchedPayouts.length), fmtMoney(sumP(unmatchedPayouts)) + ' — investigate'),
        kpiCard('Deposits not Invoice2go', String(unmatchedDeposits.length), fmtMoney(sumD(unmatchedDeposits)) + ' — other income')),
      el('div', { style: 'display:flex;gap:14px;align-items:center;margin-bottom:16px;flex-wrap:wrap' },
        el('button', { class: 'btn green', disabled: !toPost.length || !clearingId, onclick: postMatches }, toPost.length ? `Post ${toPost.length} matched deposits → ${clearingName}` : 'All matched deposits posted ✓'),
        el('span', { class: 'sub' }, `${clearingName} balance: `, el('b', {}, fmtMoney(clearingBal)), ' — drains toward $0 as matches post')),
      reconTable('⚠️ Invoice2go payouts with no matching bank deposit', ['Payout date', 'Amount', 'Method'],
        unmatchedPayouts.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(p => [p.date, fmtMoney(p.netToBankCents), payoutMethodLabel(p.method)]),
        'These need either the bank statement for that period imported, or a manual match (coming next). Each should eventually tie to a real deposit.'),
      reconTable('⚠️ Bank deposits that aren’t Invoice2go (other income)', ['Deposit date', 'Amount', 'Source', 'Description'],
        unmatchedDeposits.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 200).map(d => [d.date, fmtMoney(d.amountCents), d.kind === 'new' ? 'new import' : 'on file', d.payee]),
        `Deposits not explained by an Invoice2go payout — your other income, to categorize as usual.${unmatchedDeposits.length > 200 ? ' (showing the first 200)' : ''}`),
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
    el('td', {}, t.payee || '—'),
    el('td', { class: 'num' }, fmtMoney(expenseAmt(t))),
    el('td', {}, editable ? el('button', { class: 'linklike', onclick: (e) => { e.stopPropagation(); dispatch({ op: 'entity.upsert', kind: 'txn', value: { ...t, invoiceId: undefined } }); toast('Unlinked'); } }, 'Unlink') : '')));
  const expensesCard = (editable || linkedExpenses.length)
    ? el('div', { class: 'card', style: 'max-width:640px;margin-bottom:14px' },
        el('div', { class: 'cardtitle' }, 'Linked expenses'),
        linkedExpenses.length
          ? el('table', { class: 'data' },
              el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Payee'), el('th', { class: 'num' }, 'Expense'), el('th', {}, '')),
              ...expenseRows)
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
    el('td', { class: 'num' }, fmtMoney(it.unitPriceCents)),
    el('td', { class: 'num' }, fmtMoney(it.amountCents))));

  // Per-payment fee view for review: the estimated Invoice2go cut (derived at the card
  // rate) and the surcharge passed to the customer (real data, from the export).
  const cardRate = i2gMap.cardRate != null ? i2gMap.cardRate : 0.029;
  const payRows = (inv.payments || []).map(p => {
    const estFee = /card/i.test(p.method || '') ? Math.round((p.amountCents | 0) * cardRate) : 0;
    return el('tr', {},
      el('td', {}, p.date || '—'),
      el('td', {}, (p.method || '').replace(/_/g, ' ')),
      el('td', { class: 'num' }, fmtMoney(p.amountCents)),
      el('td', { class: 'num', title: 'Invoice2go card fee, estimated at ' + (cardRate * 100).toFixed(2).replace(/\.?0+$/, '') + '%' }, estFee ? fmtMoney(estFee) : '—'),
      el('td', { class: 'num', title: 'Surcharge passed to the customer (from Invoice2go)' }, p.feeCents ? fmtMoney(p.feeCents) : '—'),
      el('td', {}, el('span', { class: 'pill ' + (p.status === 'succeeded' ? 'green' : 'gray') }, p.status || '—')));
  });

  root.append(
    back,
    el('h2', { style: 'margin-top:10px' }, `Invoice #${inv.number || '—'} `, el('span', { class: 'pill ' + st.cls, style: 'font-size:.5em;vertical-align:middle' }, st.label)),
    el('p', { class: 'sub' }, `${inv.clientName || ''}${inv.clientEmail ? ' · ' + inv.clientEmail : ''}`),
    dateBlock(inv),
    actions,
    el('div', { class: 'card', style: 'max-width:460px;margin-bottom:14px' },
      el('table', { class: 'data' },
        el('tr', {}, el('td', {}, el('b', {}, 'Revenue (invoice total)')), el('td', { class: 'num' }, el('b', {}, fmtMoney(inv.totalCents)))),
        el('tr', {}, el('td', {}, 'Paid'), el('td', { class: 'num' }, fmtMoney(inv.paidCents))),
        inv.balanceCents ? el('tr', {}, el('td', {}, 'Open balance'), el('td', { class: 'num' }, fmtMoney(inv.balanceCents))) : null,
        el('tr', linkedExpenses.length ? { style: 'cursor:pointer', title: 'View linked expenses', onclick: () => txnListModal('Job expenses', linkedExpenses, accountsById, expenseAmt) } : {}, el('td', {}, 'Job expenses'), el('td', { class: 'num' }, fmtMoney(jobExpenses))),
        cardAbsorbed ? el('tr', { style: 'cursor:pointer', title: 'View entries', onclick: () => txnListModal('Card fee absorbed (COGS)', absorbedTxns, accountsById, t => lineSum(t, isAbsorbedAcct)) }, el('td', {}, 'Card fee absorbed (COGS)'), el('td', { class: 'num' }, fmtMoney(cardAbsorbed))) : null,
        payoutFee ? el('tr', { style: 'cursor:pointer', title: 'View entries', onclick: () => txnListModal('Payout fee', payoutTxns, accountsById, t => lineSum(t, isPayoutAcct)) }, el('td', {}, 'Payout fee'), el('td', { class: 'num' }, fmtMoney(payoutFee))) : null,
        el('tr', {}, el('td', {}, el('b', {}, 'Profit')), el('td', { class: 'num ' + (marginCents >= 0 ? 'pos' : 'neg') }, el('b', {}, fmtMoney(marginCents) + (marginPct != null ? ` (${marginPct}%)` : '')))),
        feePassed ? el('tr', passedTxns.length ? { style: 'color:var(--mut);cursor:pointer', title: 'View entries', onclick: () => txnListModal('Fee passed to customer', passedTxns, accountsById, t => lineSum(t, a => a && a.id === i2gMap.feePassedId)) } : { style: 'color:var(--mut)' }, el('td', {}, 'Fee passed to customer (from Invoice2go)'), el('td', { class: 'num' }, fmtMoney(feePassed))) : null)),
    expensesCard,
    itemRows.length ? el('div', { class: 'card', style: 'padding:0;overflow:hidden;margin-bottom:14px;max-width:640px' },
      el('table', { class: 'data' },
        el('tr', {}, el('th', {}, 'Line item'), el('th', { class: 'num' }, 'Qty'), el('th', { class: 'num' }, 'Unit'), el('th', { class: 'num' }, 'Amount')),
        ...itemRows)) : el('span'),
    payRows.length ? el('div', { class: 'card', style: 'padding:0;overflow:hidden;max-width:640px' },
      el('table', { class: 'data' },
        el('tr', {}, el('th', { colspan: '6', style: 'text-align:left' }, 'Payments')),
        el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Method'), el('th', { class: 'num' }, 'Amount'), el('th', { class: 'num' }, 'Card fee (est.)'), el('th', { class: 'num' }, 'Passed'), el('th', {}, 'Status')),
        ...payRows)) : el('p', { class: 'sub' }, 'No payments recorded.'),
  );
}
