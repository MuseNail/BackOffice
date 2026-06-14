// ── view: ledger — posted transactions, manual entry, journal entries ────────────────
import { el, clear, toast, modal, fmtMoney } from '../ui.js';
import { entities, subscribe } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { parseMoney } from '../lib/money.js';
import { validateTxn, simpleTxn, voidTxn, periodKey } from '../lib/posting.js';
import { accountLabel } from '../lib/coa-templates.js';

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

export function render(root) {
  const editable = canEdit(getActiveBiz());
  const body = el('div');
  root.append(
    el('h2', {}, 'Ledger'),
    el('p', { class: 'sub' }, 'Every posted transaction. Void keeps the record but zeroes it out of balances. Delete permanently removes it (blocked once reconciled). Edit updates payee, memo, or category.'),
    editable ? el('div', { style: 'display:flex;gap:9px;margin-bottom:14px' },
      el('button', { class: 'btn sm', onclick: addTxnModal }, 'Add transaction'),
      el('button', { class: 'btn sm ghost', onclick: journalModal }, 'Journal entry')) : el('span'),
    body,
  );
  const draw = () => drawTable(body, editable);
  unsub = subscribe(draw);
  draw();
}

export function unmount() { unsub?.(); unsub = null; }

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

function drawTable(body, editable) {
  const allTxns = entities('txn').filter(t => t.status === 'posted' || t.status === 'void');
  const txns = allTxns.sort((a, b) => b.date.localeCompare(a.date) || (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 200);
  if (!txns.length) {
    clear(body).append(el('p', { class: 'sub' }, 'No transactions yet — add one above, or import a CSV from Banking.'));
    return;
  }
  const rows = txns.map(t => {
    const d = describe(t);
    const isVoid = t.status === 'void';
    const isRecon = !!t.reconciledIn;
    const actions = [];
    if (editable && !isVoid) {
      actions.push(el('button', { class: 'linklike', onclick: () => editTxnModal(t) }, 'Edit'));
      if (!isRecon) actions.push(el('button', { class: 'linklike', onclick: () => confirmDelete(t) }, 'Delete'));
      actions.push(el('button', { class: 'linklike', onclick: () => confirmVoid(t) }, 'Void'));
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
  clear(body).append(
    allTxns.length > 200 ? el('p', { class: 'sub' }, `Showing the 200 most recent of ${allTxns.length} transactions — use Reports for date-range views.`) : el('span'),
    el('div', { class: 'card', style: 'padding:0;overflow:hidden' },
      el('table', { class: 'data' },
        el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Payee / memo'), el('th', {}, 'Category'), el('th', {}, 'Source'), el('th', { class: 'num' }, 'Amount'), el('th', {}, '')),
        ...rows)));
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
  const m = modal('Delete this transaction?');
  m.body.append(
    el('p', {}, `${t.date} · ${t.payee || 'no payee'} — this permanently removes the entry. Use Void instead if you want to keep a record.`),
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', style: 'background:var(--red)', onclick: () => {
        dispatch({ op: 'entity.delete', kind: 'txn', id: t.id });
        // Revert the associated staged row (if any) so it can be re-approved
        const staged = entities('staged').find(s => s.txnId === t.id);
        if (staged) dispatch({ op: 'entity.upsert', kind: 'staged', value: { ...staged, status: 'pending', txnId: null, categoryId: null } });
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

  m.body.append(
    isRecon ? el('p', { class: 'sub' }, '⚠️ This transaction is reconciled — the date, accounts, and amounts are locked. You can still update the payee and memo.') : null,
    el('label', { class: 'field-label' }, 'Date'), date,
    el('label', { class: 'field-label' }, 'Payee'), payee,
    el('label', { class: 'field-label' }, 'Memo / notes'), memo,
    catSel ? el('label', { class: 'field-label' }, 'Category') : null,
    catSel || null,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: () => {
        const newDate = isRecon ? t.date : date.value;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) { toast('Bad date', 'err'); return; }
        const newLines = (!isRecon && catSel && catLine)
          ? t.lines.map(l => l === catLine ? { ...l, accountId: catSel.value } : l)
          : t.lines;
        const updated = { ...t, date: newDate, payee: payee.value.trim(), memo: memo.value.trim(), lines: newLines };
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
