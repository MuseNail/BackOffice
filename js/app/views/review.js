// ── view: review — approve staged bank rows into the ledger ────────────────
// Approval is THE posting moment: it builds the balanced double entry and
// links it back to its import (source.importId + sourceId). Skipped rows keep
// their dedupHash so re-imports don't resurrect them.
import { el, clear, toast, fmtMoney } from '../ui.js';
import { entities, subscribe } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { validateTxn, simpleTxn } from '../lib/posting.js';

let unsub = null;

export function render(root) {
  const editable = canEdit(getActiveBiz());
  const body = el('div');
  root.append(
    el('h2', {}, 'Review'),
    el('p', { class: 'sub' }, 'Imported transactions wait here. Pick a category and approve — nothing reaches your books without you.'),
    body,
  );
  const draw = () => drawBody(body, editable);
  unsub = subscribe(draw);
  draw();
}

export function unmount() { unsub?.(); unsub = null; }

const bankName = (id) => entities('bankacct').find(b => b.id === id)?.name || id;

function drawBody(body, editable) {
  const pending = entities('staged')
    .filter(s => s.status === 'pending')
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!pending.length) {
    clear(body).append(el('p', { class: 'sub' }, 'All caught up — nothing waiting. Import a CSV from Banking to fill this screen.'));
    return;
  }
  const categories = entities('account')
    .filter(a => a.active !== false && a.qbType !== 'BANK' && a.qbType !== 'CCARD')
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

  const rows = pending.slice(0, 100).map(row => {
    const sel = el('select', { class: 'field-input', style: 'margin:0;min-width:180px' },
      el('option', { value: '' }, '— pick a category —'),
      ...categories.map(a => el('option', { value: a.id }, a.name)));
    const approve = el('button', { class: 'btn sm green', disabled: true, onclick: () => approveRow(row, sel.value) }, 'Approve');
    sel.addEventListener('change', () => { approve.disabled = !sel.value; });
    return el('tr', {},
      el('td', {}, row.date),
      el('td', {}, el('b', {}, row.desc.slice(0, 60)), el('div', { class: 'sub', style: 'margin:0;font-size:11px' }, bankName(row.bankacctId))),
      el('td', { class: 'num ' + (row.amountCents < 0 ? 'neg' : 'pos') }, fmtMoney(row.amountCents, { sign: row.amountCents > 0 })),
      el('td', {}, editable ? sel : '—'),
      el('td', {}, editable ? el('div', { style: 'display:flex;gap:6px' }, approve,
        el('button', { class: 'btn sm ghost', onclick: () => skipRow(row) }, 'Skip')) : ''),
    );
  });

  clear(body).append(
    el('p', {}, el('span', { class: 'pill amber' }, `${pending.length} waiting`)),
    el('div', { class: 'card', style: 'padding:0;overflow:hidden' },
      el('table', { class: 'data' },
        el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Bank description'), el('th', { class: 'num' }, 'Amount'), el('th', {}, 'Category'), el('th', {}, '')),
        ...rows)),
    pending.length > 100 ? el('p', { class: 'sub' }, `Showing the first 100 of ${pending.length}.`) : el('span'),
  );
}

function approveRow(row, categoryId) {
  const bankacct = entities('bankacct').find(b => b.id === row.bankacctId);
  if (!bankacct) { toast('Bank account missing', 'err'); return; }
  const txn = simpleTxn({
    id: 't-' + row.id,
    date: row.date,
    payee: row.desc,
    amountCents: Math.abs(row.amountCents),
    direction: row.amountCents < 0 ? 'out' : 'in',
    bankAccountId: bankacct.accountId,
    categoryAccountId: categoryId,
    source: { app: 'import', importId: row.importId, sourceId: row.id },
  });
  const v = validateTxn(txn, {
    accountsById: new Map(entities('account').map(a => [a.id, a])),
    locks: new Set(entities('lock').map(l => l.id)),
  });
  if (!v.ok) { toast(v.error, 'err'); return; }
  dispatch({ op: 'entity.upsert', kind: 'txn', value: txn });
  dispatch({ op: 'entity.upsert', kind: 'staged', value: { ...row, status: 'approved', txnId: txn.id, categoryId } });
  toast('Posted to the ledger');
}

function skipRow(row) {
  dispatch({ op: 'entity.upsert', kind: 'staged', value: { ...row, status: 'skipped' } });
  toast('Skipped');
}
