// ── view: customers — client directory + per-customer register ─────────────────
// Mirrors Vendors, but for the income side: your clients. Income transactions are
// tagged to a customer (t.customerId) the way expenses are tagged to a vendor.
import { el, clear, toast, modal, fmtMoney, sortTh, sortBy } from '../ui.js';
import { entities, subscribe } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { renderRegister } from '../register.js';
import { dateRangeControl, inRange } from '../daterange.js';
import { openMergeModal, mergeCustomer } from '../merge.js';

let unsub = null;
let customerRange = { from: null, to: null };
let customerQuery = '';
let customerSort = { key: 'customer', dir: 'asc' };   // default: alphabetical; headers re-sort
let pageRangeCtl = null;   // the page "Totals for" picker — kept in sync with the drilldown's
const slug = (s) => 'c-' + String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export const txnsForCustomer = (c) => entities('txn').filter(t => t.status === 'posted' && t.customerId === c.id);

export function render(root, detail) {
  const openNew = detail === 'new';
  if (openNew) detail = null;
  if (detail) { renderCustomerRegister(root, detail); return; }
  const editable = canEdit(getActiveBiz());
  const body = el('div');
  const draw = () => drawTable(body, editable);
  const search = el('input', { class: 'field-input', type: 'search', placeholder: 'Search customers…', style: 'max-width:240px;margin:0', value: customerQuery, oninput: (e) => { customerQuery = e.target.value; draw(); } });
  pageRangeCtl = dateRangeControl({ initial: 'year', onChange: (r) => { customerRange = r; draw(); } });
  customerRange = pageRangeCtl.getRange();
  root.append(
    el('h2', {}, 'Customers'),
    el('p', { class: 'sub' }, 'Your clients. Click a customer to see their transactions and total received. Income is tagged to a customer the same way expenses are tagged to a vendor.'),
    el('div', { class: 'sticky-toolbar' },
      editable ? el('button', { class: 'btn sm', onclick: () => customerModal(null) }, '＋ New customer') : el('span'),
      search,
      el('span', { class: 'sub', style: 'margin:0' }, 'Totals for'), pageRangeCtl.el),
    body);
  unsub = subscribe(draw);
  draw();
  if (openNew && editable) customerModal(null);
}

export function unmount() { unsub?.(); unsub = null; pageRangeCtl = null; customerQuery = ''; }

// Per-customer register (drill-down) — reached via #/b/<biz>/customers/<id>.
function renderCustomerRegister(root, id) {
  const biz = getActiveBiz();
  const c = entities('customer').find(x => x.id === id);
  if (!c) {
    root.append(el('p', { class: 'sub' }, 'That customer no longer exists.'),
      el('a', { class: 'btn sm ghost', href: `#/b/${biz}/customers` }, '← Back to customers'));
    return;
  }
  unsub = renderRegister({
    root, title: c.name, subtitle: 'Customer transactions',
    backHash: `/b/${biz}/customers`, backLabel: 'Customers',
    filename: `${biz}-${slug(c.name)}-transactions.csv`,
    getTxns: () => txnsForCustomer(c),
  });
}

function drawTable(body, editable) {
  const all = entities('customer');
  if (!all.length) {
    clear(body).append(el('p', { class: 'sub' }, 'No customers yet. Add one here, or they’ll appear once income transactions are tagged to a customer.'));
    return;
  }
  const q = customerQuery.trim().toLowerCase();
  const customers = q ? all.filter(c => (c.name || '').toLowerCase().includes(q)) : all.slice();
  if (!customers.length) {
    clear(body).append(el('p', { class: 'sub' }, 'No customers match your search.'));
    return;
  }
  const incomeIds = new Set(entities('account').filter(a => a.type === 'income').map(a => a.id));
  const incomeOf = (t) => (t.lines || []).reduce((a, l) => a + (incomeIds.has(l.accountId) ? -l.amountCents : 0), 0);
  const rows = sortBy(
    customers.map(c => { const tx = txnsForCustomer(c).filter(t => inRange(t.date, customerRange)); return { c, n: tx.length, total: tx.reduce((s, t) => s + incomeOf(t), 0) }; }),
    customerSort, { customer: r => r.c.name, txns: r => r.n, total: r => r.total });
  const redraw = () => drawTable(body, editable);
  const tbl = el('table', { class: 'data' },
    el('tr', {},
      sortTh(customerSort, 'customer', 'Customer', redraw),
      sortTh(customerSort, 'txns', 'Transactions', redraw, { numeric: true, cls: 'num' }),
      sortTh(customerSort, 'total', 'Total received', redraw, { numeric: true, cls: 'num' })),
    ...rows.map(({ c, n, total }) => el('tr', { style: 'cursor:pointer', title: 'View transactions / edit', onclick: () => customerDrilldown(c, () => drawTable(body, editable)) },
      el('td', {}, el('b', {}, c.name)),
      el('td', { class: 'num' }, String(n)),
      el('td', { class: 'num' }, fmtMoney(total)))));
  clear(body).append(el('div', { class: 'card', style: 'padding:0;overflow:hidden;max-width:760px' }, tbl));
}

// Click a customer → popup with their transactions + total, and Edit/Delete (Esc closes).
// Carries its own date-range picker so the totals can be re-scoped without closing it.
function customerDrilldown(c, refresh) {
  const m = modal(c.name);
  const accts = new Map(entities('account').map(a => [a.id, a]));
  const incomeIds = new Set([...accts.values()].filter(a => a.type === 'income').map(a => a.id));
  const incomeOf = (t) => (t.lines || []).reduce((a, l) => a + (incomeIds.has(l.accountId) ? -l.amountCents : 0), 0);
  const catOf = (t) => { const l = (t.lines || []).find(x => incomeIds.has(x.accountId)); const a = l && accts.get(l.accountId); return a ? a.name : '—'; };

  const listHost = el('div');
  const txnSort = { key: 'date', dir: 'desc' };
  const drawList = () => {
    const txns = sortBy(txnsForCustomer(c).filter(t => inRange(t.date, customerRange)), txnSort,
      { date: t => t.date, desc: t => t.payee || t.memo || '', account: t => catOf(t), amount: t => incomeOf(t) });
    const total = txns.reduce((s, t) => s + incomeOf(t), 0);
    clear(listHost).append(
      el('div', { style: 'font-weight:800;font-size:18px;margin:2px 0 10px' }, fmtMoney(total), el('span', { class: 'sub', style: 'font-weight:400;margin-left:8px' }, `received · ${txns.length} transactions`)),
      txns.length ? el('div', { class: 'card', style: 'padding:0;overflow:auto;max-height:50vh;margin:0' },
        el('table', { class: 'data' },
          el('tr', {}, sortTh(txnSort, 'date', 'Date', drawList), sortTh(txnSort, 'desc', 'Description', drawList), sortTh(txnSort, 'account', 'Account', drawList), sortTh(txnSort, 'amount', 'Amount', drawList, { numeric: true, cls: 'num' })),
          ...txns.map(t => el('tr', {}, el('td', {}, t.date), el('td', {}, t.payee || t.memo || '—'), el('td', {}, catOf(t)), el('td', { class: 'num' }, fmtMoney(Math.abs(incomeOf(t))))))))
        : el('p', { class: 'sub' }, 'No transactions yet.'));
  };
  const rangeCtl = dateRangeControl({ initial: 'year', onChange: (r) => { customerRange = r; pageRangeCtl?.setRange(r); drawList(); refresh?.(); } });
  rangeCtl.setRange(customerRange);

  m.body.append(
    c.email ? el('p', { class: 'sub', style: 'margin-top:0' }, c.email) : el('span'),
    el('div', { style: 'display:flex;gap:8px;align-items:center;margin:6px 0' }, el('span', { class: 'sub', style: 'margin:0' }, 'Totals for'), rangeCtl.el),
    listHost,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap' },
      el('button', { class: 'btn ghost', style: 'color:var(--red)', onclick: () => { m.close(); confirmDelete(c); } }, 'Delete'),
      el('button', { class: 'btn ghost', onclick: () => { m.close(); openMergeModal({ title: 'customer', source: c, candidates: entities('customer'), labelOf: (x) => x.name, run: mergeCustomer, onDone: refresh }); } }, 'Merge…'),
      el('button', { class: 'btn', onclick: () => { m.close(); customerModal(c); } }, 'Edit'),
      el('button', { class: 'btn ghost', onclick: m.close }, 'Close')));
  drawList();
}

function customerModal(existing) {
  const m = modal(existing ? 'Edit customer' : 'New customer');
  const name = el('input', { class: 'field-input', value: existing?.name || '', placeholder: 'Customer name' });
  const email = el('input', { class: 'field-input', value: existing?.email || '', placeholder: 'Email (optional)' });
  m.body.append(
    el('label', { class: 'field-label' }, 'Name'), name,
    el('label', { class: 'field-label' }, 'Email'), email,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: () => {
        const n = name.value.trim();
        if (!n) { toast('Name the customer', 'err'); return; }
        let id = existing?.id;
        if (!id) { const taken = new Set(entities('customer').map(c => c.id)); const base = slug(n) || 'c-customer'; id = base; let i = 2; while (taken.has(id)) id = `${base}-${i++}`; }
        dispatch({ op: 'entity.upsert', kind: 'customer', value: { ...(existing || {}), id, name: n, email: email.value.trim(), updatedAt: Date.now() } });
        toast('Customer saved');
        m.close();
      } }, 'Save')));
  setTimeout(() => name.focus(), 0);
}

function confirmDelete(c) {
  const m = modal('Delete this customer?');
  m.body.append(
    el('p', {}, `“${c.name}” — the customer record is removed. Their transactions stay; they just won’t be grouped under a customer anymore.`),
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Keep it'),
      el('button', { class: 'btn', style: 'background:var(--red)', onclick: () => { dispatch({ op: 'entity.delete', kind: 'customer', id: c.id }); toast('Customer deleted'); m.close(); } }, 'Delete')));
}
