// ── view: vendors — vendors, their auto-categorize rules, and per-vendor register ─
import { el, clear, toast, modal, fmtMoney, acctAmount, prettyDesc, sortTh, sortBy } from '../ui.js';
import { entities, subscribe } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { accountLabel } from '../lib/coa-templates.js';
import { normalizeDesc } from '../lib/match.js';
import { renderRegister } from '../register.js';
import { dateRangeControl, inRange } from '../daterange.js';
import { ruleConditionsEditor, buildMatchers, ruleSummary } from '../rule-editor.js';
import { combobox } from '../combobox.js';
import { openMergeModal, mergeVendor } from '../merge.js';
import { editTxnModal } from './ledger.js';

let unsub = null;
let vendorRange = { from: null, to: null };
let vendorQuery = '';
let vendorRulesOnly = false;   // Vendors tab filter: show only vendors that have a rule
let vendorSort = { key: 'vendor', dir: 'asc' };   // default: alphabetical; headers re-sort
// A vendor "has a rule" if it auto-matches by description or memorizes a default account.
const vendorHasRule = (v) => !!(v.matchers?.conditions?.length || v.matchers?.exact?.length || v.matchers?.keywords?.length || v.defaultAccountId);
let pageRangeCtl = null;   // the page "Totals for" picker — kept in sync with the drilldown's
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// A transaction belongs to a vendor if it was stamped at approval (exact, going
// forward) OR — for older/unstamped ones — its description matches the vendor's rule.
export function vendorMatches(vendor, desc) {
  const d = normalizeDesc(desc);
  if (!d) return false;
  for (const m of vendor.matchers?.exact || []) if (d === normalizeDesc(m)) return true;
  for (const k of vendor.matchers?.keywords || []) { const kk = normalizeDesc(k); if (kk && d.includes(kk)) return true; }
  return false;
}
export const txnsForVendor = (vendor) => entities('txn').filter(t =>
  t.status === 'posted' && (t.vendorId === vendor.id || (!t.vendorId && vendorMatches(vendor, t.payee))));

export function render(root, detail) {
  const openNew = detail === 'new';
  if (openNew) detail = null;
  if (detail) { renderVendorRegister(root, detail); return; }
  const editable = canEdit(getActiveBiz());
  const body = el('div');
  const draw = () => drawTable(body, editable);
  const search = el('input', { class: 'field-input', type: 'search', placeholder: 'Search vendors / rules…', style: 'max-width:240px;margin:0', value: vendorQuery, oninput: (e) => { vendorQuery = e.target.value; draw(); } });
  pageRangeCtl = dateRangeControl({ initial: 'year', onChange: (r) => { vendorRange = r; draw(); } });
  vendorRange = pageRangeCtl.getRange();
  root.append(
    el('h2', {}, 'Vendors'),
    el('p', { class: 'sub' }, 'Your suppliers — who you pay. Click a vendor to see its transactions and total paid. Auto-categorize rules (from ⚡ in Review) live in each vendor’s Edit.'),
    el('div', { class: 'sticky-toolbar' },
      editable ? el('button', { class: 'btn sm', onclick: () => ruleModal(null) }, '＋ New vendor / rule') : el('span'),
      search,
      el('label', { style: 'display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:#3c3f48;cursor:pointer' },
        el('input', { type: 'checkbox', checked: vendorRulesOnly, onchange: (e) => { vendorRulesOnly = e.target.checked; draw(); } }), 'Rules only'),
      el('span', { class: 'sub', style: 'margin:0' }, 'Totals for'), pageRangeCtl.el),
    body,
  );
  unsub = subscribe(draw);
  draw();
  if (openNew && editable) ruleModal(null);
}

export function unmount() { unsub?.(); unsub = null; pageRangeCtl = null; vendorQuery = ''; vendorRulesOnly = false; }

// Vendor register (drill-down): every posted transaction from this vendor, total
// spent + export. Reached via #/b/<biz>/vendors/<vendorId>.
function renderVendorRegister(root, vendorId) {
  const biz = getActiveBiz();
  const vendor = entities('vendor').find(v => v.id === vendorId);
  if (!vendor) {
    root.append(el('p', { class: 'sub' }, 'That vendor no longer exists.'),
      el('a', { class: 'btn sm ghost', href: `#/b/${biz}/vendors` }, '← Back to vendors'));
    return;
  }
  unsub = renderRegister({
    root,
    title: vendor.name,
    subtitle: 'Vendor transactions',
    backHash: `/b/${biz}/vendors`,
    backLabel: 'Vendors',
    filename: `${biz}-${slug(vendor.name)}-transactions.csv`,
    getTxns: () => txnsForVendor(vendor),
  });
}

const EXPENSE_TYPES = new Set(['expense', 'cogs', 'other-expense', 'personal-expense']);
const expenseOf = (t, expenseIds) => (t.lines || []).reduce((a, l) => a + (expenseIds.has(l.accountId) ? l.amountCents : 0), 0);

function drawTable(body, editable) {
  const all = entities('vendor');
  if (!all.length) {
    clear(body).append(el('p', { class: 'sub' }, 'No vendors yet — tap ⚡ on any row in Review, or add one here.'));
    return;
  }
  const q = vendorQuery.trim().toLowerCase();
  let vendors = q ? all.filter(v => (v.name || '').toLowerCase().includes(q) || ruleSummary(v.matchers).toLowerCase().includes(q)) : all.slice();
  if (vendorRulesOnly) vendors = vendors.filter(vendorHasRule);
  if (!vendors.length) {
    clear(body).append(el('p', { class: 'sub' }, vendorRulesOnly ? 'No vendors with a rule yet.' : 'No vendors match your search.'));
    return;
  }
  const expenseIds = new Set(entities('account').filter(a => EXPENSE_TYPES.has(a.type)).map(a => a.id));
  const rows = sortBy(
    vendors.map(v => { const tx = txnsForVendor(v).filter(t => inRange(t.date, vendorRange)); return { v, n: tx.length, total: tx.reduce((s, t) => s + expenseOf(t, expenseIds), 0) }; }),
    vendorSort, { vendor: r => r.v.name, rule: r => ruleSummary(r.v.matchers), txns: r => r.n, total: r => r.total });
  const redraw = () => drawTable(body, editable);
  const tbl = el('table', { class: 'data xl' },
    el('thead', {}, el('tr', {},
      sortTh(vendorSort, 'vendor', 'Vendor', redraw),
      sortTh(vendorSort, 'rule', 'Rule', redraw),
      sortTh(vendorSort, 'txns', 'Transactions', redraw, { numeric: true, cls: 'num' }),
      sortTh(vendorSort, 'total', 'Total paid', redraw, { numeric: true, cls: 'num' }))),
    el('tbody', {}, ...rows.map(({ v, n, total }) => el('tr', { style: 'cursor:pointer', title: 'View transactions / edit rule', onclick: () => vendorDrilldown(v, () => drawTable(body, editable)) },
      el('td', {}, el('b', {}, v.name)),
      el('td', { class: 'sub', style: 'margin:0;max-width:340px' }, ruleSummary(v.matchers)),
      el('td', { class: 'num' }, String(n)),
      el('td', { class: 'num' }, acctAmount(total, { colored: false }))))));
  clear(body).append(el('div', { class: 'card', style: 'padding:0;overflow:hidden;max-width:900px' }, tbl));
}

// Click a vendor → popup with their transactions + total paid, and Edit/Delete (Esc closes).
// The popup carries its OWN date-range picker so you can re-scope the totals without
// closing it; changing it also updates the page behind (refresh) and the page picker.
function vendorDrilldown(v, refresh) {
  const m = modal(v.name);
  const accts = new Map(entities('account').map(a => [a.id, a]));
  const expenseIds = new Set([...accts.values()].filter(a => EXPENSE_TYPES.has(a.type)).map(a => a.id));
  const catOf = (t) => { const l = (t.lines || []).find(x => expenseIds.has(x.accountId)); const a = l && accts.get(l.accountId); return a ? accountLabel(a, accts) : '—'; };
  const isBankAcct = (a) => a.qbType === 'BANK' || a.qbType === 'CCARD';
  const catSel = el('select', { class: 'field-input', style: 'max-width:300px;margin:0' },
    el('option', { value: '' }, '— no memorized account —'),
    ...entities('account').filter(a => a.active !== false && !isBankAcct(a)).sort((a, b) => accountLabel(a, accts).localeCompare(accountLabel(b, accts)))
      .map(a => el('option', { value: a.id, selected: a.id === v.defaultAccountId }, accountLabel(a, accts))));
  catSel.addEventListener('change', () => {
    // Memorize the account. If the vendor has no description matcher yet, seed one from
    // its name so future imports whose description contains it auto-suggest this account.
    const hasMatch = !!(v.matchers?.exact?.length || v.matchers?.keywords?.length);
    dispatch({ op: 'entity.upsert', kind: 'vendor', value: { ...v, defaultAccountId: catSel.value || undefined, matchers: hasMatch ? v.matchers : { exact: [], keywords: [v.name] }, updatedAt: Date.now() } });
    toast(catSel.value ? 'Memorized — future imports from this vendor suggest this account' : 'Memorized account cleared');
  });

  const listHost = el('div');
  const txnSort = { key: 'date', dir: 'desc' };
  const drawList = () => {
    const txns = sortBy(txnsForVendor(v).filter(t => inRange(t.date, vendorRange)), txnSort,
      { date: t => t.date, desc: t => t.payee || t.memo || '', account: t => catOf(t), amount: t => expenseOf(t, expenseIds) });
    const total = txns.reduce((s, t) => s + expenseOf(t, expenseIds), 0);
    clear(listHost).append(
      el('div', { style: 'font-weight:800;font-size:18px;margin:12px 0 10px' }, fmtMoney(total), el('span', { class: 'sub', style: 'font-weight:400;margin-left:8px' }, `paid · ${txns.length} transactions`)),
      txns.length ? el('div', { class: 'card', style: 'padding:0;overflow:auto;max-height:50vh;margin:0' },
        el('table', { class: 'data xl' },
          el('thead', {}, el('tr', {}, sortTh(txnSort, 'date', 'Date', drawList), sortTh(txnSort, 'desc', 'Description', drawList), sortTh(txnSort, 'account', 'Account', drawList), sortTh(txnSort, 'amount', 'Amount', drawList, { numeric: true, cls: 'num' }))),
          el('tbody', {}, ...txns.map(t => el('tr', { style: 'cursor:pointer', title: 'Edit transaction', onclick: () => editTxnModal(t) }, el('td', {}, t.date), el('td', {}, prettyDesc(t.payee || t.memo) || '—'), el('td', {}, catOf(t)), el('td', { class: 'num' }, acctAmount(expenseOf(t, expenseIds), { colored: false })))))))
        : el('p', { class: 'sub' }, 'No transactions yet.'));
  };
  const rangeCtl = dateRangeControl({ initial: 'year', onChange: (r) => { vendorRange = r; pageRangeCtl?.setRange(r); drawList(); refresh?.(); } });
  rangeCtl.setRange(vendorRange);

  m.body.append(
    el('label', { class: 'field-label', style: 'margin-top:0' }, 'Memorized account — auto-suggested on future imports'),
    catSel,
    el('div', { style: 'display:flex;gap:8px;align-items:center;margin-top:12px' }, el('span', { class: 'sub', style: 'margin:0' }, 'Totals for'), rangeCtl.el),
    listHost,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap' },
      el('button', { class: 'btn ghost', style: 'color:var(--red)', onclick: () => { m.close(); confirmDeleteRule(v); } }, 'Delete'),
      el('button', { class: 'btn ghost', onclick: () => { m.close(); const moves = entities('txn').filter(t => t.vendorId === v.id).length; openMergeModal({ title: 'vendor', source: v, candidates: entities('vendor'), labelOf: (x) => x.name, run: mergeVendor, onDone: refresh, note: `${moves} transaction${moves === 1 ? '' : 's'} tagged to “${v.name}” will move to the vendor you pick. None are deleted.` }); } }, 'Merge…'),
      el('button', { class: 'btn', onclick: () => { m.close(); ruleModal(v); } }, 'Edit'),
      el('button', { class: 'btn ghost', onclick: m.close }, 'Close')));
  drawList();
}

function confirmDeleteRule(v) {
  const m = modal('Delete this rule?');
  m.body.append(
    el('p', {}, `"${v.name}" — the rule will stop suggesting this category on new imports. Already-posted transactions are not affected.`),
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Keep it'),
      el('button', { class: 'btn', style: 'background:var(--red)', onclick: () => {
        dispatch({ op: 'entity.delete', kind: 'vendor', id: v.id });
        toast('Rule deleted');
        m.close();
      } }, 'Delete')),
  );
}

function ruleModal(existing) {
  const m = modal(existing ? 'Edit rule' : 'New rule');
  const byId = new Map(entities('account').map(a => [a.id, a]));
  const isBankish = (a) => a.qbType === 'BANK' || a.qbType === 'CCARD';
  const active = entities('account').filter(a => a.active !== false);
  // Bank/card accounts are offered as transfer destinations (a rule can auto-categorize
  // a recurring transfer to another account), then the income/expense/etc. categories.
  const transferTargets = active.filter(isBankish).sort((a, b) => accountLabel(a, byId).localeCompare(accountLabel(b, byId)));
  const categories = active.filter(a => !isBankish(a)).sort((a, b) => accountLabel(a, byId).localeCompare(accountLabel(b, byId)));
  const name = el('input', { class: 'field-input', value: existing?.name || '', placeholder: 'Vendor name' });
  const editor = ruleConditionsEditor({ seed: existing?.matchers || {} });
  const catGroups = [];
  if (transferTargets.length) catGroups.push({ label: '↔ Transfer to / from', items: transferTargets.map(a => ({ value: a.id, label: accountLabel(a, byId) })) });
  catGroups.push({ label: 'Accounts', items: categories.map(a => ({ value: a.id, label: accountLabel(a, byId) })) });
  const cat = combobox({ groups: catGroups, value: existing?.defaultAccountId || '', placeholder: 'Search accounts…', minWidth: 260 });
  cat.style.cssText = 'display:block;width:100%;max-width:360px';
  m.body.append(
    el('label', { class: 'field-label' }, 'Vendor'), name,
    editor.el,
    el('label', { class: 'field-label' }, 'Account (optional — leave blank to just memorize the vendor)'), cat,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: () => {
        const spec = editor.get();
        if (!name.value.trim()) { toast('Add a vendor name', 'err'); return; }
        // Need at least a match condition (auto-tag by description) OR an account
        // (memorize vendor→account for manual picks). Either alone is a valid rule.
        if (!spec.conditions.length && !cat.value) { toast('Add a match condition or an account', 'err'); return; }
        dispatch({ op: 'entity.upsert', kind: 'vendor', value: {
          ...(existing || { used: 0 }),
          id: existing?.id || 'v-' + name.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30),
          name: name.value.trim(),
          matchers: buildMatchers(spec),
          defaultAccountId: cat.value || existing?.defaultAccountId || null,
        } });
        toast('Rule saved');
        m.close();
      } }, 'Save')),
  );
  setTimeout(() => name.focus(), 0);
}

// Lightweight "add vendor" (name only) for inline use in Review's vendor picker.
// Creates a vendor with no rule (empty matchers, no default category) and calls
// oncreate(vendor). To auto-categorize future imports, use the ⚡ "make a rule" flow.
export function quickAddVendorModal(oncreate, prefillName = '') {
  const m = modal(prefillName ? 'Add new vendor?' : 'Add vendor');
  const name = el('input', { class: 'field-input', placeholder: 'Vendor name', value: prefillName || '' });
  const submit = () => {
    const n = name.value.trim();
    if (!n) { toast('Name the vendor', 'err'); return; }
    const taken = new Set(entities('vendor').map(v => v.id));
    const base = 'v-' + (slug(n) || 'vendor');
    let id = base, i = 2;
    while (taken.has(id)) id = `${base}-${i++}`;
    const vendor = { id, name: n, matchers: { exact: [], keywords: [] }, defaultAccountId: null, used: 0 };
    dispatch({ op: 'entity.upsert', kind: 'vendor', value: vendor });
    toast('Vendor added');
    m.close();
    oncreate(vendor);
  };
  // Enter in the name field adds the vendor (hands stay on the keyboard).
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  m.body.append(
    prefillName ? el('p', { class: 'sub', style: 'margin-top:0' }, `“${prefillName}” isn’t a vendor yet — add it?`) : null,
    el('label', { class: 'field-label' }, 'Name'), name,
    el('p', { class: 'sub' }, 'Just tags this transaction with the vendor. To auto-categorize a vendor on future imports, use “⚡” in Review.'),
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: submit }, 'Add vendor')),
  );
  setTimeout(() => name.focus(), 0);
}
