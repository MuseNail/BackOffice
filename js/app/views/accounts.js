// ── view: accounts — chart of accounts CRUD ────────────────
// Rename + archive only — accounts are never deleted once they exist, because
// posted transactions reference them forever (append-only ledger).
import { el, clear, toast, modal } from '../ui.js';
import { entities, subscribe, getState } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { ACCOUNT_TYPES, accountLabel } from '../lib/coa-templates.js';
import { renderRegister } from '../register.js';
import { logAudit } from '../audit.js';
import { openMergeModal, mergeAccount, accountMergeBlockers } from '../merge.js';

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

const TYPE_LABELS = { income: 'Income', cogs: 'Cost of goods', expense: 'Expenses', 'other-expense': 'Other expense', 'personal-expense': 'Personal expense', asset: 'Assets', liability: 'Liabilities', equity: 'Equity' };
const TYPE_ORDER = ['income', 'cogs', 'expense', 'other-expense', 'personal-expense', 'asset', 'liability', 'equity'];
const QB_BY_TYPE = { income: 'INC', cogs: 'COGS', expense: 'EXP', 'other-expense': 'EXP', 'personal-expense': 'EXP', asset: 'OCASSET', liability: 'OCLIAB', equity: 'EQUITY' };

let unsub = null;

export function render(root, detail) {
  const openNew = detail === 'new';
  if (openNew) detail = null;
  if (detail) { renderAccountRegister(root, detail); return; }
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
  if (openNew && editable) editAccount(null);
}

export function unmount() { unsub?.(); unsub = null; }

// Account register (drill-down): every posted transaction hitting this account,
// with a running balance. Reached via #/b/<biz>/accounts/<accountId>.
function renderAccountRegister(root, accountId) {
  const biz = getActiveBiz();
  const acct = entities('account').find(a => a.id === accountId);
  if (!acct) {
    root.append(el('p', { class: 'sub' }, 'That account no longer exists.'),
      el('a', { class: 'btn sm ghost', href: `#/b/${biz}/accounts` }, '← Back to accounts'));
    return;
  }
  unsub = renderRegister({
    root,
    title: acct.name,
    subtitle: `${TYPE_LABELS[acct.type] || acct.type} register`,
    backHash: `/b/${biz}/accounts`,
    backLabel: 'Accounts',
    focusAccountId: accountId,
    filename: `${biz}-${slug(acct.name)}-register.csv`,
    getTxns: () => entities('txn').filter(t => t.status === 'posted' && (t.lines || []).some(l => l.accountId === accountId)),
  });
}

// Account register as a popup (preferred over the full-page route — no back-button
// round trip). The deep-link route above still works for bookmarks. The register
// subscribes to the store; its unsub runs when the modal closes.
function openAccountRegisterModal(accountId) {
  const acct = entities('account').find(a => a.id === accountId);
  if (!acct) return;
  const biz = getActiveBiz();
  let unsub = null;
  const m = modal(`${acct.name} — register`, () => unsub?.());
  const box = m.body.parentElement; if (box) { box.style.width = '900px'; box.style.maxWidth = '96vw'; }
  unsub = renderRegister({
    root: m.body,
    title: acct.name,
    subtitle: `${TYPE_LABELS[acct.type] || acct.type} register`,
    backHash: `/b/${biz}/accounts`,
    backLabel: 'Accounts',
    focusAccountId: accountId,
    filename: `${biz}-${slug(acct.name)}-register.csv`,
    getTxns: () => entities('txn').filter(t => t.status === 'posted' && (t.lines || []).some(l => l.accountId === accountId)),
    modal: true,
  });
}

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
        el('td', { style: a.parentId ? 'padding-left:32px' : '' }, a.parentId ? '› ' : '',
          el('button', { class: 'linklike', style: 'font-weight:700', title: 'View this account’s register', onclick: () => openAccountRegisterModal(a.id) }, a.name),
          a.active === false ? ' (archived)' : ''),
        el('td', {}, el('span', { class: `pill ${t === 'income' ? 'green' : ['expense', 'cogs', 'other-expense', 'personal-expense'].includes(t) ? 'red' : t === 'liability' ? 'amber' : 'blue'}` }, TYPE_LABELS[t])),
        el('td', { style: 'color:var(--mut)' }, a.qbName || ''),
        el('td', {}, ...(editable ? [
          el('button', { class: 'linklike', onclick: () => editAccount(a) }, 'Edit'),
          ' · ',
          el('button', { class: 'linklike', onclick: () => archive(a) }, a.active === false ? 'Restore' : 'Archive'),
          ...(a.active !== false ? [' · ', el('button', { class: 'linklike', onclick: () => mergeAccountFlow(a) }, 'Merge')] : []),
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

// Exported so other views (review) can open a quick "add category" modal inline
// without navigating away. Only creates — the full edit lives in editAccount().
export function quickAddAccountModal(oncreate, defaultType = 'expense', prefillName = '') {
  const m = modal(prefillName ? 'Add new account?' : 'Add account');
  const name = el('input', { class: 'field-input', placeholder: 'Account name', value: prefillName || '' });
  const type = el('select', { class: 'field-input' },
    ...['income', 'cogs', 'expense', 'other-expense', 'personal-expense', 'asset', 'liability', 'equity'].map(t =>
      el('option', { value: t, selected: t === defaultType }, TYPE_LABELS[t])));
  const parent = el('select', { class: 'field-input' });
  const redrawParents = () => {
    clear(parent).append(
      el('option', { value: '' }, '— none (top level) —'),
      ...entities('account')
        .filter(a => a.type === type.value && !a.parentId && a.active !== false)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(a => el('option', { value: a.id }, a.name)));
  };
  type.addEventListener('change', redrawParents);
  redrawParents();
  m.body.append(
    prefillName ? el('p', { class: 'sub', style: 'margin:0 0 8px' }, `“${prefillName}” isn’t an account yet — set it up below.`) : el('span'),
    el('label', { class: 'field-label' }, 'Name'), name,
    el('label', { class: 'field-label' }, 'Type'), type,
    el('label', { class: 'field-label' }, 'Subaccount of (optional)'), parent,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: () => {
        const n = name.value.trim();
        if (!n) { toast('Name the account', 'err'); return; }
        const value = { id: uniqueId(n), name: n, type: type.value,
          qbType: QB_BY_TYPE[type.value], qbName: n, parentId: parent.value || null, active: true };
        dispatch({ op: 'entity.upsert', kind: 'account', value });
        logAudit('account', { summary: `Added account “${n}”`, kind: 'account', entityId: value.id });
        toast('Account added');
        m.close();
        oncreate(value);
      } }, 'Add account')),
  );
  setTimeout(() => name.focus(), 0);
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
        logAudit('account', { summary: `${existing ? 'Edited' : 'Added'} account “${n}”`, kind: 'account', entityId: value.id });
        toast(existing ? 'Account updated' : 'Account added');
        m.close();
      } }, existing ? 'Save' : 'Add')),
  );
  setTimeout(() => name.focus(), 0);
}

// Merge this account into another of the same type: re-point all its transaction
// lines, then archive it. Blocked when any affected month is closed (locked).
function mergeAccountFlow(a) {
  const byId = new Map(entities('account').map(x => [x.id, x]));
  const { count, lockedMonths } = accountMergeBlockers(a.id);
  if (lockedMonths.length) {
    const m = modal('Can’t merge yet');
    m.body.append(
      el('p', {}, `“${a.name}” has transactions in closed month${lockedMonths.length > 1 ? 's' : ''} ${lockedMonths.join(', ')}. Merging rewrites those transactions, which a closed period blocks.`),
      el('p', { class: 'sub' }, 'Reopen those months in Settings → Close the books, merge, then close them again.'),
      el('div', { style: 'display:flex;justify-content:flex-end;margin-top:12px' }, el('button', { class: 'btn ghost', onclick: m.close }, 'OK')));
    return;
  }
  openMergeModal({
    title: 'account', source: a,
    candidates: entities('account').filter(x => x.type === a.type && x.active !== false),
    labelOf: (x) => accountLabel(x, byId),
    run: mergeAccount,
    note: `${count} transaction${count === 1 ? '' : 's'} will move to the target, and “${a.name}” will be archived. Only ${TYPE_LABELS[a.type] || a.type} accounts are offered.`,
  });
}

function archive(a) {
  if (a.active !== false) {
    // Confirm before archiving — explain the effect clearly
    const m = modal('Archive this account?');
    m.body.append(
      el('p', {}, `Archiving "${a.name}" hides it from all category pickers — you won't be able to post new transactions to it. Every existing transaction that references it is preserved and unaffected.`),
      el('p', { class: 'sub' }, 'You can restore it at any time from this screen.'),
      el('div', { style: 'display:flex;gap:9px;justify-content:flex-end' },
        el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
        el('button', { class: 'btn', onclick: () => {
          dispatch({ op: 'entity.upsert', kind: 'account', value: { ...a, active: false } });
          logAudit('account', { summary: `Archived account “${a.name}”`, kind: 'account', entityId: a.id });
          toast('Account archived — existing transactions are unchanged');
          m.close();
        } }, 'Archive')),
    );
  } else {
    dispatch({ op: 'entity.upsert', kind: 'account', value: { ...a, active: true } });
    logAudit('account', { summary: `Restored account “${a.name}”`, kind: 'account', entityId: a.id });
    toast('Account restored — it will appear in pickers again');
  }
}

function uniqueId(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'account';
  const taken = new Set(entities('account').map(a => a.id));
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}
