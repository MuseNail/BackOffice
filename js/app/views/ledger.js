// ── view: ledger — posted transactions, manual entry, journal entries ────────────────
import { el, clear, toast, modal, fmtMoney, acctAmount, prettyDesc } from '../ui.js';
import { entities, subscribe, usesInvoices } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { parseMoney } from '../lib/money.js';
import { validateTxn, simpleTxn, voidTxn, periodKey, accountBalance } from '../lib/posting.js';
import { accountLabel } from '../lib/coa-templates.js';
import { vendorMatches } from './vendors.js';
import { accountCombo, vendorCombo, invoiceCombo } from '../pickers.js';
import { categoryField, vendorField, memoField, invoiceField, categoryName, stackedEditor } from '../txn-inline.js';
import { bindSuggest } from '../suggest.js';
import { dateRangeControl } from '../daterange.js';
import { logAudit } from '../audit.js';

let unsub = null;

// Where a transaction came from — shown as a pill so a manual entry, a direct bank
// (Plaid) sync, a CSV import, a QuickBooks import, and a Muse sales sync are all
// distinguishable at a glance.
const SOURCE_TAGS = {
  manual:   { label: 'Manual', cls: 'green' },
  csv:      { label: 'CSV', cls: 'blue' },
  plaid:    { label: 'Bank', cls: 'blue' },
  'qb-iif': { label: 'QuickBooks', cls: 'blue' },
  musenail: { label: 'Muse', cls: 'gray' },
};
const sourceTag = (app) => SOURCE_TAGS[app] || { label: 'Import', cls: 'blue' };

const flt = { q: '', from: '', to: '', accountId: '', vendorId: '', source: '', type: '' };
const sort = { key: 'date', dir: 'desc' };
// A global-search transaction result deep-links the ledger to a query (set before navigating).
let _pendingQuery = '';
export function setLedgerQuery(q) { _pendingQuery = q || ''; }
const resetFilters = () => { Object.assign(flt, { q: '', from: '', to: '', accountId: '', vendorId: '', source: '', type: '' }); sort.key = 'date'; sort.dir = 'desc'; };

// Transaction-type filter — derived from the bank description + the amount sign.
const TYPE_FILTERS = [['', 'All types'], ['in', 'Deposits (money in)'], ['out', 'Money out'],
  ['zelle', 'Zelle'], ['ach', 'ACH'], ['card', 'Card'], ['atm', 'ATM'], ['check', 'Check'], ['transfer', 'Transfer / wire']];
function typeMatch(t, type) {
  if (!type) return true;
  const d = `${t.payee || ''} ${t.memo || ''}`.toLowerCase();
  switch (type) {
    case 'in': return rowAmount(t) > 0;
    case 'out': return rowAmount(t) < 0;
    case 'zelle': return /zelle/.test(d);
    case 'ach': return /\bach\b/.test(d);
    case 'card': return /\b(card|pos|debit|purchase)\b/.test(d);
    case 'atm': return /\batm\b/.test(d);
    case 'check': return !!t.checkNo || /\b(check|chk|cheque)\b/.test(d);
    case 'transfer': return /\b(transfer|xfer|wire)\b/.test(d);
    default: return true;
  }
}

export function render(root, detail) {
  const editable = canEdit(getActiveBiz());
  // "+ New → Transaction" deep-links here as /ledger/new — open the add modal on mount.
  const openNew = detail === 'new';
  if (openNew) detail = undefined;
  if (_pendingQuery) { flt.q = _pendingQuery; _pendingQuery = ''; }
  // #/b/<biz>/ledger/<accountId> opens the ledger scoped to one account's register
  // (deep-linked from the Banking balance cards).
  if (detail && entities('account').some(a => a.id === detail)) flt.accountId = detail;
  const tableHost = el('div');
  const redraw = () => drawTable(tableHost, editable);
  root.append(
    el('h2', {}, 'Ledger'),
    el('p', { class: 'sub' }, 'Every posted transaction. Search and filter below; click a column heading to sort. Void zeroes an entry out of balances; Delete removes it (blocked once reconciled).'),
    editable ? el('div', { class: 'no-print', style: 'display:flex;gap:9px;margin-bottom:12px' },
      el('button', { class: 'btn sm', onclick: addTxnModal }, 'Add transaction'),
      el('button', { class: 'btn sm ghost', onclick: journalModal }, 'Journal entry')) : el('span'),
    filterBar(redraw),   // built once → the search box keeps focus while you type
    tableHost,
  );
  unsub = subscribe(redraw);
  redraw();
  if (openNew && editable) addTxnModal();
}

export function unmount() { unsub?.(); unsub = null; resetFilters(); }

// The filter bar is rendered ONCE and persists; only the table re-renders on change.
function filterBar(redraw) {
  // Account scope is the tab bar (in the table) — no redundant dropdown here.
  const search = el('input', { class: 'field-input', placeholder: 'Search payee / memo…', value: flt.q, style: 'max-width:190px', oninput: (e) => { flt.q = e.target.value; redraw(); } });
  const rangeCtl = dateRangeControl({ initial: 'year', onChange: (r) => { flt.from = r.from || ''; flt.to = r.to || ''; redraw(); } });
  // Seed the filter to the control's default (This year) — the control doesn't fire
  // onChange on creation, so apply its initial range up front.
  if (!flt.from && !flt.to) { const r0 = rangeCtl.getRange(); flt.from = r0.from || ''; flt.to = r0.to || ''; }
  const typeSel = el('select', { class: 'field-input', style: 'max-width:160px', onchange: (e) => { flt.type = e.target.value; redraw(); } },
    ...TYPE_FILTERS.map(([v, l]) => el('option', { value: v, selected: v === flt.type }, l)));
  const vend = vendorCombo({ selected: flt.vendorId, includeNone: true, noneLabel: 'All vendors', minWidth: 0 });
  vend.style.cssText = 'max-width:170px';
  vend.addEventListener('change', () => { flt.vendorId = vend.value; redraw(); });
  const src = el('select', { class: 'field-input', style: 'max-width:140px', onchange: (e) => { flt.source = e.target.value; redraw(); } },
    el('option', { value: '' }, 'All sources'), ...Object.keys(SOURCE_TAGS).map(k => el('option', { value: k, selected: k === flt.source }, SOURCE_TAGS[k].label)));
  const clear = el('button', { class: 'btn sm ghost', onclick: () => {
    resetFilters();
    search.value = ''; typeSel.value = ''; vend.value = ''; src.value = ''; rangeCtl.reset();
    redraw();
  } }, 'Clear');
  return el('div', { class: 'no-print', style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px' },
    search, rangeCtl.el, typeSel, vend, src, clear);
}

function applyFilters(txns) {
  const q = flt.q.trim().toLowerCase();
  const vendor = flt.vendorId ? entities('vendor').find(v => v.id === flt.vendorId) : null;
  return txns.filter(t => {
    if (flt.from && t.date < flt.from) return false;
    if (flt.to && t.date > flt.to) return false;
    if (flt.accountId && !(t.lines || []).some(l => l.accountId === flt.accountId)) return false;
    if (flt.source && (t.source?.app || '') !== flt.source) return false;
    if (flt.type && !typeMatch(t, flt.type)) return false;
    if (vendor && !(t.vendorId === vendor.id || (!t.vendorId && vendorMatches(vendor, t.payee)))) return false;
    if (q && !`${t.payee || ''} ${t.memo || ''} ${t.checkNo || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

// Signed cents on one account's line(s) of a txn — the register's per-account amount.
const lineSumOn = (t, id) => (t.lines || []).filter(l => l.accountId === id).reduce((s, l) => s + l.amountCents, 0);
// When scoped to one account the amount column shows that account's movement;
// otherwise it's the business-total amount from describe().
const rowAmount = (t) => flt.accountId ? lineSumOn(t, flt.accountId) : describe(t).amount;
const sortAmt = (t) => { const a = rowAmount(t); return a == null ? 0 : a; };
function applySort(txns) {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const cmp = ({
    date: (a, b) => a.date.localeCompare(b.date),
    payee: (a, b) => (a.payee || '').localeCompare(b.payee || ''),
    category: (a, b) => describe(a).category.localeCompare(describe(b).category),
    amount: (a, b) => sortAmt(a) - sortAmt(b),
  })[sort.key] || ((a, b) => a.date.localeCompare(b.date));
  return [...txns].sort((a, b) => dir * cmp(a, b) || ((b.updatedAt || 0) - (a.updatedAt || 0)));
}
function setSort(key) {
  if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
  else { sort.key = key; sort.dir = key === 'date' ? 'desc' : 'asc'; }
}
const arrow = (key) => sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';

const acctName = (id) => {
  const byId = new Map(entities('account').map(a => [a.id, a]));
  const a = byId.get(id);
  return a ? accountLabel(a, byId) : id;
};
const bankish = (a) => a.qbType === 'BANK' || a.qbType === 'CCARD';

function describe(t) {
  // 2-line txn → show the non-bank side as the category; anything else is a journal
  if (t.lines.length === 2) {
    const bank = t.lines.find(l => { const a = entities('account').find(x => x.id === l.accountId); return a && bankish(a); });
    const other = t.lines.find(l => l !== bank);
    if (bank && other) return { category: acctName(other.accountId), amount: bank.amountCents };
  }
  return { category: 'Journal — ' + t.lines.map(l => acctName(l.accountId)).join(', '), amount: null };
}

// Quick-switch bar: "All accounts" (business total) + one chip per bank/card
// account. Selecting a bank account scopes the ledger to that account's register.
function accountTabs(host, editable) {
  const byId = new Map(entities('account').map(a => [a.id, a]));
  const banks = entities('bankacct')
    .map(b => byId.get(b.accountId)).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  const pick = (id) => { flt.accountId = id; drawTable(host, editable); };
  const chip = (id, label) => el('button', {
    class: 'btn sm' + (flt.accountId === id ? '' : ' ghost'),
    onclick: () => pick(id),
  }, label);
  return el('div', { class: 'no-print', style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px' },
    chip('', 'All accounts'),
    ...banks.map(a => chip(a.id, a.name)));
}

function drawTable(host, editable) {
  const allTxns = entities('txn').filter(t => t.status === 'posted' || t.status === 'void');
  if (!allTxns.length) {
    clear(host).append(el('p', { class: 'sub' }, 'No transactions yet — add one above, or import a CSV from Banking.'));
    return;
  }
  const byId = new Map(entities('account').map(a => [a.id, a]));
  const scopedAcct = flt.accountId ? byId.get(flt.accountId) : null;
  const scoped = !!scopedAcct;
  const isBank = scoped && bankish(scopedAcct);

  // Running balance is computed CHRONOLOGICALLY over ALL of this account's posted
  // history (not just the filtered/visible rows), so each shown row's balance is the
  // true cumulative figure — and the latest row ties out to the account balance.
  const balAfter = new Map();
  if (scoped) {
    let run = 0;
    const chron = entities('txn')
      .filter(t => t.status === 'posted' && (t.lines || []).some(l => l.accountId === flt.accountId))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : 1));
    for (const t of chron) { run += lineSumOn(t, flt.accountId); balAfter.set(t.id, run); }
  }

  const showInv = usesInvoices();
  const invById = new Map(entities('invoice').map(i => [i.id, i]));
  const vendById = new Map(entities('vendor').map(v => [v.id, v]));
  const colCount = 2 + 1 /*details*/ + 1 /*source*/ + 1 /*amount*/ + (scoped ? 1 : 0);

  const filtered = applySort(applyFilters(allTxns));
  const txns = filtered.slice(0, 200);
  const rows = txns.flatMap(t => {
    const d = describe(t);
    const amt = rowAmount(t);
    const isVoid = t.status === 'void';
    const isRecon = !!t.reconciledIn;
    const inlineEditable = editable && !isVoid;

    // The four editable fields, live when editable / static text otherwise. They're
    // laid out 2×2 inside ONE "Details" cell (Vendor·Account / Invoice·Memo) so the
    // table is narrow enough to never need horizontal scrolling.
    let catCell, vendCell, memoCell, invCell;
    if (inlineEditable) {
      catCell = categoryField(t); vendCell = vendorField(t); memoCell = memoField(t);
      invCell = showInv ? invoiceField(t) : null;
    } else {
      const vd = t.vendorId ? vendById.get(t.vendorId) : null;
      const iv0 = t.invoiceId ? invById.get(t.invoiceId) : null;
      catCell = el('span', { class: 'txi-static' }, categoryName(t) || d.category);
      vendCell = el('span', { class: 'txi-static' }, vd ? vd.name : '—');
      memoCell = el('span', { class: 'txi-static' }, t.memo || '—');
      invCell = showInv ? el('span', { class: 'txi-static' }, iv0 ? `#${iv0.number || iv0.id}` : '—') : null;
    }
    const gcell = (lbl, node) => el('div', {}, el('span', { class: 'txglbl' }, lbl), node);
    // Clicks inside the details cell drive the inline fields — they must NOT also
    // trigger the row's "click to edit".
    const detailsCell = el('td', { class: 'txinline txdetails', onclick: (e) => e.stopPropagation() },
      el('div', { class: 'txdetails-c' },
        el('div', { class: 'txgrid' },
          gcell('Vendor', vendCell),
          gcell('Account', catCell),
          showInv ? gcell('Invoice', invCell) : el('div', {}),
          gcell('Memo', memoCell))));

    const srcCell = el('td', {},
      el('span', { class: `pill ${isVoid ? 'gray' : sourceTag(t.source?.app).cls}` }, isVoid ? 'Void' : sourceTag(t.source?.app).label),
      isRecon ? el('span', { class: 'pill gray', title: 'Amounts and accounts are locked — reconciled in a closed period', style: 'margin-left:4px' }, 'Reconciled') : '');
    const amtCell = el('td', { class: 'num' }, amt == null ? '—' : acctAmount(amt, { colored: true, sign: amt > 0 }));
    const balCell = scoped ? el('td', { class: 'num' }, isVoid ? '—' : acctAmount(balAfter.get(t.id) || 0, { colored: true })) : null;

    // Mobile compact line + tap-to-expand stacked editor.
    const iv = t.invoiceId ? invById.get(t.invoiceId) : null;
    const chevron = inlineEditable ? el('i', { class: 'ti ti-chevron-down txchev' }) : '';
    const detail = inlineEditable ? el('tr', { class: 'txrow-detail' },
      el('td', { colspan: String(colCount), style: 'background:var(--bg);padding:12px 14px' }, stackedEditor(t))) : null;
    const compact = el('div', { class: 'txcompact', onclick: inlineEditable ? (e) => { e.stopPropagation(); detail.classList.toggle('open'); chevron.className = detail.classList.contains('open') ? 'ti ti-chevron-up txchev' : 'ti ti-chevron-down txchev'; } : undefined },
      el('span', { style: 'color:var(--mut)' }, categoryName(t) || d.category),
      (showInv && iv) ? el('span', { class: 'pill blue', style: 'font-size:10px;padding:2px 7px' }, `#${iv.number || iv.id}`) : '',
      chevron);

    // The whole row is the Edit button (Delete / Void now live inside that modal).
    // The dropdowns above stopPropagation so they edit inline instead of opening it.
    const summary = el('tr', {
        style: isVoid ? 'opacity:.45;' : (inlineEditable ? 'cursor:pointer' : ''),
        title: inlineEditable ? 'Click to edit (date, amount) · delete / void inside' : '',
        onclick: inlineEditable ? () => editTxnModal(t) : undefined },
      el('td', { style: 'white-space:nowrap' }, t.date),
      el('td', {}, el('b', {}, prettyDesc(t.payee) || '—'), t.checkNo ? el('span', { style: 'color:var(--mut)' }, ` · #${t.checkNo}`) : '', compact),
      detailsCell,
      srcCell, amtCell, balCell);
    return detail ? [summary, detail] : [summary];
  });
  const th = (key, label, cls) => el('th', { class: cls || '', style: 'cursor:pointer;user-select:none', title: 'Click to sort', onclick: () => { setSort(key); drawTable(host, editable); } }, label + arrow(key));
  const balance = scoped ? accountBalance(entities('txn'), flt.accountId) : 0;
  const headerRow = el('tr', {}, th('date', 'Date'), th('payee', 'Payee / memo'),
    el('th', { class: 'txinline' }, 'Details'),
    el('th', {}, 'Source'), th('amount', 'Amount', 'num'),
    scoped ? el('th', { class: 'num' }, 'Balance') : null);
  const totalCents = filtered.reduce((s, t) => { const a = rowAmount(t); return s + (a == null ? 0 : a); }, 0);
  const footRow = el('tr', {},
    el('td', { colspan: '4' }, `Total · ${filtered.length} transaction${filtered.length === 1 ? '' : 's'}`),
    el('td', { class: 'num' }, acctAmount(totalCents, { colored: false })),
    scoped ? el('td', {}) : null);
  const table = el('table', { class: 'data xl ledger-table' + (editable ? ' txedit' : '') },
    el('thead', {}, headerRow), el('tbody', {}, ...rows), el('tfoot', {}, footRow));
  // Account tabs + count pin together; the column header pins flush beneath them.
  const ledgerHead = el('div', { class: 'ledger-head no-print' },
    accountTabs(host, editable),
    el('p', { class: 'sub', style: 'margin:6px 0 0' },
      `${filtered.length} of ${allTxns.length} transaction${allTxns.length === 1 ? '' : 's'}${filtered.length > 200 ? ' · showing the first 200 — narrow the filters to see the rest' : ''}`));
  clear(host).append(
    scoped ? el('div', { class: 'card', style: 'max-width:420px;margin-bottom:12px' },
      el('div', { class: 'kpilbl' }, `${scopedAcct.name} — current balance`),
      el('div', { class: 'kpi' }, fmtMoney(balance)),
      el('div', { class: 'sub', style: 'margin:0' }, isBank
        ? 'Should match your bank/card statement once every transaction through this account is entered and approved.'
        : 'Balance of all posted activity in this account.')) : el('span'),
    ledgerHead,
    filtered.length
      ? el('div', { class: 'card', style: 'padding:0' }, table)
      : el('p', { class: 'sub' }, 'No transactions match these filters.'),
  );
  // Pin the column header just below the sticky head — its height varies with how many
  // account chips wrap, so measure it and expose it to CSS (full-page adds the 53px topbar).
  requestAnimationFrame(() => {
    const h = ledgerHead.offsetHeight || 0;
    table.style.setProperty('--lhead', (53 + h) + 'px');
    table.style.setProperty('--lhead-mdi', h + 'px');
  });
}

function confirmVoid(t) {
  if (t.reconciledIn) { toast('Reconciled transactions cannot be voided — the period is closed. Use a correcting journal entry instead.', 'err'); return; }
  const locks = new Set(entities('lock').map(l => l.id));
  if (locks.has(periodKey(t.date))) { toast(`Period ${periodKey(t.date)} is locked — unlock it in Settings first`, 'err'); return; }
  const m = modal('Void this transaction?');
  m.body.append(
    el('p', {}, `${t.date} · ${t.payee || 'no payee'} — voiding keeps the record but removes it from every balance and report. This is the only way to undo a posted entry.`),
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Keep it'),
      el('button', { class: 'btn', style: 'background:var(--red)', onclick: () => {
        dispatch({ op: 'entity.upsert', kind: 'txn', value: voidTxn(t, Date.now()) });
        logAudit('void', { summary: `Voided ${t.date} · ${t.payee || 'no payee'}`, kind: 'txn', entityId: t.id, amountCents: describe(t).amount });
        toast('Transaction voided');
        m.close();
      } }, 'Void')),
  );
}

function confirmDelete(t) {
  if (t.reconciledIn) { toast('Reconciled transactions cannot be deleted', 'err'); return; }
  const locks = new Set(entities('lock').map(l => l.id));
  if (locks.has(periodKey(t.date))) { toast(`Period ${periodKey(t.date)} is locked — reopen it in Settings first`, 'err'); return; }
  const linkedStaged = entities('staged').find(s => s.txnId === t.id);
  const linkedPurchase = entities('purchase').find(p => p.txnId === t.id);
  const linkedItem = linkedPurchase ? entities('item').find(i => i.id === linkedPurchase.itemId) : null;
  const m = modal('Delete this transaction?');
  m.body.append(
    el('p', {}, `${t.date} · ${t.payee || 'no payee'} — this permanently removes the entry.${t.status === 'void' ? '' : ' Use Void instead if you want to keep a record.'}`),
    linkedStaged ? el('p', { class: 'sub' }, 'The imported bank row it was posted from returns to Review as pending, so you can re-categorize and re-approve it.') : null,
    linkedPurchase ? el('p', { class: 'sub' }, `This was an inventory restock — deleting it also removes the purchase record${linkedItem ? ` and reduces “${linkedItem.name}” on-hand by ${linkedPurchase.qty}` : ''}.`) : null,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', style: 'background:var(--red)', onclick: () => {
        dispatch({ op: 'entity.delete', kind: 'txn', id: t.id });
        logAudit('delete', { summary: `Deleted ${t.date} · ${t.payee || 'no payee'}`, kind: 'txn', entityId: t.id, amountCents: describe(t).amount });
        // Revert the associated staged row (if any) so it can be re-approved
        const staged = entities('staged').find(s => s.txnId === t.id);
        if (staged) dispatch({ op: 'entity.upsert', kind: 'staged', value: { ...staged, status: 'pending', txnId: null, categoryId: null } });
        // Inventory restock: remove the purchase record and undo its on-hand qty so nothing is orphaned.
        if (linkedPurchase) {
          dispatch({ op: 'entity.delete', kind: 'purchase', id: linkedPurchase.id });
          if (linkedItem && typeof linkedItem.qtyOnHand === 'number') {
            dispatch({ op: 'entity.upsert', kind: 'item', value: { ...linkedItem, qtyOnHand: linkedItem.qtyOnHand - (linkedPurchase.qty || 0) } });
          }
        }
        toast('Transaction deleted');
        m.close();
      } }, 'Delete permanently')),
  );
}

// Edit payee, memo, date; category (non-bank line) for non-reconciled simple txns.
// Exported so other views (e.g. Reports drill-downs) can open the same editor.
export function editTxnModal(t) {
  const isRecon = !!t.reconciledIn;
  const m = modal(isRecon ? 'Edit transaction (reconciled)' : 'Edit transaction');
  const byId = new Map(entities('account').map(a => [a.id, a]));

  // Identify lines for a simple 2-line txn
  const isSimple = t.lines.length === 2;
  const bankLine = isSimple ? t.lines.find(l => { const a = byId.get(l.accountId); return a && bankish(a); }) : null;
  const catLine = isSimple && bankLine ? t.lines.find(l => l !== bankLine) : null;

  const date = el('input', { class: 'field-input', type: 'date', value: t.date, disabled: isRecon });
  const payee = el('input', { class: 'field-input', value: t.payee || '', placeholder: 'Who?' });
  const memo = el('input', { class: 'field-input', value: t.memo || '', placeholder: 'Notes (optional)' });
  bindSuggest(payee, 'payee'); bindSuggest(memo, 'memo');

  // The category (non-bank) line can be re-pointed even when reconciled: reconciliation
  // tracks the BANK line only (see reconcile.js bankLineCents), so changing the
  // expense/income account never moves a reconciled balance. A transfer's "other side"
  // IS a bank account, so that one stays locked while reconciled.
  const catIsBank = catLine && bankish(byId.get(catLine.accountId));
  let catSel = null;
  if (catLine && (!isRecon || !catIsBank)) {
    catSel = accountCombo({ filter: (a) => !bankish(a), selected: catLine.accountId });
    catSel.style.cssText = 'display:block;width:100%';
  }

  // Manual vendor assignment (Option B) — metadata only, so allowed even when reconciled.
  const vendSel = vendorSelectEl(t.vendorId);

  // Invoice tag (per-invoice margin) — only when this business uses invoices. Metadata only.
  const useInv = usesInvoices();
  const invSel = useInv ? invoiceCombo({ selected: t.invoiceId || '' }) : null;
  if (invSel) invSel.style.cssText = 'display:block;width:100%';

  m.body.append(
    isRecon ? el('p', { class: 'sub' }, catSel
      ? '⚠️ Reconciled — the date and amount stay locked (changing them would move the reconciled balance), but you can still update the account, vendor, payee, and memo.'
      : '⚠️ This transaction is reconciled — the date, accounts, and amounts are locked. You can still update the payee, vendor, and memo.') : null,
    el('label', { class: 'field-label' }, 'Date'), date,
    el('label', { class: 'field-label' }, 'Payee'), payee,
    el('label', { class: 'field-label' }, 'Memo / notes'), memo,
    catSel ? el('label', { class: 'field-label' }, 'Account') : null,
    catSel || null,
    el('label', { class: 'field-label' }, 'Vendor'), vendSel,
    invSel ? el('label', { class: 'field-label' }, 'Invoice (for margin)') : null,
    invSel || null,
    el('div', { style: 'display:flex;gap:9px;align-items:center;margin-top:12px' },
      // Delete / Void live here now (no per-row buttons). Blocked when reconciled.
      !isRecon ? el('button', { class: 'btn sm ghost', style: 'color:var(--red)', onclick: () => { m.close(); confirmDelete(t); } }, 'Delete') : el('span'),
      !isRecon ? el('button', { class: 'btn sm ghost', onclick: () => { m.close(); confirmVoid(t); } }, 'Void') : el('span'),
      el('span', { style: 'flex:1' }),
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn green', onclick: () => {
        const newDate = isRecon ? t.date : date.value;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) { toast('Bad date', 'err'); return; }
        if (catSel && catSel.value === '__new__') { toast('Pick an account', 'err'); return; }
        const newLines = (catSel && catLine)
          ? t.lines.map(l => l === catLine ? { ...l, accountId: catSel.value } : l)
          : t.lines;
        const updated = { ...t, date: newDate, payee: payee.value.trim(), memo: memo.value.trim(), lines: newLines, vendorId: vendSel.value || undefined, invoiceId: invSel ? (invSel.value || undefined) : t.invoiceId };
        const v = validateTxn(updated, ctx());
        if (!v.ok) { toast(v.error, 'err'); return; }
        dispatch({ op: 'entity.upsert', kind: 'txn', value: updated });
        logAudit('edit', { summary: `Edited ${updated.date} · ${updated.payee || 'no payee'}`, kind: 'txn', entityId: updated.id, amountCents: describe(updated).amount });
        toast('Transaction updated');
        m.close();
      } }, 'Save')),
  );
  setTimeout(() => payee.focus(), 0);
}

const today = () => new Date().toISOString().slice(0, 10);
const txnId = () => 't-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ctx = () => ({ accountsById: new Map(entities('account').map(a => [a.id, a])), locks: new Set(entities('lock').map(l => l.id)) });

// Type-to-search vendor picker with an inline "＋ Add vendor…" that auto-selects the new one.
function vendorSelectEl(selected = '') {
  const cb = vendorCombo({ selected });
  cb.style.cssText = 'display:block;width:100%';
  return cb;
}

function addTxnModal() {
  const m = modal('Add transaction');
  let direction = 'out';
  const dirOut = el('button', { class: 'btn sm', type: 'button' }, 'Money out');
  const dirIn = el('button', { class: 'btn sm ghost', type: 'button' }, 'Money in');
  const setDir = (d) => {
    direction = d;
    dirOut.className = d === 'out' ? 'btn sm' : 'btn sm ghost';
    dirIn.className = d === 'in' ? 'btn sm' : 'btn sm ghost';
    rebuildCatOptions();
  };
  dirOut.addEventListener('click', () => setDir('out'));
  dirIn.addEventListener('click', () => setDir('in'));

  const date = el('input', { class: 'field-input', type: 'date', value: today() });
  const amount = el('input', { class: 'field-input', placeholder: '$0.00', inputmode: 'decimal' });
  const payee = el('input', { class: 'field-input', placeholder: 'Who?' });
  const banks = entities('account').filter(a => a.active !== false && bankish(a));
  const bank = accountCombo({ filter: bankish, selected: banks[0]?.id || '' });
  bank.style.cssText = 'display:block;width:100%';
  const checkNo = el('input', { class: 'field-input', placeholder: 'optional' });
  const vendor = vendorSelectEl();
  const memo = el('input', { class: 'field-input', placeholder: 'optional' });
  bindSuggest(payee, 'payee'); bindSuggest(memo, 'memo');

  // ── account / split section ──
  // One account line behaves exactly like a simple transaction. "＋ Add split" turns
  // the single Account into several lines that each take part of the amount; the
  // leftover auto-fills the new line so it always balances back to the total.
  const catPred = (a) => !bankish(a) && (direction === 'out' ? a.type !== 'income' : a.type !== 'expense' && a.type !== 'cogs');
  const splitBox = el('div');
  const remindEl = el('div', { class: 'split-remind', hidden: true });
  const lines = [];
  const totalCents = () => parseMoney(amount.value) || 0;
  const assignedCents = () => lines.reduce((s, l) => s + (parseMoney(l.amt.value) || 0), 0);
  function recalcSplit() {
    const multi = lines.length > 1;
    remindEl.hidden = !multi;
    if (!multi) return;
    const left = totalCents() - assignedCents();
    const ok = left === 0 && totalCents() > 0;
    remindEl.className = 'split-remind ' + (ok ? 'ok' : 'bad');
    clear(remindEl).append(
      el('span', {}, ok ? 'Balanced' : 'Remaining to assign'),
      el('span', {}, ok ? fmtMoney(totalCents()) + ' ✓' : fmtMoney(left)));
  }
  const makeLine = (selVal, amtVal) => {
    const sel = accountCombo({ filter: catPred, selected: selVal || '', minWidth: 0 });
    sel.style.cssText = 'flex:2;min-width:0;margin:0';
    const amt = el('input', { class: 'field-input', placeholder: '$', inputmode: 'decimal', style: 'flex:1;min-width:0;margin:0', value: amtVal || '' });
    amt.addEventListener('input', recalcSplit);
    return { sel, amt };
  };
  // Money-in/out flips which accounts are offered (catPred reads `direction` live);
  // refresh() re-evaluates each line's option list while keeping its current pick.
  const rebuildCatOptions = () => { for (const l of lines) l.sel.refresh(); };
  const renderSplit = () => {
    const multi = lines.length > 1;
    clear(splitBox);
    lines.forEach((l, i) => {
      const cells = [l.sel];
      if (multi) cells.push(l.amt, el('button', { class: 'iconbtn', type: 'button', title: 'Remove', onclick: () => { lines.splice(i, 1); renderSplit(); recalcSplit(); } }, '×'));
      splitBox.append(el('div', { style: 'display:flex;gap:7px;align-items:center;margin-bottom:6px' }, ...cells));
    });
    recalcSplit();
  };
  const addSplit = el('button', { class: 'btn sm ghost', type: 'button', onclick: () => {
    if (lines.length === 1 && !parseMoney(lines[0].amt.value)) lines[0].amt.value = totalCents() ? (totalCents() / 100).toFixed(2) : '';
    const left = totalCents() - assignedCents();
    lines.push(makeLine('', left > 0 ? (left / 100).toFixed(2) : ''));
    renderSplit();
  } }, '＋ Add split');
  amount.addEventListener('input', recalcSplit);
  lines.push(makeLine('', ''));
  renderSplit();

  m.body.append(
    el('div', { style: 'display:flex;gap:8px;margin-bottom:12px' }, dirOut, dirIn),
    el('div', { class: 'f2' },
      el('div', {}, el('label', { class: 'field-label' }, 'Date'), date),
      el('div', {}, el('label', { class: 'field-label' }, 'Amount'), amount)),
    el('label', { class: 'field-label' }, 'Payee'), payee,
    el('div', { class: 'f2' },
      el('div', {}, el('label', { class: 'field-label' }, 'Account (paid from / into)'), bank),
      el('div', {}, el('label', { class: 'field-label' }, 'Check #'), checkNo)),
    el('label', { class: 'field-label' }, 'Account'), splitBox, addSplit, remindEl,
    el('label', { class: 'field-label' }, 'Vendor (optional)'), vendor,
    el('label', { class: 'field-label' }, 'Memo'), memo,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn green', onclick: () => {
        const cents = parseMoney(amount.value);
        if (!cents || cents <= 0) { toast('Enter an amount like 84.17', 'err'); return; }
        if (!bank.value) { toast('Pick the account paid from / into', 'err'); return; }
        const cats = [];
        for (const l of lines) {
          if (!l.sel.value || l.sel.value === '__new__') { toast('Pick an account for each line', 'err'); return; }
          const amt = lines.length > 1 ? (parseMoney(l.amt.value) || 0) : cents;
          if (amt <= 0) { toast('Enter an amount for each split line', 'err'); return; }
          cats.push({ accountId: l.sel.value, amountCents: amt });
        }
        if (lines.length > 1) {
          const sum = cats.reduce((s, c) => s + c.amountCents, 0);
          if (sum !== cents) { toast(`Splits add up to ${fmtMoney(sum)} — they must total ${fmtMoney(cents)}`, 'err'); return; }
        }
        let txn;
        if (lines.length === 1) {
          txn = simpleTxn({ id: txnId(), date: date.value, payee: payee.value.trim(), memo: memo.value.trim(), checkNo: checkNo.value.trim(), amountCents: cents, direction, bankAccountId: bank.value, categoryAccountId: cats[0].accountId });
        } else {
          const txnLines = [{ accountId: bank.value, amountCents: direction === 'out' ? -cents : cents },
            ...cats.map(c => ({ accountId: c.accountId, amountCents: direction === 'out' ? c.amountCents : -c.amountCents }))];
          txn = { id: txnId(), date: date.value, payee: payee.value.trim(), memo: memo.value.trim(), checkNo: checkNo.value.trim(), lines: txnLines, status: 'posted', source: { app: 'manual' } };
        }
        if (vendor.value) txn.vendorId = vendor.value;
        const v = validateTxn(txn, ctx());
        if (!v.ok) { toast(v.error, 'err'); return; }
        dispatch({ op: 'entity.upsert', kind: 'txn', value: txn });
        const summary = lines.length === 1
          ? `${direction === 'out' ? 'Paid' : 'Received'} ${fmtMoney(cents)} · ${payee.value.trim() || '—'} → ${acctName(cats[0].accountId)}`
          : `${direction === 'out' ? 'Paid' : 'Received'} ${fmtMoney(cents)} · ${payee.value.trim() || '—'} → split across ${cats.length} accounts`;
        logAudit('post', { summary, kind: 'txn', entityId: txn.id, amountCents: direction === 'out' ? -cents : cents });
        toast('Saved to the ledger');
        m.close();
      } }, 'Save to ledger')),
  );
  setTimeout(() => amount.focus(), 0);
}

function journalModal() {
  const m = modal('Journal entry');
  const date = el('input', { class: 'field-input', type: 'date', value: today() });
  const memo = el('input', { class: 'field-input', placeholder: 'e.g. Opening balances' });
  bindSuggest(memo, 'memo');
  const linesBox = el('div');
  const totals = el('div', { style: 'font-weight:800;padding:8px 0;border-top:2px solid var(--line);display:flex;justify-content:space-between' });
  const lines = [];

  const addLine = () => {
    const acct = accountCombo({ filter: () => true, includeNone: true, noneLabel: '— account —', minWidth: 0 });
    acct.style.cssText = 'flex:2;margin:0;min-width:0';
    const debit = el('input', { class: 'field-input', placeholder: 'Debit', inputmode: 'decimal', style: 'flex:1;margin:0;min-width:0' });
    const credit = el('input', { class: 'field-input', placeholder: 'Credit', inputmode: 'decimal', style: 'flex:1;margin:0;min-width:0' });
    for (const i of [debit, credit]) i.addEventListener('input', recalc);
    acct.addEventListener('change', recalc);
    const entry = { acct, debit, credit };
    const rm = el('button', { class: 'iconbtn', type: 'button', title: 'Remove line', onclick: () => { const i = lines.indexOf(entry); if (i >= 0) lines.splice(i, 1); row.remove(); recalc(); } }, '×');
    const row = el('div', { style: 'display:flex;gap:8px;margin-bottom:8px' }, acct, debit, credit, rm);
    lines.push(entry);
    linesBox.append(row);
  };

  const recalc = () => {
    let d = 0, c = 0;
    for (const l of lines) { d += parseMoney(l.debit.value) || 0; c += parseMoney(l.credit.value) || 0; }
    const ok = d > 0 && d === c;
    totals.replaceChildren(
      el('span', {}, ok ? 'Balanced ✓' : `Debits ${fmtMoney(d)} · Credits ${fmtMoney(c)}`),
      el('span', { style: ok ? 'color:var(--green)' : 'color:var(--red)' }, ok ? fmtMoney(d) : 'must match'));
    post.disabled = !ok;
  };

  // Fill the difference into the first blank line (or the last line) so debits = credits.
  const autoBalance = () => {
    let d = 0, c = 0;
    for (const l of lines) { d += parseMoney(l.debit.value) || 0; c += parseMoney(l.credit.value) || 0; }
    const diff = d - c;
    if (diff === 0) { recalc(); return; }
    const target = lines.find(l => !parseMoney(l.debit.value) && !parseMoney(l.credit.value)) || lines[lines.length - 1];
    if (!target) return;
    if (diff > 0) { target.credit.value = (diff / 100).toFixed(2); target.debit.value = ''; }
    else { target.debit.value = (Math.abs(diff) / 100).toFixed(2); target.credit.value = ''; }
    recalc();
  };

  const post = el('button', { class: 'btn green', disabled: true, onclick: () => {
    const txnLines = [];
    for (const l of lines) {
      const d = parseMoney(l.debit.value) || 0, c = parseMoney(l.credit.value) || 0;
      if (!l.acct.value || (d === 0 && c === 0)) continue;
      txnLines.push({ accountId: l.acct.value, amountCents: d - c });
    }
    const txn = { id: txnId(), date: date.value, payee: '', memo: memo.value.trim(), lines: txnLines, status: 'posted', source: { app: 'manual' } };
    const v = validateTxn(txn, ctx());
    if (!v.ok) { toast(v.error, 'err'); return; }
    dispatch({ op: 'entity.upsert', kind: 'txn', value: txn });
    logAudit('post', { summary: `Journal entry · ${memo.value.trim() || '(no memo)'}`, kind: 'txn', entityId: txn.id });
    toast('Journal entry posted');
    m.close();
  } }, 'Post entry');

  addLine(); addLine();
  recalc();
  m.body.append(
    el('p', { class: 'sub' }, 'The accountant tool — for opening balances and corrections. Debits and credits must match before it will post.'),
    el('div', { class: 'f2' },
      el('div', {}, el('label', { class: 'field-label' }, 'Date'), date),
      el('div', {}, el('label', { class: 'field-label' }, 'Memo'), memo)),
    linesBox,
    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
      el('button', { class: 'btn sm ghost', type: 'button', onclick: () => { addLine(); recalc(); } }, '＋ Add line'),
      el('button', { class: 'btn sm ghost', type: 'button', onclick: autoBalance }, 'Auto-balance')),
    totals,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'), post),
  );
}
