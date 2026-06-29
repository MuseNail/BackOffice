// ── view: inventory — items, restock points, restocks that post to the books ────────────────
// A restock is a purchase: it bumps the item's quantity AND posts the balanced
// payment txn in one action, linked through a purchase entity (provenance both
// ways). Quantity adjustments (usage, shrinkage) change the count only — no
// money moves without a real transaction.
import { el, clear, toast, modal, fmtMoney, acctAmount } from '../ui.js';
import { entities, byId, subscribe, getState } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { parseMoney } from '../lib/money.js';
import { validateTxn, simpleTxn } from '../lib/posting.js';
import { accountLabel } from '../lib/coa-templates.js';

let unsub = null;

export function render(root) {
  const editable = canEdit(getActiveBiz());
  const body = el('div');
  root.append(
    el('h2', {}, 'Inventory'),
    el('p', { class: 'sub' }, 'What’s on the shelf, what it cost, and when to reorder. Recording a restock posts the payment to your books automatically.'),
    editable ? el('div', { style: 'display:flex;gap:9px;margin-bottom:14px' },
      el('button', { class: 'btn sm', onclick: itemModal }, 'Add item'),
      el('button', { class: 'btn sm ghost', onclick: restockModal }, 'Record restock')) : null,
    body,
  );
  const draw = () => drawBody(body, editable);
  unsub = subscribe(draw);
  draw();
}

export function unmount() { unsub?.(); unsub = null; }

// ── Shopping list ─────────────────────────────────────────────────────────────
// A simple to-buy list, synced in meta.shoppingList (no new entity kind / Worker
// deploy needed). Add ad-hoc supplies or any inventory item; print or email later.
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shopList = () => getState().meta?.shoppingList || [];
function saveShopList(list) { dispatch({ op: 'meta.set', value: { ...(getState().meta || {}), shoppingList: list } }); }
function addToShopList(text, qty) {
  const t = (text || '').trim(); if (!t) return;
  saveShopList([...shopList(), { id: 'sl-' + Date.now().toString(36), text: t, qty: (qty || '').trim(), addedAt: Date.now() }]);
  toast('Added to shopping list');
}
function printShopList() {
  const list = shopList(); if (!list.length) return;
  const biz = getState().meta?.name || '';
  const items = list.map(x => `<li>${esc(x.text)}${x.qty ? ` — <b>${esc(x.qty)}</b>` : ''}</li>`).join('');
  const w = window.open('', '_blank', 'width=600,height=700');
  if (!w) { toast('Allow pop-ups to print', 'err'); return; }
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Shopping list</title><style>body{font-family:Arial,sans-serif;padding:28px;color:#1c1d22}h1{font-size:20px;margin:0 0 14px}ul{font-size:16px;line-height:1.9}</style></head><body><h1>Shopping list${biz ? ' — ' + esc(biz) : ''}</h1><ul>${items}</ul></body></html>`);
  w.document.close(); w.focus(); w.print();
}
function emailShopList() {
  const list = shopList(); if (!list.length) return;
  const body = list.map(x => `- ${x.text}${x.qty ? ` (${x.qty})` : ''}`).join('\n');
  const a = el('a', { href: `mailto:?subject=${encodeURIComponent('Shopping list')}&body=${encodeURIComponent(body)}` });
  document.body.append(a); a.click(); a.remove();
}
function shoppingCard(editable) {
  const list = shopList();
  const addText = el('input', { class: 'field-input', style: 'margin:0;flex:1;min-width:160px', placeholder: 'Add a supply to buy…' });
  const addQty = el('input', { class: 'field-input', style: 'margin:0;max-width:90px', placeholder: 'Qty' });
  const doAdd = () => { if (!addText.value.trim()) return; addToShopList(addText.value, addQty.value); addText.value = ''; addQty.value = ''; addText.focus(); };
  addText.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
  return el('div', { class: 'card', style: 'max-width:920px' },
    el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px' },
      el('div', { class: 'cardtitle', style: 'margin:0' }, `Shopping list${list.length ? ` (${list.length})` : ''}`),
      list.length ? el('div', { style: 'display:flex;gap:6px;margin-left:auto' },
        el('button', { class: 'btn sm ghost', onclick: printShopList }, '🖨 Print'),
        el('button', { class: 'btn sm ghost', onclick: emailShopList }, '✉ Email'),
        editable ? el('button', { class: 'btn sm ghost', onclick: () => { if (confirm('Clear the whole shopping list?')) saveShopList([]); } }, 'Clear') : el('span')) : el('span')),
    editable ? el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px' }, addText, addQty, el('button', { class: 'btn sm', onclick: doAdd }, 'Add')) : el('span'),
    list.length
      ? el('div', {}, ...list.map(x => el('div', { class: 'rowline' },
          el('span', {}, el('b', {}, x.text), x.qty ? el('span', { class: 'sub', style: 'margin-left:6px' }, `× ${esc(x.qty)}`) : ''),
          editable ? el('button', { class: 'linklike', style: 'margin-left:auto', onclick: () => saveShopList(shopList().filter(i => i.id !== x.id)) }, '✓ Got it') : el('span'))))
      : el('p', { class: 'sub', style: 'margin:0' }, 'Nothing on the list. Add supplies above, or tap “Add to list” on any item below.'));
}

function drawBody(body, editable) {
  const items = entities('item').sort((a, b) => a.name.localeCompare(b.name));
  if (!items.length) {
    clear(body).append(shoppingCard(editable), el('p', { class: 'sub' }, 'No items yet — add what you keep on the shelf.'));
    return;
  }
  const rows = items.map(it => {
    const low = (it.restockAt || 0) > 0 && (it.qtyOnHand || 0) <= it.restockAt;
    return el('tr', { style: low ? 'background:#fff8f0' : '' },
      el('td', {}, el('b', {}, it.name), it.supplier ? el('div', { class: 'sub', style: 'margin:0;font-size:11px' }, it.supplier) : ''),
      el('td', { class: 'num' }, el('b', {}, String(it.qtyOnHand || 0)), it.unit ? ` ${it.unit}` : ''),
      el('td', { class: 'num' }, it.restockAt ? String(it.restockAt) : '—'),
      el('td', { class: 'num' }, it.avgUnitCostCents ? acctAmount(it.avgUnitCostCents, { colored: false }) : '—'),
      el('td', { class: 'num' }, acctAmount((it.qtyOnHand || 0) * (it.avgUnitCostCents || 0), { colored: false })),
      el('td', {}, low ? el('span', { class: 'pill amber' }, 'Restock soon') : el('span', { class: 'pill green' }, 'OK')),
      el('td', {}, editable ? el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
        el('button', { class: 'linklike', onclick: () => itemModal(it) }, 'Edit'),
        el('button', { class: 'linklike', onclick: () => adjustModal(it) }, 'Adjust qty'),
        el('button', { class: 'linklike', onclick: () => addToShopList(it.name, '') }, 'Add to list')) : ''),
    );
  });

  const purchases = entities('purchase').sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
  const purchaseRows = purchases.map(p => el('tr', {},
    el('td', {}, p.date),
    el('td', {}, byId('item', p.itemId)?.name || p.itemId),
    el('td', { class: 'num' }, '+' + p.qty),
    el('td', { class: 'num' }, acctAmount(p.unitCostCents, { colored: false })),
    el('td', { class: 'num' }, acctAmount(p.qty * p.unitCostCents, { colored: false })),
    el('td', {}, el('span', { class: 'pill blue' }, 'posted to ledger'))));

  clear(body).append(
    shoppingCard(editable),
    el('div', { class: 'card', style: 'padding:0;overflow:hidden;max-width:920px' },
      el('table', { class: 'data xl' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Item'), el('th', { class: 'num' }, 'On hand'), el('th', { class: 'num' }, 'Restock at'),
          el('th', { class: 'num' }, 'Avg unit cost'), el('th', { class: 'num' }, 'Value'), el('th', {}, 'Status'), el('th', {}, ''))),
        el('tbody', {}, ...rows))),
    purchases.length ? el('div', { class: 'card', style: 'max-width:920px' },
      el('div', { class: 'cardtitle' }, 'Recent restocks'),
      el('table', { class: 'data xl' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Item'), el('th', { class: 'num' }, 'Qty'), el('th', { class: 'num' }, 'Unit cost'), el('th', { class: 'num' }, 'Total'), el('th', {}, ''))),
        el('tbody', {}, ...purchaseRows))) : el('span'),
  );
}

function itemModal(existing) {
  const m = modal(existing?.id ? 'Edit item' : 'Add item');
  const name = el('input', { class: 'field-input', value: existing?.name || '', placeholder: 'e.g. Gel polish' });
  const supplier = el('input', { class: 'field-input', value: existing?.supplier || '', placeholder: 'optional' });
  const unit = el('input', { class: 'field-input', value: existing?.unit || '', placeholder: 'bottles, tubs, boxes…' });
  const restockAt = el('input', { class: 'field-input', value: existing?.restockAt || '', inputmode: 'numeric', placeholder: 'alert when on-hand falls to this' });
  m.body.append(
    el('label', { class: 'field-label' }, 'Item name'), name,
    el('label', { class: 'field-label' }, 'Supplier'), supplier,
    el('div', { class: 'f2' },
      el('div', {}, el('label', { class: 'field-label' }, 'Unit'), unit),
      el('div', {}, el('label', { class: 'field-label' }, 'Restock at'), restockAt)),
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: () => {
        if (!name.value.trim()) { toast('Name the item', 'err'); return; }
        dispatch({ op: 'entity.upsert', kind: 'item', value: {
          ...(existing || { qtyOnHand: 0, avgUnitCostCents: 0 }),
          id: existing?.id || 'it-' + Date.now().toString(36),
          name: name.value.trim(), supplier: supplier.value.trim(), unit: unit.value.trim(),
          restockAt: parseInt(restockAt.value, 10) || 0,
        } });
        toast(existing?.id ? 'Item updated' : 'Item added');
        m.close();
      } }, 'Save')),
  );
  setTimeout(() => name.focus(), 0);
}

function adjustModal(item) {
  const m = modal(`Adjust quantity — ${item.name}`);
  const qty = el('input', { class: 'field-input', value: String(item.qtyOnHand || 0), inputmode: 'numeric', style: 'max-width:140px' });
  m.body.append(
    el('p', { class: 'sub' }, 'For usage or shrinkage — changes the count only, no money moves. Purchases belong in Record restock.'),
    el('label', { class: 'field-label' }, 'On hand now'), qty,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: () => {
        const n = parseInt(qty.value, 10);
        if (!Number.isInteger(n) || n < 0) { toast('Whole number, 0 or more', 'err'); return; }
        dispatch({ op: 'entity.upsert', kind: 'item', value: { ...item, qtyOnHand: n } });
        toast('Quantity updated');
        m.close();
      } }, 'Save')),
  );
}

function restockModal() {
  const items = entities('item').sort((a, b) => a.name.localeCompare(b.name));
  if (!items.length) { toast('Add an item first', 'err'); return; }
  const accounts = entities('account').filter(a => a.active !== false);
  const bankish = accounts.filter(a => a.qbType === 'BANK' || a.qbType === 'CCARD');
  if (!bankish.length) { toast('Add a bank account in Banking first', 'err'); return; }
  const postable = accounts.filter(a => ['expense', 'cogs', 'asset'].includes(a.type) && a.qbType !== 'BANK' && a.qbType !== 'CCARD');
  const defaultCat = postable.find(a => a.id === 'inventory') || postable.find(a => /suppl/i.test(a.name)) || postable[0];

  const m = modal('Record restock');
  const itemSel = el('select', { class: 'field-input' }, ...items.map(i => el('option', { value: i.id }, i.name)));
  const qty = el('input', { class: 'field-input', inputmode: 'numeric', placeholder: 'e.g. 24' });
  const unitCost = el('input', { class: 'field-input', inputmode: 'decimal', placeholder: 'per unit, e.g. 8.40' });
  const date = el('input', { class: 'field-input', type: 'date', value: new Date().toISOString().slice(0, 10) });
  const bank = el('select', { class: 'field-input' }, ...bankish.map(a => el('option', { value: a.id }, a.name)));
  const accountsMap = new Map(accounts.map(a => [a.id, a]));
  const cat = el('select', { class: 'field-input' }, ...postable
    .sort((a, b) => accountLabel(a, accountsMap).localeCompare(accountLabel(b, accountsMap)))
    .map(a => el('option', { value: a.id, selected: a.id === defaultCat?.id }, accountLabel(a, accountsMap))));
  m.body.append(
    el('label', { class: 'field-label' }, 'Item'), itemSel,
    el('div', { class: 'f2' },
      el('div', {}, el('label', { class: 'field-label' }, 'Quantity'), qty),
      el('div', {}, el('label', { class: 'field-label' }, 'Unit cost ($)'), unitCost)),
    el('div', { class: 'f2' },
      el('div', {}, el('label', { class: 'field-label' }, 'Date'), date),
      el('div', {}, el('label', { class: 'field-label' }, 'Paid from'), bank)),
    el('label', { class: 'field-label' }, 'Post to'), cat,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn green', onclick: () => {
        const item = byId('item', itemSel.value);
        const n = parseInt(qty.value, 10);
        const costCents = parseMoney(unitCost.value);
        if (!item || !Number.isInteger(n) || n <= 0 || !costCents || costCents <= 0) { toast('Quantity and unit cost need real numbers', 'err'); return; }
        const totalCents = n * costCents;
        const txn = simpleTxn({
          id: 't-rs-' + Date.now().toString(36), date: date.value,
          payee: item.supplier || item.name, memo: `Restock ${item.name} ×${n}`,
          amountCents: totalCents, direction: 'out',
          bankAccountId: bank.value, categoryAccountId: cat.value,
          source: { app: 'inventory' },
        });
        const v = validateTxn(txn, {
          accountsById: new Map(entities('account').map(a => [a.id, a])),
          locks: new Set(entities('lock').map(l => l.id)),
        });
        if (!v.ok) { toast(v.error, 'err'); return; }
        dispatch({ op: 'entity.upsert', kind: 'txn', value: txn });
        dispatch({ op: 'entity.upsert', kind: 'purchase', value: {
          id: 'pu-' + Date.now().toString(36), itemId: item.id, date: date.value,
          qty: n, unitCostCents: costCents, txnId: txn.id,
        } });
        const prevQty = item.qtyOnHand || 0;
        const prevAvg = item.avgUnitCostCents || 0;
        const newQty = prevQty + n;
        const newAvg = Math.round((prevQty * prevAvg + n * costCents) / newQty);
        dispatch({ op: 'entity.upsert', kind: 'item', value: { ...item, qtyOnHand: newQty, avgUnitCostCents: newAvg } });
        toast(`${item.name} +${n} — ${fmtMoney(totalCents)} posted to the ledger`);
        m.close();
      } }, 'Record & post')),
  );
}
