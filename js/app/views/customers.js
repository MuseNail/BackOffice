// ── view: customers — client directory + per-customer register ─────────────────
// Mirrors Vendors, but for the income side: your clients. Income transactions are
// tagged to a customer (t.customerId) the way expenses are tagged to a vendor.
import { el, clear, toast, modal, fmtMoney } from '../ui.js';
import { entities, subscribe } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { renderRegister } from '../register.js';

let unsub = null;
const slug = (s) => 'c-' + String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export const txnsForCustomer = (c) => entities('txn').filter(t => t.status === 'posted' && t.customerId === c.id);

export function render(root, detail) {
  if (detail) { renderCustomerRegister(root, detail); return; }
  const editable = canEdit(getActiveBiz());
  const body = el('div');
  root.append(
    el('h2', {}, 'Customers'),
    el('p', { class: 'sub' }, 'Your clients. Click a customer to see all their transactions and the total received. Income is tagged to a customer the same way expenses are tagged to a vendor.'),
    editable ? el('div', { style: 'margin-bottom:14px' }, el('button', { class: 'btn sm', onclick: () => customerModal(null) }, 'New customer')) : el('span'),
    body);
  const draw = () => drawTable(body, editable);
  unsub = subscribe(draw);
  draw();
}

export function unmount() { unsub?.(); unsub = null; }

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
  const customers = entities('customer').slice();
  if (!customers.length) {
    clear(body).append(el('p', { class: 'sub' }, 'No customers yet. Add one here, or they’ll appear once income transactions are tagged to a customer.'));
    return;
  }
  const incomeIds = new Set(entities('account').filter(a => a.type === 'income').map(a => a.id));
  const totalFor = (c) => txnsForCustomer(c).reduce((s, t) => s + (t.lines || []).reduce((a, l) => a + (incomeIds.has(l.accountId) ? -l.amountCents : 0), 0), 0);
  const rows = customers.map(c => ({ c, n: txnsForCustomer(c).length, total: totalFor(c) }))
    .sort((a, b) => b.total - a.total || a.c.name.localeCompare(b.c.name));
  const tbl = el('table', { class: 'data' },
    el('tr', {}, el('th', {}, 'Customer'), el('th', { class: 'num' }, 'Transactions'), el('th', { class: 'num' }, 'Total received'), el('th', {}, '')),
    ...rows.map(({ c, n, total }) => el('tr', {},
      el('td', {}, el('a', { class: 'linklike', style: 'font-weight:700', href: `#/b/${getActiveBiz()}/customers/${c.id}`, title: 'View this customer’s transactions' }, c.name)),
      el('td', { class: 'num' }, String(n)),
      el('td', { class: 'num' }, fmtMoney(total)),
      el('td', {}, editable ? el('div', { style: 'display:flex;gap:6px' },
        el('button', { class: 'linklike', onclick: () => customerModal(c) }, 'Edit'),
        el('button', { class: 'linklike', style: 'color:var(--red)', onclick: () => confirmDelete(c) }, 'Delete')) : ''))));
  clear(body).append(el('div', { class: 'card', style: 'padding:0;overflow:hidden;max-width:760px' }, tbl));
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
