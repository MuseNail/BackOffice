// ── view: accounts — chart of accounts CRUD ────────────────
// Rename + archive only — accounts are never deleted once they exist, because
// posted transactions reference them forever (append-only ledger).
import { el, clear, toast, modal } from '../ui.js';
import { entities, subscribe, getState } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { ACCOUNT_TYPES, accountLabel } from '../lib/coa-templates.js';

const TYPE_LABELS = { income: 'Income', cogs: 'Cost of goods', expense: 'Expenses', asset: 'Assets', liability: 'Liabilities', equity: 'Equity' };
const TYPE_ORDER = ['income', 'cogs', 'expense', 'asset', 'liability', 'equity'];
const QB_BY_TYPE = { income: 'INC', cogs: 'COGS', expense: 'EXP', asset: 'OCASSET', liability: 'OCLIAB', equity: 'EQUITY' };

let unsub = null;

export function render(root) {
  const editable = canEdit(getActiveBiz());
  const body = el('div');
  root.append(
    el('h2', {}, 'Chart of accounts'),
    el('p', { class: 'sub' }, 'Every category your money moves through. Rename or archive anytime — archived accounts keep their history but stop appearing in pickers.'),
    editable ? el('div', { style: 'margin-bottom:14px' },
      el('button', { class: 'btn sm', onclick: () => editAccount(null) }, 'Add account')) : null,
    body,
  );
  const draw = () => drawTable(body, editable);
  unsub = subscribe(draw);
  draw();
}

export function unmount() { unsub?.(); unsub = null; }

function drawTable(body, editable) {
  const accounts = entities('account');
  if (!accounts.length) { clear(body).append(el('p', { class: 'sub' }, 'No accounts yet.')); return; }
  const showArchived = body.dataset.showArchived === '1';
  const rows = [];
  for (const t of TYPE_ORDER) {
    const inType = accounts.filter(a => a.type === t && (showArchived || a.active !== false));
    if (!inType.length) continue;
    // parents first (alphabetical), each followed by its children
    const tops = inType.filter(a => !a.parentId).sort((a, b) => a.name.localeCompare(b.name));
    const orphans = inType.filter(a => a.parentId && !tops.some(p => p.id === a.parentId));
    const group = [];
    for (const p of tops) {
      group.push(p);
      group.push(...inType.filter(a => a.parentId === p.id).sort((a, b) => a.name.localeCompare(b.name)));
    }
    group.push(...orphans);
    rows.push(el('tr', {}, el('td', { colspan: '4', class: 'coatype', style: 'padding-top:14px' }, TYPE_LABELS[t])));
    for (const a of group) {
      rows.push(el('tr', { style: a.active === false ? 'opacity:.5' : '' },
        el('td', { style: a.parentId ? 'padding-left:32px' : '' }, a.parentId ? '› ' : '', el('b', {}, a.name), a.active === false ? ' (archived)' : ''),
        el('td', {}, el('span', { class: `pill ${t === 'income' ? 'green' : t === 'expense' || t === 'cogs' ? 'red' : t === 'liability' ? 'amber' : 'blue'}` }, TYPE_LABELS[t])),
        el('td', { style: 'color:var(--mut)' }, a.qbName || ''),
        el('td', {}, ...(editable ? [
          el('button', { class: 'linklike', onclick: () => editAccount(a) }, 'Edit'),
          ' · ',
          el('button', { class: 'linklike', onclick: () => archive(a) }, a.active === false ? 'Restore' : 'Archive'),
        ] : [])),
      ));
    }
  }
  clear(body).append(
    el('div', { class: 'card', style: 'padding:0;overflow:hidden;max-width:860px' },
      el('table', { class: 'data' },
        el('tr', {}, el('th', {}, 'Account'), el('th', {}, 'Type'), el('th', {}, 'QuickBooks name'), el('th', {}, '')),
        ...rows)),
    el('button', { class: 'linklike', onclick: () => { body.dataset.showArchived = showArchived ? '' : '1'; drawTable(body, editable); } },
      showArchived ? 'Hide archived' : 'Show archived'),
  );
}

function editAccount(existing) {
  const m = modal(existing ? 'Edit account' : 'Add account');
  const name = el('input', { class: 'field-input', placeholder: 'Account name', value: existing?.name || '' });
  const type = el('select', { class: 'field-input', disabled: !!existing },
    ...ACCOUNT_TYPES.map(t => el('option', { value: t, selected: existing?.type === t }, TYPE_LABELS[t])));
  const qbName = el('input', { class: 'field-input', placeholder: 'QuickBooks name (defaults to the name)', value: existing?.qbName || '' });
  // one level deep: only same-type, top-level accounts can be parents
  const parent = el('select', { class: 'field-input' });
  const redrawParents = () => {
    const t = existing?.type || type.value;
    clear(parent).append(
      el('option', { value: '' }, '— none (top level) —'),
      ...entities('account')
        .filter(a => a.type === t && !a.parentId && a.active !== false && a.id !== existing?.id)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(a => el('option', { value: a.id, selected: a.id === existing?.parentId }, a.name)));
  };
  type.addEventListener('change', redrawParents);
  redrawParents();
  m.body.append(
    el('label', { class: 'field-label' }, 'Name'), name,
    el('label', { class: 'field-label' }, 'Type', existing ? ' — fixed once created (history depends on it)' : ''), type,
    el('label', { class: 'field-label' }, 'Subaccount of'), parent,
    el('label', { class: 'field-label' }, 'QuickBooks export name'), qbName,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: () => {
        const n = name.value.trim();
        if (!n) { toast('Name the account', 'err'); return; }
        const value = existing
          ? { ...existing, name: n, qbName: qbName.value.trim() || n, parentId: parent.value || null }
          : { id: uniqueId(n), name: n, type: type.value, qbType: QB_BY_TYPE[type.value], qbName: qbName.value.trim() || n, parentId: parent.value || null, active: true };
        dispatch({ op: 'entity.upsert', kind: 'account', value });
        toast(existing ? 'Account updated' : 'Account added');
        m.close();
      } }, existing ? 'Save' : 'Add')),
  );
  setTimeout(() => name.focus(), 0);
}

function archive(a) {
  dispatch({ op: 'entity.upsert', kind: 'account', value: { ...a, active: a.active === false } });
  toast(a.active === false ? 'Account restored' : 'Account archived');
}

function uniqueId(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'account';
  const taken = new Set(entities('account').map(a => a.id));
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}
