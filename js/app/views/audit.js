// ── view: audit — the Activity trail (read-only) ───────────────────────────────
// Lists the synced `audit` entities newest-first, filterable by date range, action,
// and free text. Append-only — nothing here is editable.
import { el, clear, fmtMoney, acctAmount } from '../ui.js';
import { entities, subscribe } from '../store.js';
import { dateRangeControl, inRange } from '../daterange.js';

let unsub = null;
let rangeCtl = null;
let flt = { q: '', action: '' };

const ACTION_LABELS = {
  post: 'Posted', edit: 'Edited', void: 'Voided', delete: 'Deleted',
  reconcile: 'Reconciled', rule: 'Rule', account: 'Account',
};
const ACTION_PILL = {
  post: 'green', edit: 'blue', void: 'amber', delete: 'red',
  reconcile: 'green', rule: 'blue', account: 'gray',
};
const actionLabel = (a) => ACTION_LABELS[a] || (a || '—');

export function render(root) {
  flt = { q: '', action: '' };
  const body = el('div');
  rangeCtl = dateRangeControl({ initial: 'month', onChange: () => drawBody(body) });
  const search = el('input', { class: 'field-input', placeholder: 'Search activity…', style: 'max-width:220px;margin:0',
    oninput: (e) => { flt.q = e.target.value; drawBody(body); } });
  const actionSel = el('select', { class: 'field-input', style: 'max-width:160px;margin:0', onchange: (e) => { flt.action = e.target.value; drawBody(body); } },
    el('option', { value: '' }, 'All actions'),
    ...Object.keys(ACTION_LABELS).map(a => el('option', { value: a }, actionLabel(a))));
  root.append(
    el('h2', {}, 'Activity'),
    el('p', { class: 'sub' }, 'A running record of changes to your books — who did what and when. Posts, edits, voids, deletes, reconciliations, and rules are tracked. This list is read-only.'),
    el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px' },
      el('span', { class: 'field-label', style: 'margin:0' }, 'Period'), rangeCtl.el, actionSel, search),
    body,
  );
  const draw = () => drawBody(body);
  unsub = subscribe(draw);
  draw();
}

export function unmount() { unsub?.(); unsub = null; rangeCtl = null; flt = { q: '', action: '' }; }

function drawBody(body) {
  const range = rangeCtl.getRange();
  const ql = flt.q.trim().toLowerCase();
  const dayOf = (ts) => { const d = new Date(ts || 0); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  let rows = entities('audit').slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const total = rows.length;
  rows = rows.filter(r => inRange(dayOf(r.ts), range));
  if (flt.action) rows = rows.filter(r => r.action === flt.action);
  if (ql) rows = rows.filter(r => `${actionLabel(r.action)} ${r.summary || ''} ${r.user || ''}`.toLowerCase().includes(ql));

  if (!total) {
    clear(body).append(el('p', { class: 'sub' }, 'No activity recorded yet. Changes you make from here on — posting, editing, voiding, deleting, reconciling, and creating rules — will appear here.'));
    return;
  }
  const shown = rows.slice(0, 500);
  const trs = shown.map(r => el('tr', {},
    el('td', { style: 'white-space:nowrap' }, new Date(r.ts || 0).toLocaleString()),
    el('td', {}, el('span', { class: 'pill ' + (ACTION_PILL[r.action] || 'gray') }, actionLabel(r.action))),
    el('td', {}, r.summary || '—'),
    el('td', { class: 'num' }, typeof r.amountCents === 'number' ? acctAmount(r.amountCents, { colored: true, sign: r.amountCents > 0 }) : ''),
    el('td', {}, r.user || '—')));
  clear(body).append(
    el('p', { class: 'sub', style: 'margin:0 0 8px' }, `${rows.length} of ${total} entr${total === 1 ? 'y' : 'ies'}${rows.length > 500 ? ' · showing the most recent 500' : ''}`),
    el('div', { class: 'card', style: 'padding:0;overflow-x:auto' },
      el('table', { class: 'data xl' },
        el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Action'), el('th', {}, 'Details'), el('th', { class: 'num' }, 'Amount'), el('th', {}, 'Who'))),
        el('tbody', {}, ...trs))),
  );
}
