// ── view: ledger — posted transactions, manual entry, journal entries ────────────────
import { el, clear, toast, modal, fmtMoney } from '../ui.js';
import { entities, subscribe, usesInvoices } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { parseMoney } from '../lib/money.js';
import { validateTxn, simpleTxn, voidTxn, periodKey } from '../lib/posting.js';
import { accountLabel } from '../lib/coa-templates.js';
import { vendorMatches } from './vendors.js';

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

const flt = { q: '', from: '', to: '', accountId: '', vendorId: '', source: '' };
const sort = { key: 'date', dir: 'desc' };
const resetFilters = () => { Object.assign(flt, { q: '', from: '', to: '', accountId: '', vendorId: '', source: '' }); sort.key = 'date'; sort.dir = 'desc'; };

export function render(root) {
  const editable = canEdit(getActiveBiz());
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
}

export function unmount() { unsub?.(); unsub = null; resetFilters(); }

// The filter bar is rendered ONCE and persists; only the table re-renders on change.
function filterBar(redraw) {
  const byId = new Map(entities('account').map(a => [a.id, a]));
  const accts = entities('account').filter(a => a.active !== false).sort((a, b) => accountLabel(a, byId).localeCompare(accountLabel(b, byId)));
  const vendors = entities('vendor').slice().sort((a, b) => a.name.localeCompare(b.name));
  const search = el('input', { class: 'field-input', placeholder: 'Search payee / memo…', value: flt.q, style: 'max-width:190px', oninput: (e) => { flt.q = e.target.value; redraw(); } });
  const from = el('input', { class: 'field-input', type: 'date', value: flt.from, style: 'max-width:150px', title: 'From date', onchange: (e) => { flt.from = e.target.value; redraw(); } });
  const to = el('input', { class: 'field-input', type: 'date', value: flt.to, style: 'max-width:150px', title: 'To date', onchange: (e) => { flt.to = e.target.value; redraw(); } });
  const acct = el('select', { class: 'field-input', style: 'max-width:175px', onchange: (e) => { flt.accountId = e.target.value; redraw(); } },
    el('option', { value: '' }, 'All accounts'), ...accts.map(a => el('option', { value: a.id, selected: a.id === flt.accountId }, accountLabel(a, byId))));
  const vend = el('select', { class: 'field-input', style: 'max-width:160px', onchange: (e) => { flt.vendorId = e.target.value; redraw(); } },
    el('option', { value: '' }, 'All vendors'), ...vendors.map(v => el('option', { value: v.id, selected: v.id === flt.vendorId }, v.name)));
  const src = el('select', { class: 'field-input', style: 'max-width:140px', onchange: (e) => { flt.source = e.target.value; redraw(); } },
    el('option', { value: '' }, 'All sources'), ...Object.keys(SOURCE_TAGS).map(k => el('option', { value: k, selected: k === flt.source }, SOURCE_TAGS[k].label)));
  const clear = el('button', { class: 'btn sm ghost', onclick: () => {
    resetFilters();
    search.value = ''; from.value = ''; to.value = ''; acct.value = ''; vend.value = ''; src.value = '';
    redraw();
  } }, 'Clear');
  return el('div', { class: 'no-print', style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px' },
    search, from, to, acct, vend, src, clear);
}

function applyFilters(txns) {
  const q = flt.q.trim().toLowerCase();
  const vendor = flt.vendorId ? entities('vendor').find(v => v.id === flt.vendorId) : null;
  return txns.filter(t => {
    if (flt.from && t.date < flt.from) return false;
    if (flt.to && t.date > flt.to) return false;
    if (flt.accountId && !(t.lines || []).some(l => l.accountId === flt.accountId)) return false;
    if (flt.source && (t.source?.app || '') !== flt.source) return false;
    if (vendor && !(t.vendorId === vendor.id || (!t.vendorId && vendorMatches(vendor, t.payee)))) return false;
    if (q && !`${t.payee || ''} ${t.memo || ''} ${t.checkNo || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

const sortAmt = (t) => { const d = describe(t); return d.amount == null ? 0 : d.amount; };
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

function drawTable(host, editable) {
  const allTxns = entities('txn').filter(t => t.status === 'posted' || t.status === 'void');
  if (!allTxns.length) {
    clear(host).append(el('p', { class: 'sub' }, 'No transactions yet — add one above, or import a CSV from Banking.'));
    return;
  }
  const filtered = applySort(applyFilters(allTxns));
  const txns = filtered.slice(0, 200);
  const rows = txns.map(t => {
    const d = describe(t);
    const isVoid = t.status === 'void';
    const isRecon = !!t.reconciledIn;
    const actions = [];
    if (editable) {
      if (!isVoid) actions.push(el('button', { class: 'linklike', onclick: () => editTxnModal(t) }, 'Edit'));
      // Delete is offered on voided rows too (purge a dead record); blocked only when reconciled.
      if (!isRecon) actions.push(el('button', { class: 'linklike', onclick: () => confirmDelete(t) }, 'Delete'));
      if (!isVoid) actions.push(el('button', { class: 'linklike', onclick: () => confirmVoid(t) }, 'Void'));
    }
    return el('tr', { style: isVoid ? 'opacity:.45' : '' },
      el('td', {}, t.date),
      el('td', {}, el('b', {}, t.payee || '—'), t.memo ? el('span', { style: 'color:var(--mut)' }, ` · ${t.memo}`) : '', t.checkNo ? el('span', { style: 'color:var(--mut)' }, ` · #${t.checkNo}`) : ''),
      el('td', {}, d.category),
      el('td', {},
        el('span', { class: `pill ${isVoid ? 'gray' : sourceTag(t.source?.app).cls}` }, isVoid ? 'Void' : sourceTag(t.source?.app).label),
        isRecon ? el('span', { class: 'pill gray', title: 'Amounts and accounts are locked — reconciled in a closed period', style: 'margin-left:4px' }, 'Reconciled') : ''),
      el('td', { class: 'num ' + (d.amount > 0 ? 'pos' : d.amount < 0 ? 'neg' : '') }, d.amount == null ? '—' : fmtMoney(d.amount, { sign: d.amount > 0 })),
      el('td', { style: 'white-space:nowrap' }, ...actions.flatMap((a, i) => i ? [' · ', a] : [a])),
    );
  });
  const th = (key, label, cls) => el('th', { class: cls || '', style: 'cursor:pointer;user-select:none', title: 'Click to sort', onclick: () => { setSort(key); drawTable(host, editable); } }, label + arrow(key));
  clear(host).append(
    el('p', { class: 'sub', style: 'margin:0 0 8px' },
      `${filtered.length} of ${allTxns.length} transaction${allTxns.length === 1 ? '' : 's'}${filtered.length > 200 ? ' · showing the first 200 — narrow the filters to see the rest' : ''}`),
    filtered.length
      ? el('div', { class: 'card', style: 'padding:0;overflow:hidden' },
          el('table', { class: 'data' },
            el('tr', {}, th('date', 'Date'), th('payee', 'Payee / memo'), th('category', 'Category'), el('th', {}, 'Source'), th('amount', 'Amount', 'num'), el('th', {}, '')),
            ...rows))
      : el('p', { class: 'sub' }, 'No transactions match these filters.'),
  );
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
function editTxnModal(t) {
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

  const catSel = (!isRecon && catLine)
    ? el('select', { class: 'field-input' },
        ...entities('account')
          .filter(a => a.active !== false && !bankish(a))
          .sort((a, b) => (a.type + accountLabel(a, byId)).localeCompare(b.type + accountLabel(b, byId)))
          .map(a => el('option', { value: a.id, selected: a.id === catLine.accountId }, accountLabel(a, byId))))
    : null;

  // Manual vendor assignment (Option B) — metadata only, so allowed even when reconciled.
  const vendors = entities('vendor').slice().sort((a, b) => a.name.localeCompare(b.name));
  const vendSel = el('select', { class: 'field-input' },
    el('option', { value: '' }, '— none —'),
    ...vendors.map(v => el('option', { value: v.id, selected: v.id === t.vendorId }, v.name)));

  // Invoice tag (per-invoice margin) — only when this business uses invoices. Metadata only.
  const useInv = usesInvoices();
  const invoices = useInv ? entities('invoice').slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')) : [];
  const invSel = useInv ? el('select', { class: 'field-input' },
    el('option', { value: '' }, '— none —'),
    ...invoices.map(i => el('option', { value: i.id, selected: i.id === t.invoiceId }, `#${i.number || i.id} · ${(i.clientName || '').slice(0, 24)}`))) : null;

  m.body.append(
    isRecon ? el('p', { class: 'sub' }, '⚠️ This transaction is reconciled — the date, accounts, and amounts are locked. You can still update the payee and memo.') : null,
    el('label', { class: 'field-label' }, 'Date'), date,
    el('label', { class: 'field-label' }, 'Payee'), payee,
    el('label', { class: 'field-label' }, 'Memo / notes'), memo,
    catSel ? el('label', { class: 'field-label' }, 'Category') : null,
    catSel || null,
    vendors.length ? el('label', { class: 'field-label' }, 'Vendor') : null,
    vendors.length ? vendSel : null,
    invSel ? el('label', { class: 'field-label' }, 'Invoice (for margin)') : null,
    invSel || null,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: () => {
        const newDate = isRecon ? t.date : date.value;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) { toast('Bad date', 'err'); return; }
        const newLines = (!isRecon && catSel && catLine)
          ? t.lines.map(l => l === catLine ? { ...l, accountId: catSel.value } : l)
          : t.lines;
        const updated = { ...t, date: newDate, payee: payee.value.trim(), memo: memo.value.trim(), lines: newLines, vendorId: vendSel.value || undefined, invoiceId: invSel ? (invSel.value || undefined) : t.invoiceId };
        const v = validateTxn(updated, ctx());
        if (!v.ok) { toast(v.error, 'err'); return; }
        dispatch({ op: 'entity.upsert', kind: 'txn', value: updated });
        toast('Transaction updated');
        m.close();
      } }, 'Save')),
  );
  setTimeout(() => payee.focus(), 0);
}

const today = () => new Date().toISOString().slice(0, 10);
const txnId = () => 't-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ctx = () => ({ accountsById: new Map(entities('account').map(a => [a.id, a])), locks: new Set(entities('lock').map(l => l.id)) });

function accountOptions(filter, selected) {
  const byId = new Map(entities('account').map(a => [a.id, a]));
  return entities('account')
    .filter(a => a.active !== false && filter(a))
    .sort((a, b) => a.type.localeCompare(b.type) || accountLabel(a, byId).localeCompare(accountLabel(b, byId)))
    .map(a => el('option', { value: a.id, selected: a.id === selected }, accountLabel(a, byId)));
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
    redrawCategory();
  };
  dirOut.addEventListener('click', () => setDir('out'));
  dirIn.addEventListener('click', () => setDir('in'));

  const date = el('input', { class: 'field-input', type: 'date', value: today() });
  const amount = el('input', { class: 'field-input', placeholder: '$0.00', inputmode: 'decimal' });
  const payee = el('input', { class: 'field-input', placeholder: 'Who?' });
  const bank = el('select', { class: 'field-input' }, ...accountOptions(bankish));
  const checkNo = el('input', { class: 'field-input', placeholder: 'optional' });
  const category = el('select', { class: 'field-input' });
  const redrawCategory = () => {
    clear(category).append(...accountOptions(a => !bankish(a) && (direction === 'out' ? a.type !== 'income' : a.type !== 'expense' && a.type !== 'cogs')));
  };
  redrawCategory();
  const memo = el('input', { class: 'field-input', placeholder: 'optional' });

  m.body.append(
    el('div', { style: 'display:flex;gap:8px;margin-bottom:12px' }, dirOut, dirIn),
    el('div', { class: 'f2' },
      el('div', {}, el('label', { class: 'field-label' }, 'Date'), date),
      el('div', {}, el('label', { class: 'field-label' }, 'Amount'), amount)),
    el('label', { class: 'field-label' }, 'Payee'), payee,
    el('div', { class: 'f2' },
      el('div', {}, el('label', { class: 'field-label' }, 'Account (paid from / into)'), bank),
      el('div', {}, el('label', { class: 'field-label' }, 'Check #'), checkNo)),
    el('label', { class: 'field-label' }, 'Category'), category,
    el('label', { class: 'field-label' }, 'Memo'), memo,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn green', onclick: () => {
        const cents = parseMoney(amount.value);
        if (!cents || cents <= 0) { toast('Enter an amount like 84.17', 'err'); return; }
        if (!bank.value || !category.value) { toast('Pick the accounts', 'err'); return; }
        const txn = simpleTxn({
          id: txnId(), date: date.value, payee: payee.value.trim(), memo: memo.value.trim(),
          checkNo: checkNo.value.trim(), amountCents: cents, direction,
          bankAccountId: bank.value, categoryAccountId: category.value,
        });
        const v = validateTxn(txn, ctx());
        if (!v.ok) { toast(v.error, 'err'); return; }
        dispatch({ op: 'entity.upsert', kind: 'txn', value: txn });
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
  const linesBox = el('div');
  const totals = el('div', { style: 'font-weight:800;padding:8px 0;border-top:2px solid var(--line);display:flex;justify-content:space-between' });
  const lines = [];

  const addLine = () => {
    const acct = el('select', { class: 'field-input', style: 'flex:2;margin:0' }, el('option', { value: '' }, '— account —'), ...accountOptions(() => true));
    const debit = el('input', { class: 'field-input', placeholder: 'Debit', inputmode: 'decimal', style: 'flex:1;margin:0' });
    const credit = el('input', { class: 'field-input', placeholder: 'Credit', inputmode: 'decimal', style: 'flex:1;margin:0' });
    for (const i of [debit, credit]) i.addEventListener('input', recalc);
    acct.addEventListener('change', recalc);
    lines.push({ acct, debit, credit });
    linesBox.append(el('div', { style: 'display:flex;gap:8px;margin-bottom:8px' }, acct, debit, credit));
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
    el('button', { class: 'btn sm ghost', onclick: () => { addLine(); recalc(); } }, 'Add line'),
    totals,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'), post),
  );
}
