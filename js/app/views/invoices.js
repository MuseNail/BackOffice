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
import { buildPaymentTxns, paymentTxnId } from '../lib/invoice2go-posting.js';
import { validateTxn } from '../lib/posting.js';
import { accountLabel } from '../lib/coa-templates.js';
import { blankInvoice, recompute, nextInvoiceNumber, addManualPayment } from '../lib/invoice-edit.js';
import { parseMoney } from '../lib/money.js';

let unsub = null;
const DEFAULT_CUTOFF = '2025-10-01';

// Display status from the money, not Invoice2go's label (so it always matches
// what we show for total/paid/open).
function statusOf(inv) {
  if (inv.balanceCents <= 0 && inv.paidCents > 0) return { key: 'paid', label: 'Paid', cls: 'green' };
  if (inv.paidCents > 0) return { key: 'partial', label: 'Partial', cls: 'amber' };
  return { key: 'open', label: 'Open', cls: 'gray' };
}

const todayIso = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

export function render(root, detail) {
  if (detail) { renderInvoiceDetail(root, detail); return; }
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
    el('div', { style: 'margin-bottom:14px' }, el('button', { class: 'btn sm', onclick: () => invoiceModal(null) }, '＋ New invoice')),
    importCard(), postCard());
  const body = el('div');
  root.append(body);
  const draw = () => drawList(body);
  unsub = subscribe(draw);
  draw();
}

export function unmount() { unsub?.(); unsub = null; }

// ── Import ──
function importCard() {
  const card = el('div', { class: 'card', style: 'max-width:640px;margin-bottom:16px' });
  const file = el('input', { type: 'file', accept: '.csv', class: 'field-input', style: 'max-width:320px' });
  const cutoff = el('input', { type: 'date', class: 'field-input', style: 'max-width:170px', value: DEFAULT_CUTOFF });
  const preview = el('div', { style: 'margin-top:10px' });
  const importBtn = el('button', { class: 'btn sm', disabled: true }, 'Import');
  let pending = null; // { invoices, newCount, updCount, payCount }

  const scan = async () => {
    pending = null; importBtn.disabled = true; clear(preview);
    const f = file.files?.[0];
    if (!f) return;
    let all;
    try { all = parseInvoices(await f.text()); }
    catch { preview.append(el('p', { class: 'sub' }, 'Could not read that file.')); return; }
    const cut = cutoff.value || DEFAULT_CUTOFF;
    // keep invoices that received a succeeded payment on/after the cutoff
    const kept = all.filter(inv => inv.payments.some(p => p.status === 'succeeded' && p.date && p.date >= cut));
    if (!kept.length) {
      preview.append(el('p', { class: 'sub' }, `No invoices with a payment on or after ${cut} found in that file (${all.length} invoices scanned).`));
      return;
    }
    const have = new Set(entities('invoice').map(i => i.id));
    let newCount = 0, payCount = 0, openCents = 0;
    for (const inv of kept) {
      if (!have.has(inv.sourceId)) newCount++;
      payCount += inv.payments.filter(p => p.status === 'succeeded' && p.date >= cut).length;
      openCents += inv.balanceCents;
    }
    pending = { invoices: kept, newCount, updCount: kept.length - newCount };
    preview.append(
      el('p', {}, el('b', {}, `${kept.length} invoices`), ` since ${cut} — `,
        el('b', {}, `${newCount} new`), `, ${kept.length - newCount} updated · ${payCount} payments · ${fmtMoney(openCents)} still open`),
      el('p', { class: 'sub', style: 'margin:2px 0 0' }, `(${all.length} total in the file; older-only invoices skipped)`),
    );
    importBtn.disabled = false;
  };

  file.addEventListener('change', scan);
  cutoff.addEventListener('change', scan);

  importBtn.addEventListener('click', () => {
    if (!pending) return;
    const now = Date.now();
    const values = pending.invoices.map(inv => ({ ...inv, id: inv.sourceId, importedAt: now, updatedAt: now }));
    for (let i = 0; i < values.length; i += 200) {
      dispatch({ op: 'entity.bulkUpsert', kind: 'invoice', values: values.slice(i, i + 200) });
    }
    toast(`Imported ${values.length} invoices (${pending.newCount} new)`);
    clear(preview).append(el('p', { class: 'sub' }, `Imported ${values.length} invoices. ${pending.newCount} new, ${pending.updCount} updated with any new payments.`));
    importBtn.disabled = true; pending = null; file.value = '';
  });

  card.append(
    el('div', { class: 'cardtitle' }, 'Import from Invoice2go'),
    el('p', { class: 'sub' }, 'Upload the invoice CSV from your Invoice2go export. Only invoices that received a payment on or after the cutoff date are imported.'),
    el('div', { style: 'display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap' },
      el('div', {}, el('label', { class: 'field-label' }, 'Invoice CSV'), file),
      el('div', {}, el('label', { class: 'field-label' }, 'Only payments since'), cutoff),
      importBtn),
    preview,
  );
  return card;
}

// ── Post payments to the ledger (P3) ──
// Cash basis through a clearing account: income credited, clearing debited, the
// processing fee expensed. The bank deposit later relieves the clearing account
// (P4 reconciliation). Idempotent — already-posted payments are skipped.
function postCard() {
  const card = el('div', { class: 'card', style: 'max-width:680px;margin-bottom:16px' });
  const draw = () => {
    const map = getState().meta?.i2gMapping || {};
    const byId = new Map(entities('account').map(a => [a.id, a]));
    const opts = (type, sel) => {
      const accts = entities('account').filter(a => a.active !== false && a.type === type)
        .sort((a, b) => accountLabel(a, byId).localeCompare(accountLabel(b, byId)));
      return el('select', { class: 'field-input', style: 'min-width:200px' },
        el('option', { value: '' }, '— select —'),
        ...accts.map(a => el('option', { value: a.id, selected: a.id === sel }, accountLabel(a, byId))));
    };
    const incomeSel = opts('income', map.incomeId);
    const clearingSel = opts('asset', map.clearingId);
    const feeSel = opts('expense', map.feeId);
    const startDate = el('input', { type: 'date', class: 'field-input', style: 'max-width:170px', value: map.startDate || DEFAULT_CUTOFF });

    // live counts for the window
    const status = el('p', { class: 'sub', style: 'margin:8px 0 0' });
    const recount = () => {
      const existing = new Set(entities('txn').map(t => t.id));
      const { eligible, skipped } = buildPaymentTxns(entities('invoice'), map, { startDate: startDate.value, existingTxnIds: existing });
      const toPost = eligible - skipped;
      status.textContent = `${eligible} payments since ${startDate.value} · ${skipped} already posted · ${toPost} to post`;
    };
    startDate.addEventListener('change', recount);

    // create the two standard accounts if they don't exist, then select them
    const ensureBtn = el('button', { class: 'linklike', onclick: () => {
      const have = entities('account');
      const mk = (name, type, qbType) => {
        let a = have.find(x => x.type === type && x.name.toLowerCase() === name.toLowerCase());
        if (!a) {
          const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
          a = { id, name, type, qbType, qbName: name, parentId: null, active: true, updatedAt: Date.now() };
          dispatch({ op: 'entity.upsert', kind: 'account', value: a });
        }
        return a;
      };
      const clr = mk('Invoice2go Clearing', 'asset', 'OCASSET');
      const fee = mk('Invoice2go Fees', 'expense', 'EXP');
      toast('Clearing + fee accounts ready');
      // redraw so the new options appear and are selected
      const m = getState().meta?.i2gMapping || {};
      dispatch({ op: 'meta.set', value: { ...getState().meta, i2gMapping: { ...m, clearingId: clr.id, feeId: fee.id } } });
      draw();
    } }, 'Create the standard clearing + fee accounts');

    const postBtn = el('button', { class: 'btn sm green', onclick: () => {
      const mapping = { incomeId: incomeSel.value, clearingId: clearingSel.value, feeId: feeSel.value, startDate: startDate.value };
      if (!mapping.incomeId || !mapping.clearingId) { toast('Pick an income and a clearing account', 'err'); return; }
      const invoices = entities('invoice');
      const existing = new Set(entities('txn').map(t => t.id));
      // a fee account is required only if some payment in the window has a fee
      const needFee = invoices.some(inv => (inv.payments || []).some(p =>
        p.status === 'succeeded' && p.txId && p.date >= mapping.startDate && (p.feeCents | 0) > 0 && !existing.has(paymentTxnId(p.txId))));
      if (needFee && !mapping.feeId) { toast('Some payments have a processing fee — pick a fee account', 'err'); return; }

      const { txns, skipped } = buildPaymentTxns(invoices, mapping, { startDate: mapping.startDate, existingTxnIds: existing });
      if (!txns.length) { if (skipped) toast('All payments in this window are already posted'); else toast('No payments to post', 'err'); return; }

      const ctx = { accountsById: new Map(entities('account').map(a => [a.id, a])), locks: new Set(entities('lock').map(l => l.id)) };
      const good = [], bad = [];
      for (const t of txns) (validateTxn(t, ctx).ok ? good : bad).push(t);
      if (!good.length) { toast('Could not post — check the accounts (and that the period isn’t locked)', 'err'); return; }

      let income = 0, fees = 0;
      for (const t of good) for (const l of t.lines) {
        if (l.accountId === mapping.incomeId) income += -l.amountCents;
        if (l.accountId === mapping.feeId) fees += l.amountCents;
      }
      dispatch({ op: 'meta.set', value: { ...getState().meta, i2gMapping: mapping } });
      for (let i = 0; i < good.length; i += 200) {
        dispatch({ op: 'entity.bulkUpsert', kind: 'txn', values: good.slice(i, i + 200) });
      }
      toast(`Posted ${good.length} payments — ${fmtMoney(income)} income, ${fmtMoney(fees)} fees${bad.length ? ` · ${bad.length} skipped` : ''}`);
      recount();
    } }, 'Post payments to the ledger');

    const field = (label, node) => el('div', {}, el('label', { class: 'field-label' }, label), node);
    clear(card).append(
      el('div', { class: 'cardtitle' }, 'Post payments to the ledger'),
      el('p', { class: 'sub' }, 'Each payment posts as income through a clearing account; processing fees are booked as an expense. Your bank deposits later clear this account (reconciliation). Already-posted payments are skipped, so this is safe to re-run after each weekly import.'),
      el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end' },
        field('Income account', incomeSel), field('Clearing account', clearingSel), field('Fee account', feeSel), field('Post payments since', startDate)),
      el('div', { style: 'margin-top:6px' }, ensureBtn),
      el('div', { style: 'margin-top:10px' }, postBtn),
      status,
    );
    recount();
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

function confirmDeleteInvoice(inv) {
  const posted = (inv.payments || []).some(p => entities('txn').some(t => t.id === paymentTxnId(p.txId)));
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

  // AR aging on open balances, by days since invoice date
  const buckets = [['Current', 0, 0], ['1–30', 1, 30], ['31–60', 31, 60], ['61–90', 61, 90], ['90+', 91, Infinity]];
  const aging = buckets.map(() => 0);
  const t = todayIso();
  for (const inv of invoices) {
    if (inv.balanceCents <= 0 || !inv.date) continue;
    const age = daysBetween(inv.date, t);
    const bi = age <= 0 ? 0 : buckets.findIndex(([, lo, hi]) => age >= lo && age <= hi);
    aging[bi < 0 ? 0 : bi] += inv.balanceCents;
  }

  const kpi = (label, val, cls) => el('div', { class: 'card', style: 'flex:1;min-width:150px;padding:12px 16px' },
    el('div', { class: 'sub', style: 'margin:0' }, label),
    el('div', { style: `font-size:1.4em;font-weight:800;${cls || ''}` }, val));

  const rows = invoices.map(inv => {
    const st = statusOf(inv);
    return el('tr', {},
      el('td', {}, el('a', { class: 'linklike', style: 'font-weight:700', href: `#/b/${biz}/invoices/${inv.id}` }, '#' + (inv.number || '—'))),
      el('td', {}, inv.date || '—'),
      el('td', {}, inv.clientName || '—'),
      el('td', { class: 'num' }, fmtMoney(inv.totalCents)),
      el('td', { class: 'num' }, fmtMoney(inv.paidCents)),
      el('td', { class: 'num ' + (inv.balanceCents > 0 ? 'neg' : '') }, fmtMoney(inv.balanceCents)),
      el('td', {}, el('span', { class: 'pill ' + st.cls }, st.label)),
    );
  });

  clear(body).append(
    el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px' },
      kpi('Open balance', fmtMoney(totalOpen), 'color:var(--red)'),
      kpi('Open invoices', String(openCount)),
      kpi('Collected', fmtMoney(totalPaid), 'color:var(--green,#2a8)'),
      kpi('Invoices', String(invoices.length)),
    ),
    el('div', { class: 'card', style: 'padding:0;overflow:hidden;margin-bottom:14px;max-width:640px' },
      el('table', { class: 'data' },
        el('tr', {}, el('th', { colspan: '5', style: 'text-align:left' }, 'A/R aging — open balances')),
        el('tr', {}, ...buckets.map(([l]) => el('th', { class: 'num' }, l))),
        el('tr', {}, ...aging.map(c => el('td', { class: 'num' + (c > 0 ? ' neg' : '') }, fmtMoney(c)))))),
    el('div', { class: 'card', style: 'padding:0;overflow:hidden' },
      el('table', { class: 'data' },
        el('tr', {}, el('th', {}, 'Invoice'), el('th', {}, 'Date'), el('th', {}, 'Client'),
          el('th', { class: 'num' }, 'Total'), el('th', { class: 'num' }, 'Paid'), el('th', { class: 'num' }, 'Open'), el('th', {}, 'Status')),
        ...rows)),
  );
}

// ── Drill-down ──
function renderInvoiceDetail(root, id) {
  const biz = getActiveBiz();
  const inv = entities('invoice').find(i => i.id === id);
  const back = el('a', { class: 'btn sm ghost', href: `#/b/${biz}/invoices` }, '← Invoices');
  if (!inv) { root.append(el('p', { class: 'sub' }, 'That invoice is no longer here.'), back); return; }
  const st = statusOf(inv);
  const editable = canEdit(biz);
  const isManual = inv.source?.app === 'manual';

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

  const payRows = (inv.payments || []).map(p => el('tr', {},
    el('td', {}, p.date || '—'),
    el('td', {}, (p.method || '').replace(/_/g, ' ')),
    el('td', { class: 'num' }, fmtMoney(p.amountCents)),
    el('td', { class: 'num' }, p.feeCents ? fmtMoney(p.feeCents) : '—'),
    el('td', {}, el('span', { class: 'pill ' + (p.status === 'succeeded' ? 'green' : 'gray') }, p.status || '—'))));

  root.append(
    back,
    el('h2', { style: 'margin-top:10px' }, `Invoice #${inv.number || '—'} `, el('span', { class: 'pill ' + st.cls, style: 'font-size:.5em;vertical-align:middle' }, st.label)),
    el('p', { class: 'sub' }, `${inv.clientName || ''}${inv.clientEmail ? ' · ' + inv.clientEmail : ''} · ${inv.date || ''}`),
    actions,
    el('div', { class: 'card', style: 'max-width:420px;margin-bottom:14px' },
      el('table', { class: 'data' },
        el('tr', {}, el('td', {}, 'Total'), el('td', { class: 'num' }, fmtMoney(inv.totalCents))),
        el('tr', {}, el('td', {}, 'Paid'), el('td', { class: 'num' }, fmtMoney(inv.paidCents))),
        el('tr', {}, el('td', {}, el('b', {}, 'Open balance')), el('td', { class: 'num' }, el('b', {}, fmtMoney(inv.balanceCents)))))),
    itemRows.length ? el('div', { class: 'card', style: 'padding:0;overflow:hidden;margin-bottom:14px;max-width:640px' },
      el('table', { class: 'data' },
        el('tr', {}, el('th', {}, 'Line item'), el('th', { class: 'num' }, 'Qty'), el('th', { class: 'num' }, 'Unit'), el('th', { class: 'num' }, 'Amount')),
        ...itemRows)) : el('span'),
    payRows.length ? el('div', { class: 'card', style: 'padding:0;overflow:hidden;max-width:640px' },
      el('table', { class: 'data' },
        el('tr', {}, el('th', { colspan: '5', style: 'text-align:left' }, 'Payments')),
        el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Method'), el('th', { class: 'num' }, 'Amount'), el('th', { class: 'num' }, 'Fee'), el('th', {}, 'Status')),
        ...payRows)) : el('p', { class: 'sub' }, 'No payments recorded.'),
  );
}
