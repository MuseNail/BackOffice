// ── view: review — approve staged bank rows into the ledger ────────────────
// Approval is THE posting moment. Suggestions come from lib/match.js (rules →
// history) then AI; the user always confirms. Special posting shapes:
//  • Transfer — category is another bank/card account: money moves between
//    accounts, no income/expense. The matching opposite row on the other
//    account is auto-marked so the transfer is never double-counted.
//  • Fee split — a deposit where the processor kept a cut: posts gross income,
//    the fee as its own expense, and the net into the bank, in one balanced txn.
import { el, clear, toast, fmtMoney, modal } from '../ui.js';
import { entities, subscribe, getState, usesInvoices } from '../store.js';
import { dispatch, api } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { validateTxn, simpleTxn } from '../lib/posting.js';
import { suggestFor, guessVendorName } from '../lib/match.js';
import { accountLabel } from '../lib/coa-templates.js';
import { parseMoney } from '../lib/money.js';
import { MUSE_SYNC_TYPES } from '../lib/musesync.js';
import { helcimDayTotals, ledgerDayDebits, matchDeposit } from '../lib/processor-match.js';
import { quickAddAccountModal } from './accounts.js';
import { quickAddVendorModal } from './vendors.js';

let unsub = null;
let aiSuggestions = new Map();
let aiBusy = false;
let showSkipped = false;
// Review filter/sort (bank-row sections only). dir: all|in|out · status: all|needs|ready
// · bank: all|<bankId> · sort: date-desc|date-asc|amount-desc|amount-asc.
let reviewFilter = { dir: 'all', status: 'all', bank: 'all', sort: 'date-desc' };
// Preserve per-row category selection across drawBody re-renders (store changes
// trigger a full redraw, so we save the user's pick here and restore it).
let lastCategory = new Map();

const TYPE_GROUPS = [
  ['income', 'Income'], ['asset', 'Assets'], ['liability', 'Liabilities'],
  ['equity', 'Equity'], ['cogs', 'Cost of goods'], ['expense', 'Expenses'],
  ['other-expense', 'Other expenses'], ['personal-expense', 'Personal expenses'],
];

export function render(root) {
  const editable = canEdit(getActiveBiz());
  const body = el('div');
  root.append(
    el('h2', {}, 'Review'),
    el('p', { class: 'sub' }, 'Imported transactions wait here, grouped by account. Nothing posts without your approval — and transfers between your own accounts never count as income or expense.'),
    body,
  );
  const draw = () => drawBody(body, editable);
  unsub = subscribe(draw);
  draw();
}

export function unmount() { unsub?.(); unsub = null; aiSuggestions = new Map(); aiBusy = false; showSkipped = false; lastCategory = new Map(); reviewFilter = { dir: 'all', status: 'all', bank: 'all', sort: 'date-desc' }; }

// A row is "ready" if it has a resolved category — a valid rule/history suggestion,
// an AI suggestion, or a manual pick (lastCategory). Drives the needs/ready filter.
function rowReady(row, matchCtx, accountsById) {
  if (lastCategory.get(row.id)) return true;
  const sug = suggestFor(row, matchCtx);
  if (sug && accountsById.has(sug.accountId) && accountsById.get(sug.accountId).active !== false) return true;
  const ai = aiSuggestions.get(row.id);
  return !!(ai?.accountId && accountsById.has(ai.accountId) && accountsById.get(ai.accountId).active !== false);
}
function applyReviewFilter(rows, matchCtx, accountsById) {
  const filtered = rows.filter(r => {
    if (reviewFilter.dir === 'in' && !(r.amountCents > 0)) return false;
    if (reviewFilter.dir === 'out' && !(r.amountCents < 0)) return false;
    if (reviewFilter.status === 'ready' && !rowReady(r, matchCtx, accountsById)) return false;
    if (reviewFilter.status === 'needs' && rowReady(r, matchCtx, accountsById)) return false;
    return true;
  });
  const [key, dir] = reviewFilter.sort.split('-');
  filtered.sort((a, b) => {
    const c = key === 'amount' ? (a.amountCents - b.amountCents) : a.date.localeCompare(b.date);
    return dir === 'desc' ? -c : c;
  });
  return filtered;
}

const bankish = (a) => a.qbType === 'BANK' || a.qbType === 'CCARD';

function categorySelect(row, categories, accountsById, preselect) {
  const ownAccountId = entities('bankacct').find(b => b.id === row.bankacctId)?.accountId;
  const transferTargets = entities('account')
    .filter(a => a.active !== false && bankish(a) && a.id !== ownAccountId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const groups = [];
  if (transferTargets.length) {
    groups.push(el('optgroup', { label: '↔ Transfer to / from' },
      ...transferTargets.map(a => el('option', { value: a.id, selected: a.id === preselect }, a.name))));
  }
  for (const [type, label] of TYPE_GROUPS) {
    const accts = categories.filter(a => a.type === type)
      .sort((a, b) => accountLabel(a, accountsById).localeCompare(accountLabel(b, accountsById)));
    if (!accts.length) continue;
    groups.push(el('optgroup', { label },
      // Subaccounts get a leading indent (figure-spaces) so they read as a child
      // of the account above them, not a peer category.
      ...accts.map(a => el('option', { value: a.id, selected: a.id === preselect }, (a.parentId ? '   ' : '') + accountLabel(a, accountsById)))));
  }
  const sel = el('select', { class: 'field-input', style: 'margin:0;min-width:190px' },
    el('option', { value: '' }, '— pick a category —'), ...groups,
    el('option', { value: '__new__' }, '＋ Add category…'));
  addNewCategoryIntercept(sel, preselect);
  return sel;
}

// Appends a "＋ Add category…" intercept to any <select>. When __new__ is
// chosen, the modal opens without losing the current selection; on success the
// new option is added and auto-selected, then a synthetic change event fires so
// any upstream listener (approve-button enable) picks it up.
function addNewCategoryIntercept(sel, initialValue = '') {
  let prevVal = initialValue || '';
  sel.addEventListener('change', () => {
    if (sel.value !== '__new__') { prevVal = sel.value; return; }
    sel.value = prevVal; // reset so the row looks unchanged while modal is open
    quickAddAccountModal((account) => {
      const marker = sel.querySelector('option[value="__new__"]');
      marker.before(el('option', { value: account.id }, account.name));
      sel.value = account.id;
      prevVal = account.id;
      sel.dispatchEvent(new Event('change')); // notify upstream (approve-button etc.)
    });
  });
}

// Vendor picker for a Review row — tags THIS transaction with a vendor (separate from
// the ⚡ "make a rule" flow). Inline "＋ Add vendor" creates a name-only vendor.
function vendorSelect(vendors, preselect) {
  const sel = el('select', { class: 'field-input', style: 'margin:4px 0 0;min-width:190px;font-size:.82em' },
    el('option', { value: '' }, '— vendor (optional) —'),
    ...vendors.map(v => el('option', { value: v.id, selected: v.id === preselect }, v.name)),
    el('option', { value: '__newvendor__' }, '＋ Add vendor…'));
  addNewVendorIntercept(sel, preselect);
  return sel;
}
function addNewVendorIntercept(sel, initial = '') {
  let prev = initial || '';
  sel.addEventListener('change', () => {
    if (sel.value !== '__newvendor__') { prev = sel.value; return; }
    sel.value = prev; // reset so the row looks unchanged while the modal is open
    quickAddVendorModal((vendor) => {
      const marker = sel.querySelector('option[value="__newvendor__"]');
      marker.before(el('option', { value: vendor.id }, vendor.name));
      sel.value = vendor.id;
      prev = vendor.id;
    });
  });
}
// Invoice picker for a Review row (only when the business uses invoices) — tags the
// expense to an invoice for per-invoice profit margin. Invoices newest-first.
function invoiceSelect(invoices, preselect) {
  return el('select', { class: 'field-input', style: 'margin:4px 0 0;min-width:190px;font-size:.82em' },
    el('option', { value: '' }, '— invoice (optional) —'),
    ...invoices.map(i => el('option', { value: i.id, selected: i.id === preselect }, `#${i.number || i.id} · ${(i.clientName || '').slice(0, 24)}`)));
}

function drawBody(body, editable) {
  const pending = entities('staged')
    .filter(s => s.status === 'pending')
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!pending.length) {
    clear(body).append(el('p', { class: 'sub' }, 'All caught up — nothing waiting. Import a CSV from Banking to fill this screen.'));
    return;
  }
  const accountsById = new Map(entities('account').map(a => [a.id, a]));
  const categories = entities('account').filter(a => a.active !== false && !bankish(a));
  const matchCtx = { vendors: entities('vendor'), history: entities('staged') };
  const vendorsList = entities('vendor').slice().sort((a, b) => a.name.localeCompare(b.name));
  const showInvoices = usesInvoices();
  const invoicesList = showInvoices ? entities('invoice').slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')) : [];

  const suggested = [];
  const unmatched = [];
  const rowEl = (row) => {
    let sug = suggestFor(row, matchCtx);
    if (sug && (!accountsById.has(sug.accountId) || accountsById.get(sug.accountId).active === false)) sug = null;
    if (!sug) {
      const ai = aiSuggestions.get(row.id);
      if (ai?.accountId && accountsById.has(ai.accountId) && accountsById.get(ai.accountId).active !== false) {
        sug = { accountId: ai.accountId, by: 'ai', confidence: ai.confidence };
      } else {
        unmatched.push(row);
      }
    }
    if (sug) suggested.push({ row, sug });

    const preselect = lastCategory.get(row.id) || sug?.accountId;
    const sel = categorySelect(row, categories, accountsById, preselect);
    const memoIn = el('input', { class: 'field-input', placeholder: 'Add a note…', style: 'margin:4px 0 0;font-size:.82em', value: row.memo || '' });
    const vendSel = vendorSelect(vendorsList, sug?.vendorId);
    const invSel = showInvoices ? invoiceSelect(invoicesList) : null;
    const approve = el('button', { class: 'btn sm green', disabled: !preselect, onclick: () => {
      lastCategory.delete(row.id);
      approveRow(row, sel.value, sug, { memo: memoIn.value.trim(), vendorId: vendSel.value, invoiceId: invSel?.value || '' });
    } }, 'Approve');
    sel.addEventListener('change', () => {
      if (sel.value && sel.value !== '__new__') lastCategory.set(row.id, sel.value);
      approve.disabled = !sel.value || sel.value === '__new__';
    });

    const chip = sug
      ? (sug.by === 'rule' ? el('span', { class: 'pill blue' }, `⚡ Rule · ${sug.vendorName}`)
        : sug.by === 'ai' ? el('span', { class: 'pill amber' }, `✨ AI · ${sug.confidence}%`)
        : el('span', { class: 'pill green' }, '🕘 You did this before'))
      : el('span', { class: 'pill gray' }, 'No match');

    const actions = [approve,
      el('button', { class: 'btn sm ghost', onclick: () => skipRow(row) }, 'Skip'),
      el('button', { class: 'btn sm ghost', title: 'Auto-categorize this vendor from now on', onclick: () => makeRuleModal(row, sel.value, categories, accountsById) }, '⚡')];
    if (row.amountCents > 0) {
      actions.push(el('button', { class: 'btn sm ghost', title: 'Deposit with a processing fee taken out (e.g. Helcim/Square payout)', onclick: () => feeSplitModal(row, accountsById) }, '%'));
      actions.push(el('button', { class: 'btn sm ghost', title: 'Match this deposit to your recorded sales/payments and clear the clearing account', onclick: () => matchDepositModal(row, accountsById) }, '⚡$'));
    }

    return el('tr', {},
      el('td', {}, row.date),
      el('td', {}, el('b', {}, row.desc.slice(0, 55))),
      el('td', { class: 'num ' + (row.amountCents < 0 ? 'neg' : 'pos') }, fmtMoney(row.amountCents, { sign: row.amountCents > 0 })),
      el('td', {}, editable ? el('div', {}, sel, memoIn, vendSel, invSel) : '—'),
      el('td', {}, chip),
      el('td', {}, editable ? el('div', { style: 'display:flex;gap:6px' }, ...actions) : ''),
    );
  };

  // one section per bank account (1.), after the filter/sort bar is applied
  const sections = [];
  for (const bank of entities('bankacct')) {
    if (reviewFilter.bank !== 'all' && reviewFilter.bank !== bank.id) continue;
    const allMine = applyReviewFilter(
      entities('staged').filter(r => r.bankacctId === bank.id && !r.syncApp && r.status === 'pending'),
      matchCtx, accountsById);
    const mine = allMine.slice(0, 100);
    if (!mine.length) continue;
    sections.push(el('div', { style: 'margin-bottom:18px' },
      el('div', { class: 'cardtitle', style: 'margin-bottom:8px' }, `${bank.name} `, el('span', { class: 'pill amber' }, `${mine.length} waiting`),
        allMine.length > 100 ? el('span', { class: 'pill gray', style: 'margin-left:6px' }, `showing 100 of ${allMine.length}`) : ''),
      el('div', { class: 'card', style: 'padding:0;overflow:hidden' },
        el('table', { class: 'data' },
          el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Bank description'), el('th', { class: 'num' }, 'Amount'), el('th', {}, 'Category'), el('th', {}, 'Suggested by'), el('th', {}, '')),
          ...mine.map(rowEl)))));
  }

  // Skipped rows section
  const skippedAll = entities('staged').filter(r => r.status === 'skipped');
  if (skippedAll.length) {
    const toggleLabel = showSkipped ? `Hide skipped (${skippedAll.length})` : `Show skipped (${skippedAll.length})`;
    const skippedSection = el('div', { style: 'margin-bottom:18px' },
      el('button', { class: 'btn sm ghost', style: 'margin-bottom:8px', onclick: () => { showSkipped = !showSkipped; drawBody(body, editable); } }, toggleLabel),
    );
    if (showSkipped) {
      const skippedRows = skippedAll.slice(0, 50).map(row => el('tr', {},
        el('td', {}, row.date),
        el('td', {}, row.desc?.slice(0, 55) || ''),
        el('td', { class: 'num ' + (row.amountCents < 0 ? 'neg' : 'pos') }, fmtMoney(row.amountCents, { sign: row.amountCents > 0 })),
        el('td', {}, el('span', { class: 'pill gray' }, 'Skipped')),
        el('td', {}, editable ? el('button', { class: 'btn sm ghost', onclick: () => {
          dispatch({ op: 'entity.upsert', kind: 'staged', value: { ...row, status: 'pending' } });
          toast('Restored to pending');
        } }, 'Restore') : ''),
      ));
      skippedSection.append(
        el('div', { class: 'card', style: 'padding:0;overflow:hidden' },
          el('table', { class: 'data' },
            el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Description'), el('th', { class: 'num' }, 'Amount'), el('th', {}, 'Status'), el('th', {}, '')),
            ...skippedRows)));
    }
    sections.push(skippedSection);
  }

  // Muse-synced rows (no bankacctId — they came from the salon, not a statement).
  // Each posts via the saved Muse mapping: the balancing side is fixed per type
  // in Settings; the user confirms only the category. Same approval = posting
  // rule as bank rows — sync never writes the ledger by itself.
  const museRows = pending.filter(r => r.syncApp).slice(0, 100);
  if (museRows.length) {
    const mapping = getState().meta?.museMapping || {};
    const museRowEl = (row) => {
      const t = MUSE_SYNC_TYPES[row.syncType] || { label: row.syncType };
      const balId = mapping.balancing?.[row.syncType];
      const bal = balId ? accountsById.get(balId) : null;
      const preselect = mapping.category?.[row.syncType];
      const sel = el('select', { class: 'field-input', style: 'margin:0;min-width:190px' },
        el('option', { value: '' }, '— pick a category —'),
        ...TYPE_GROUPS.map(([type, label]) => {
          const accts = categories.filter(a => a.type === type)
            .sort((a, b) => accountLabel(a, accountsById).localeCompare(accountLabel(b, accountsById)));
          return accts.length ? el('optgroup', { label }, ...accts.map(a => el('option', { value: a.id, selected: a.id === preselect }, accountLabel(a, accountsById)))) : null;
        }).filter(Boolean),
        el('option', { value: '__new__' }, '＋ Add category…'));
      addNewCategoryIntercept(sel, preselect);
      const approve = el('button', { class: 'btn sm green', disabled: !bal || !sel.value || sel.value === '__new__', onclick: () => approveSyncRow(row, sel.value) }, 'Approve');
      sel.addEventListener('change', () => { approve.disabled = !bal || !sel.value || sel.value === '__new__'; });
      return el('tr', {},
        el('td', {}, row.date),
        el('td', {}, el('b', {}, (row.desc || t.label).slice(0, 55)), row.memo ? el('div', { class: 'sub', style: 'margin:0' }, row.memo.slice(0, 80)) : ''),
        el('td', { class: 'num ' + (row.amountCents < 0 ? 'neg' : 'pos') }, fmtMoney(row.amountCents, { sign: row.amountCents > 0 })),
        el('td', {}, editable ? sel : '—'),
        el('td', {}, bal ? el('span', { class: 'pill blue' }, `↔ ${bal.name}`) : el('span', { class: 'pill red' }, 'Map in Settings')),
        el('td', {}, editable ? el('div', { style: 'display:flex;gap:6px' }, approve,
          el('button', { class: 'btn sm ghost', onclick: () => skipRow(row) }, 'Skip')) : ''),
      );
    };
    sections.push(el('div', { style: 'margin-bottom:18px' },
      el('div', { class: 'cardtitle', style: 'margin-bottom:4px' }, 'Muse — synced from the salon ', el('span', { class: 'pill amber' }, `${museRows.length} waiting`)),
      el('p', { class: 'sub', style: 'margin:0 0 8px' }, 'Each row was pushed from the Muse salon app (Settings → Integrations → Back Office). Approving posts it to your ledger using the category you pick and the balancing account set in Settings. Rows marked "Map in Settings" need a balancing account first. Nothing posts automatically.'),
      el('div', { class: 'card', style: 'padding:0;overflow:hidden' },
        el('table', { class: 'data' },
          el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'From the salon'), el('th', { class: 'num' }, 'Amount'), el('th', {}, 'Category'), el('th', {}, 'Balancing account'), el('th', {}, '')),
          ...museRows.map(museRowEl)))));
  }

  // "Approve all" covers both rule/AI/history suggestions (memorized) AND rows the
  // user has manually categorized (typed in) — anything with a resolved category.
  // A manual pick (lastCategory) overrides the suggestion for that row.
  const categorized = [
    ...suggested.map(({ row, sug }) => ({ row, accountId: lastCategory.get(row.id) || sug.accountId, sug })),
    ...unmatched.filter(row => lastCategory.get(row.id)).map(row => ({ row, accountId: lastCategory.get(row.id), sug: null })),
  ];
  const fsel = (key, opts) => el('select', { class: 'field-input', style: 'margin:0;width:auto;min-width:120px', onchange: (e) => { reviewFilter[key] = e.target.value; drawBody(body, editable); } },
    ...opts.map(([v, l]) => el('option', { value: v, selected: reviewFilter[key] === v }, l)));
  const filtersOn = reviewFilter.dir !== 'all' || reviewFilter.status !== 'all' || reviewFilter.bank !== 'all' || reviewFilter.sort !== 'date-desc';
  const filterBar = el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px' },
    el('span', { class: 'sub', style: 'margin:0' }, 'Filter'),
    fsel('dir', [['all', 'All'], ['in', 'Money in'], ['out', 'Money out']]),
    fsel('status', [['all', 'Any status'], ['needs', 'Needs a category'], ['ready', 'Ready']]),
    fsel('bank', [['all', 'All accounts'], ...entities('bankacct').map(b => [b.id, b.name])]),
    fsel('sort', [['date-desc', 'Newest first'], ['date-asc', 'Oldest first'], ['amount-desc', 'Largest first'], ['amount-asc', 'Smallest first']]),
    filtersOn ? el('button', { class: 'btn sm ghost', onclick: () => { reviewFilter = { dir: 'all', status: 'all', bank: 'all', sort: 'date-desc' }; drawBody(body, editable); } }, 'Reset') : el('span'));
  clear(body).append(
    filterBar,
    el('div', { style: 'display:flex;gap:9px;align-items:center;margin-bottom:12px;flex-wrap:wrap' },
      (editable && categorized.length) ? el('button', { class: 'btn sm green', onclick: () => {
        for (const { row, accountId, sug } of categorized) { lastCategory.delete(row.id); approveRow(row, accountId, sug, { quiet: true }); }
        toast(`${categorized.length} approved`);
      } }, `Approve all categorized (${categorized.length})`) : el('span'),
      (editable && unmatched.length && !aiBusy) ? el('button', { class: 'btn sm', onclick: () => askAI(unmatched, categories, body, editable) }, `✨ Get AI suggestions (${unmatched.length})`) : el('span'),
      aiBusy ? el('span', { class: 'pill gray' }, '✨ Asking Claude…') : el('span')),
    ...sections,
    sections.length ? el('span') : el('p', { class: 'sub' }, 'No transactions match these filters.'),
  );
}

const postCtx = () => ({
  accountsById: new Map(entities('account').map(a => [a.id, a])),
  locks: new Set(entities('lock').map(l => l.id)),
});

// Muse row → one simple txn. The balancing side comes from the saved mapping
// (Settings), the category from the user's confirmation. Direction is carried
// by the stored sign (− = out), same convention as bank rows.
function approveSyncRow(row, categoryId) {
  const mapping = getState().meta?.museMapping || {};
  const balId = mapping.balancing?.[row.syncType];
  if (!balId || !categoryId) { toast(balId ? 'Pick a category first' : 'Set the Muse mapping in Settings first', 'err'); return; }
  const txn = simpleTxn({
    id: 't-' + row.id,
    date: row.date,
    payee: row.desc,
    memo: row.memo || '',
    amountCents: Math.abs(row.amountCents),
    direction: row.amountCents < 0 ? 'out' : 'in',
    bankAccountId: balId,
    categoryAccountId: categoryId,
    source: { app: row.syncApp, sourceId: row.source?.sourceId, importId: row.importId },
  });
  const v = validateTxn(txn, postCtx());
  if (!v.ok) { toast(v.error, 'err'); return; }
  dispatch({ op: 'entity.upsert', kind: 'txn', value: txn });
  dispatch({ op: 'entity.upsert', kind: 'staged', value: { ...row, status: 'approved', txnId: txn.id, categoryId } });
  toast('Posted');
}

function approveRow(row, categoryId, sug, { quiet = false, memo = '', vendorId = '', invoiceId = '' } = {}) {
  const bankacct = entities('bankacct').find(b => b.id === row.bankacctId);
  if (!bankacct || !categoryId) { toast('Pick a category first', 'err'); return; }
  const target = entities('account').find(a => a.id === categoryId);
  const isTransfer = target && bankish(target);
  const txn = simpleTxn({
    id: 't-' + row.id,
    date: row.date,
    payee: row.desc,
    memo: isTransfer ? 'Transfer between accounts' : (memo || row.memo || ''),
    amountCents: Math.abs(row.amountCents),
    direction: row.amountCents < 0 ? 'out' : 'in',
    bankAccountId: bankacct.accountId,
    categoryAccountId: categoryId,
    source: { app: row.source?.app || 'csv', importId: row.importId, sourceId: row.id },
  });
  // Stamp the vendor (Option B) when this row matched a vendor rule and was approved
  // to that vendor's category — so the vendor's register is exact going forward.
  if (vendorId) txn.vendorId = vendorId;                                  // explicit pick wins
  else if (sug?.vendorId && sug.accountId === categoryId) txn.vendorId = sug.vendorId;
  if (invoiceId) txn.invoiceId = invoiceId;                              // tag the expense to an invoice (margin)
  const v = validateTxn(txn, postCtx());
  if (!v.ok) { toast(v.error, 'err'); return; }
  dispatch({ op: 'entity.upsert', kind: 'txn', value: txn });
  dispatch({ op: 'entity.upsert', kind: 'staged', value: { ...row, status: 'approved', txnId: txn.id, categoryId } });
  if (isTransfer) {
    // never double-count: the same transfer arrives on BOTH accounts' statements —
    // find the opposite row on the other account and retire it against this txn
    const matched = matchCounterpart(row, categoryId, txn.id);
    if (!quiet) toast(matched ? 'Transfer posted — the other account’s matching row was cleared automatically' : 'Transfer posted');
    return;
  }
  if (sug?.vendorId && sug.accountId === categoryId) {
    const vend = entities('vendor').find(x => x.id === sug.vendorId);
    if (vend) dispatch({ op: 'entity.upsert', kind: 'vendor', value: { ...vend, used: (vend.used || 0) + 1 } });
  }
  if (!quiet) toast('Posted to the ledger');
}

function matchCounterpart(row, transferAccountId, txnId) {
  const otherBank = entities('bankacct').find(b => b.accountId === transferAccountId);
  if (!otherBank) return false;
  const close = (a, b) => Math.abs(new Date(a) - new Date(b)) <= 7 * 86400000;
  const match = entities('staged').find(st =>
    st.status === 'pending' && st.bankacctId === otherBank.id &&
    st.amountCents === -row.amountCents && close(st.date, row.date));
  if (!match) return false;
  dispatch({ op: 'entity.upsert', kind: 'staged', value: { ...match, status: 'matched', txnId } });
  return true;
}

function skipRow(row) {
  dispatch({ op: 'entity.upsert', kind: 'staged', value: { ...row, status: 'skipped' } });
  toast('Skipped');
}

// deposit where the processor kept its cut: bank +net, income −gross, fee +cut
function feeSplitModal(row, accountsById) {
  const m = modal('Deposit with processing fee');
  const incomeAccts = entities('account').filter(a => a.active !== false && a.type === 'income');
  const feeAccts = entities('account').filter(a => a.active !== false && (a.type === 'expense' || a.type === 'cogs'));
  if (!incomeAccts.length || !feeAccts.length) { toast('Needs an income and an expense account', 'err'); m.close(); return; }
  const defaultFee = feeAccts.find(a => /fee|process/i.test(a.name)) || feeAccts[0];

  const gross = el('input', { class: 'field-input', inputmode: 'decimal', placeholder: 'what you actually charged customers' });
  const incomeSel = el('select', { class: 'field-input' },
    ...incomeAccts.map(a => el('option', { value: a.id }, accountLabel(a, accountsById))),
    el('option', { value: '__new__' }, '＋ Add category…'));
  addNewCategoryIntercept(incomeSel, incomeAccts[0]?.id);
  const feeSel = el('select', { class: 'field-input' },
    ...feeAccts.map(a => el('option', { value: a.id, selected: a.id === defaultFee.id }, accountLabel(a, accountsById))),
    el('option', { value: '__new__' }, '＋ Add category…'));
  addNewCategoryIntercept(feeSel, defaultFee.id);
  const feeLine = el('p', { style: 'font-weight:700' }, '');
  gross.addEventListener('input', () => {
    const g = parseMoney(gross.value);
    feeLine.textContent = g != null && g >= row.amountCents
      ? `Fee: ${fmtMoney(g - row.amountCents)} (gross ${fmtMoney(g)} − deposited ${fmtMoney(row.amountCents)})`
      : '';
  });

  m.body.append(
    el('p', { class: 'sub' }, `The bank received ${fmtMoney(row.amountCents)}. Enter the gross sales this payout covers — the difference posts as a processing-fee expense, so your income and fees both stay honest.`),
    el('label', { class: 'field-label' }, 'Gross amount ($)'), gross,
    el('label', { class: 'field-label' }, 'Income category'), incomeSel,
    el('label', { class: 'field-label' }, 'Fee category'), feeSel,
    feeLine,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn green', onclick: () => {
        const g = parseMoney(gross.value);
        if (g == null || g < row.amountCents) { toast('Gross must be at least the deposited amount', 'err'); return; }
        if (!incomeSel.value || incomeSel.value === '__new__') { toast('Pick an income category', 'err'); return; }
        if (!feeSel.value || feeSel.value === '__new__') { toast('Pick a fee category', 'err'); return; }
        const feeCents = g - row.amountCents;
        const bankacct = entities('bankacct').find(b => b.id === row.bankacctId);
        const lines = [
          { accountId: bankacct.accountId, amountCents: row.amountCents },
          { accountId: incomeSel.value, amountCents: -g },
        ];
        if (feeCents > 0) lines.push({ accountId: feeSel.value, amountCents: feeCents });
        const txn = {
          id: 't-' + row.id, date: row.date, payee: row.desc,
          memo: feeCents > 0 ? `Gross ${fmtMoney(g)} − ${fmtMoney(feeCents)} processing fee` : '',
          lines, status: 'posted',
          source: { app: row.source?.app || 'csv', importId: row.importId, sourceId: row.id },
        };
        const v = validateTxn(txn, postCtx());
        if (!v.ok) { toast(v.error, 'err'); return; }
        dispatch({ op: 'entity.upsert', kind: 'txn', value: txn });
        dispatch({ op: 'entity.upsert', kind: 'staged', value: { ...row, status: 'approved', txnId: txn.id, categoryId: incomeSel.value } });
        toast(feeCents > 0 ? `Posted — ${fmtMoney(feeCents)} captured as processing fees` : 'Posted');
        m.close();
      } }, 'Post split')),
  );
  setTimeout(() => gross.focus(), 0);
}

// ── Match a bank deposit to processor daily sales (M13) ──
// Books-first: the Muse-synced sales rows already debit the clearing account
// per day, so the deposit usually matches the ledger exactly (Fee Saver = no
// merchant fee) or minus a small fee. When the books can't explain it (sales
// rows not approved yet), fall back to Helcim's card-transactions API. Posting
// relieves the clearing account — never income, which the sales rows already
// booked — so nothing double-counts.
async function matchDepositModal(row, accountsById) {
  const m = modal('Match processor deposit');
  m.body.append(el('p', { class: 'sub' }, 'Looking for the sales days this deposit covers…'));

  const mapping = getState().meta?.museMapping || {};
  const i2gMap = getState().meta?.i2gMapping || {};
  // Clearing accounts a deposit can relieve: the salon's card/gift clearing
  // (Muse sync) and/or the Invoice2go clearing account (A/R module).
  const clearingIds = [...new Set([mapping.balancing?.sales_card, mapping.balancing?.gift_sold, i2gMap.clearingId].filter(Boolean))];
  // The Helcim API fallback is salon-only — it uses the shared Helcim token, so
  // a non-salon business (e.g. Invoice2go-only) must never reach for it.
  const usesHelcim = !!(mapping.balancing?.sales_card || mapping.balancing?.gift_sold);
  const dep = { date: row.date, amountCents: row.amountCents };

  let match = clearingIds.length ? matchDeposit(dep, ledgerDayDebits(entities('txn'), clearingIds)) : null;
  let source = match ? 'your books' : null;

  if (!match && usesHelcim) {
    const back = new Date(row.date + 'T12:00:00Z'); back.setUTCDate(back.getUTCDate() - 10);
    try {
      const res = await api(`/b/${getActiveBiz()}/processor/helcim/transactions?dateFrom=${back.toISOString().slice(0, 10)}&dateTo=${row.date}`);
      if (res.status === 501) { drawNoMatch(m, row, 'Helcim isn’t connected (the owner adds the HELCIM_API_TOKEN secret to the Worker) and the books have no matching clearing activity.'); return; }
      if (res.ok) {
        const txns = await res.json();
        match = matchDeposit(dep, helcimDayTotals(Array.isArray(txns) ? txns : []));
        source = match ? 'Helcim' : null;
      }
    } catch { /* unreachable → falls through to no-match */ }
  }
  if (!match) { drawNoMatch(m, row, 'No sales day (or 2–3 day run) within the past week explains this amount. Use the % button to enter the gross by hand.'); return; }

  const clearingId = clearingIds[0];
  const clearing = clearingId ? accountsById.get(clearingId) : null;
  const feeAccts = entities('account').filter(a => a.active !== false && (a.type === 'expense' || a.type === 'cogs'));
  const feeDefault = feeAccts.find(a => /fee|process/i.test(a.name)) || feeAccts[0];
  if (match.feeCents > 0 && !feeAccts.length) {
    drawNoMatch(m, row, 'A processing fee of ' + fmtMoney(match.feeCents) + ' needs to be posted, but there are no expense categories. Add one in Accounts first.');
    return;
  }
  const feeSel = el('select', { class: 'field-input' },
    ...feeAccts.map(a => el('option', { value: a.id, selected: a.id === feeDefault?.id }, accountLabel(a, accountsById))),
    el('option', { value: '__new__' }, '＋ Add category…'));
  addNewCategoryIntercept(feeSel, feeDefault?.id);

  const daysLabel = match.days.length === 1 ? match.days[0] : `${match.days[0]} – ${match.days[match.days.length - 1]}`;
  clear(m.body).append(
    el('p', {}, `This looks like the payout for `, el('b', {}, daysLabel), ` (from ${source}):`),
    el('table', { class: 'data' },
      el('tr', {}, el('td', {}, 'Gross card sales'), el('td', { class: 'num' }, fmtMoney(match.grossCents))),
      el('tr', {}, el('td', {}, 'Deposited'), el('td', { class: 'num' }, fmtMoney(row.amountCents))),
      el('tr', {}, el('td', {}, el('b', {}, 'Processing fee')), el('td', { class: 'num' }, el('b', {}, fmtMoney(match.feeCents))))),
    clearing
      ? el('p', { class: 'sub' }, `Posts against “${clearing.name}” — the synced sales rows already booked the income, so this just moves the money to the bank.`)
      : el('p', { class: 'sub' }, 'No Muse clearing account is mapped (Settings → Muse sync), so this will post as income minus the fee — same as the % button.'),
    match.feeCents > 0 ? el('div', {}, el('label', { class: 'field-label' }, 'Fee category'), feeSel) : el('span'),
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn green', onclick: () => {
        const bankacct = entities('bankacct').find(b => b.id === row.bankacctId);
        if (!bankacct) { toast('Bank account missing', 'err'); return; }
        let lines, categoryId;
        if (clearing) {
          lines = [
            { accountId: bankacct.accountId, amountCents: row.amountCents },
            { accountId: clearing.id, amountCents: -match.grossCents },
          ];
          categoryId = clearing.id;
        } else {
          const income = entities('account').find(a => a.active !== false && a.type === 'income');
          if (!income) { toast('Needs an income account', 'err'); return; }
          lines = [
            { accountId: bankacct.accountId, amountCents: row.amountCents },
            { accountId: income.id, amountCents: -match.grossCents },
          ];
          categoryId = income.id;
        }
        if (match.feeCents > 0) lines.push({ accountId: feeSel.value, amountCents: match.feeCents });
        const txn = {
          id: 't-' + row.id, date: row.date, payee: row.desc,
          memo: `Payout for ${daysLabel}: gross ${fmtMoney(match.grossCents)} − ${fmtMoney(match.feeCents)} processing fee (matched via ${source})`,
          lines, status: 'posted',
          source: { app: row.source?.app || 'csv', importId: row.importId, sourceId: row.id },
        };
        const v = validateTxn(txn, postCtx());
        if (!v.ok) { toast(v.error, 'err'); return; }
        dispatch({ op: 'entity.upsert', kind: 'txn', value: txn });
        dispatch({ op: 'entity.upsert', kind: 'staged', value: { ...row, status: 'approved', txnId: txn.id, categoryId } });
        toast(match.feeCents > 0 ? `Posted — ${fmtMoney(match.feeCents)} captured as processing fees` : 'Posted — deposit matched to the penny');
        m.close();
      } }, match.feeCents > 0 ? 'Post with fee' : 'Post match')),
  );
}

function drawNoMatch(m, row, why) {
  clear(m.body).append(
    el('p', { class: 'sub' }, why),
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Close')),
  );
}

async function askAI(rows, categories, body, editable) {
  aiBusy = true;
  drawBody(body, editable);
  try {
    const res = await api(`/b/${getActiveBiz()}/ai/categorize`, {
      method: 'POST',
      body: JSON.stringify({
        rows: rows.slice(0, 40).map(r => ({ id: r.id, desc: r.desc, amountCents: r.amountCents, date: r.date })),
        categories: categories.map(c => ({ id: c.id, name: c.name, type: c.type })),
      }),
    });
    if (res.status === 501) { toast('AI isn’t set up yet — the owner adds the ANTHROPIC_API_KEY secret to enable it', 'err'); return; }
    if (res.status === 403) {
      const why = (await res.json()).error;
      toast(why === 'ai_paused' ? 'AI is paused — flip it back on in Settings'
        : why === 'ai_budget_reached' ? 'Monthly AI budget reached — raise the cap in Settings'
        : 'AI is unavailable', 'err');
      return;
    }
    if (res.status === 400) { toast('Add some categories to your chart of accounts first — the AI needs a list to choose from', 'err'); return; }
    if (res.status === 502) { toast('The AI service didn’t respond — the owner may need to check the ANTHROPIC_API_KEY', 'err'); return; }
    if (!res.ok) { toast('AI suggestions failed — categorize manually for now', 'err'); return; }
    const { suggestions } = await res.json();
    let got = 0;
    for (const s of suggestions) {
      if (s.categoryId) { aiSuggestions.set(s.id, { accountId: s.categoryId, confidence: s.confidence }); got++; }
    }
    toast(got ? `${got} AI suggestion${got === 1 ? '' : 's'} — review and approve` : 'AI had no confident matches');
  } catch { /* api() handles auth; network errors just leave rows unmatched */ }
  finally {
    aiBusy = false;
    drawBody(body, editable);
  }
}

function makeRuleModal(row, pickedCategoryId, categories, accountsById) {
  const m = modal('Auto-categorize this vendor');
  const name = el('input', { class: 'field-input', value: guessVendorName(row.desc) });
  const keyword = el('input', { class: 'field-input', value: guessVendorName(row.desc).toUpperCase() });
  // Bank/card accounts are offered as transfer destinations (a rule can auto-categorize
  // a recurring transfer to another account), mirroring the Vendors-tab rule editor.
  const ownAccountId = entities('bankacct').find(b => b.id === row.bankacctId)?.accountId;
  const transferTargets = entities('account')
    .filter(a => a.active !== false && bankish(a) && a.id !== ownAccountId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const cat = el('select', { class: 'field-input' },
    el('option', { value: '' }, '— category —'),
    transferTargets.length ? el('optgroup', { label: '↔ Transfer to / from' },
      ...transferTargets.map(a => el('option', { value: a.id, selected: a.id === pickedCategoryId }, a.name))) : null,
    el('optgroup', { label: 'Categories' },
      ...categories
        .sort((a, b) => accountLabel(a, accountsById).localeCompare(accountLabel(b, accountsById)))
        .map(a => el('option', { value: a.id, selected: a.id === pickedCategoryId }, accountLabel(a, accountsById)))),
    el('option', { value: '__new__' }, '＋ Add category…'));
  addNewCategoryIntercept(cat, pickedCategoryId);
  m.body.append(
    el('p', { class: 'sub' }, 'Bank descriptions containing the match text get this category suggested automatically.'),
    el('label', { class: 'field-label' }, 'Vendor name'), name,
    el('label', { class: 'field-label' }, 'Match text (appears anywhere in the description)'), keyword,
    el('label', { class: 'field-label' }, 'Category'), cat,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: () => {
        if (!name.value.trim() || !keyword.value.trim() || !cat.value) { toast('Fill all three fields', 'err'); return; }
        dispatch({ op: 'entity.upsert', kind: 'vendor', value: {
          id: 'v-' + name.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30),
          name: name.value.trim(),
          matchers: { exact: [], keywords: [keyword.value.trim()] },
          defaultAccountId: cat.value, used: 0,
        } });
        toast('Rule saved — future imports match automatically');
        m.close();
      } }, 'Save rule')),
  );
}
