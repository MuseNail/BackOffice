// ── Inline "＋ Add…" intercepts for category / vendor <select>s ────────────────
// Shared by Review and the Ledger so that adding an account or vendor mid-entry
// behaves identically everywhere: choosing the "＋ Add…" sentinel opens the quick-add
// modal WITHOUT disturbing the current selection, and on success the new option is
// appended and auto-selected, then a synthetic `change` fires so any value-gated
// control (e.g. an Approve button) updates.
import { el } from './ui.js';
import { combobox } from './combobox.js';
import { entities } from './store.js';
import { accountLabel } from './lib/coa-templates.js';
import { quickAddAccountModal } from './views/accounts.js';
import { quickAddVendorModal } from './views/vendors.js';

export const NEW_CATEGORY = '__new__';
export const NEW_VENDOR = '__newvendor__';

// ── Type-to-search comboboxes (drop-in for <select>: .value get/set + 'change') ──
// Shared by the Ledger, the add/edit/journal modals, and the inline editor so that
// EVERY account / vendor / invoice picker can be searched by typing, with the same
// inline "＋ Add…" flow. Returns the combobox element; read `.value`, listen 'change'.
const ACCT_TYPE_GROUPS = [
  ['income', 'Income'], ['asset', 'Assets'], ['liability', 'Liabilities'],
  ['equity', 'Equity'], ['cogs', 'Cost of goods'], ['expense', 'Expenses'],
  ['other-expense', 'Other expenses'], ['personal-expense', 'Personal expenses'],
];
const isBankish = (a) => a.qbType === 'BANK' || a.qbType === 'CCARD';

function accountGroups({ filter = () => true, includeNone = false, noneLabel = '— none —', transfers = false, ownAccountId = null } = {}) {
  const byId = new Map(entities('account').map(a => [a.id, a]));
  const groups = [];
  if (includeNone) groups.push({ label: '', items: [{ value: '', label: noneLabel }] });
  if (transfers) {
    const targets = entities('account').filter(a => a.active !== false && isBankish(a) && a.id !== ownAccountId)
      .sort((a, b) => accountLabel(a, byId).localeCompare(accountLabel(b, byId)));
    if (targets.length) groups.push({ label: '↔ Transfer to / from', items: targets.map(a => ({ value: a.id, label: accountLabel(a, byId) })) });
  }
  for (const [type, label] of ACCT_TYPE_GROUPS) {
    const accts = entities('account').filter(a => a.active !== false && a.type === type && filter(a))
      .sort((a, b) => accountLabel(a, byId).localeCompare(accountLabel(b, byId)));
    // figure-spaces (U+2007) indent subaccounts — they survive HTML whitespace collapsing
    if (accts.length) groups.push({ label, items: accts.map(a => ({ value: a.id, label: (a.parentId ? '  ' : '') + accountLabel(a, byId) })) });
  }
  return groups;
}

export function accountCombo(opts = {}) {
  const { selected = '', defaultType = 'expense', placeholder = 'Search accounts…', minWidth = 200 } = opts;
  let cb;
  const afterAdd = (account) => { cb.setGroups(accountGroups(opts)); cb.value = account.id; cb.dispatchEvent(new Event('change')); cb.focusNoOpen(); };
  cb = combobox({
    groups: accountGroups(opts), value: selected, placeholder, minWidth, addLabel: 'Add account…',
    onAdd: () => quickAddAccountModal((a) => afterAdd(a), defaultType),
    onAddText: (typed) => quickAddAccountModal((a) => afterAdd(a), defaultType, typed),
  });
  // Re-evaluate the option list (e.g. when a money-in/out toggle changes the filter),
  // keeping the current selection. opts.filter is read live, so this reflects it.
  cb.refresh = () => cb.setGroups(accountGroups(opts));
  return cb;
}

export function vendorCombo({ selected = '', includeNone = true, noneLabel = '— none —', placeholder = 'Search vendors…', minWidth = 200, oncreated } = {}) {
  const groups = () => {
    const items = includeNone ? [{ value: '', label: noneLabel }] : [];
    for (const v of entities('vendor').slice().sort((a, b) => a.name.localeCompare(b.name))) items.push({ value: v.id, label: v.name });
    return [{ label: '', items }];
  };
  let cb;
  const afterAdd = (vendor) => { cb.setGroups(groups()); cb.value = vendor.id; cb.dispatchEvent(new Event('change')); oncreated?.(vendor); cb.focusNoOpen(); };
  cb = combobox({
    groups: groups(), value: selected, placeholder, minWidth, addLabel: 'Add vendor…',
    onAdd: () => quickAddVendorModal((v) => afterAdd(v)),
    onAddText: (typed) => quickAddVendorModal((v) => afterAdd(v), typed),
  });
  return cb;
}

export function invoiceCombo({ selected = '', placeholder = 'Find invoice # or customer…', minWidth = 200 } = {}) {
  const items = [{ value: '', label: '— none —' }];
  for (const i of entities('invoice').slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')))
    items.push({ value: i.id, label: `#${i.number || i.id} · ${(i.clientName || '').slice(0, 30)}` });
  return combobox({ groups: [{ label: '', items }], value: selected, placeholder, minWidth });
}

function autoSelectNew(sel, markerValue, created) {
  const marker = sel.querySelector(`option[value="${markerValue}"]`);
  const opt = el('option', { value: created.id }, created.name);
  marker ? marker.before(opt) : sel.append(opt);
  sel.value = created.id;
  sel.dispatchEvent(new Event('change'));
}

export function attachAddCategory(sel, initialValue = '', defaultType = 'expense') {
  let prevVal = initialValue || '';
  sel.addEventListener('change', () => {
    if (sel.value !== NEW_CATEGORY) { prevVal = sel.value; return; }
    sel.value = prevVal; // keep the row looking unchanged while the modal is open
    quickAddAccountModal((account) => { autoSelectNew(sel, NEW_CATEGORY, account); prevVal = account.id; }, defaultType);
  });
}

export function attachAddVendor(sel, initialValue = '', oncreated) {
  let prevVal = initialValue || '';
  sel.addEventListener('change', () => {
    if (sel.value !== NEW_VENDOR) { prevVal = sel.value; return; }
    sel.value = prevVal;
    quickAddVendorModal((vendor) => { autoSelectNew(sel, NEW_VENDOR, vendor); prevVal = vendor.id; oncreated?.(vendor); });
  });
}
