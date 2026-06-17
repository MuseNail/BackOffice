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
import { suggestFor, guessVendorName, matchesRule } from '../lib/match.js';
import { ruleConditionsEditor, buildMatchers, matchersToConditions, rulePreview } from '../rule-editor.js';
import { bindSuggest } from '../suggest.js';
import { accountLabel } from '../lib/coa-templates.js';
import { parseMoney } from '../lib/money.js';
import { MUSE_SYNC_TYPES } from '../lib/musesync.js';
import { helcimDayTotals, ledgerDayDebits, matchDeposit } from '../lib/processor-match.js';
import { attachAddCategory, attachAddVendor } from '../pickers.js';
import { combobox } from '../combobox.js';
import { dateRangeControl } from '../daterange.js';
import { quickAddAccountModal } from './accounts.js';
import { quickAddVendorModal } from './vendors.js';
import { logAudit } from '../audit.js';

let unsub = null;
let aiSuggestions = new Map();
let aiBusy = false;
let showSkipped = false;
// Review filter/sort (bank-row sections only). dir: all|in|out · status: all|needs|ready
// · bank: all|<bankId> · sort: date-desc|date-asc|amount-desc|amount-asc.
let reviewFilter = { dir: 'all', status: 'all', bank: 'all', sort: 'date-desc', amountMin: '', amountMax: '', from: '', to: '' };
// The shared date picker, built once (the filter bar is rebuilt on every redraw).
let reviewDateCtl = null;
const REVIEW_FILTER_DEFAULT = () => ({ dir: 'all', status: 'all', bank: 'all', sort: 'date-desc', amountMin: '', amountMax: '', from: '', to: '' });
// Preserve per-row category / vendor selection across drawBody re-renders (store
// changes trigger a full redraw, so we save the user's pick here and restore it).
let lastCategory = new Map();
let lastVendor = new Map();
// Review (bank rows): which account groups are collapsed, and the current page per account.
let collapsedBanks = new Set();
let bankPage = new Map();
const REVIEW_PAGE = 50;
// Bulk-select (bank rows): a per-account selection — ticking a row in a different
// account starts a fresh selection there; the sticky bar acts on the selection.
let selected = new Set();
let selectedBank = null;

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
  reviewDateCtl = dateRangeControl({ initial: 'all', onChange: (r) => { reviewFilter.from = r.from || ''; reviewFilter.to = r.to || ''; draw(); } });
  unsub = subscribe(draw);
  draw();
}

export function unmount() { unsub?.(); unsub = null; aiSuggestions = new Map(); aiBusy = false; showSkipped = false; lastCategory = new Map(); lastVendor = new Map(); collapsedBanks = new Set(); bankPage = new Map(); selected = new Set(); selectedBank = null; reviewFilter = REVIEW_FILTER_DEFAULT(); reviewDateCtl = null; }

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
    if (reviewFilter.from && r.date < reviewFilter.from) return false;
    if (reviewFilter.to && r.date > reviewFilter.to) return false;
    const absC = Math.abs(r.amountCents);
    if (reviewFilter.amountMin && absC < reviewFilter.amountMin) return false;
    if (reviewFilter.amountMax && absC > reviewFilter.amountMax) return false;
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

// Category groups for the combobox — transfer targets first, then COA type groups.
// Subaccounts get a leading indent (figure-spaces — U+2007 — which survive HTML
// whitespace collapsing) so they read as a child of the account above them.
function categoryGroups(row, categories, accountsById) {
  const ownAccountId = entities('bankacct').find(b => b.id === row.bankacctId)?.accountId;
  const transferTargets = entities('account')
    .filter(a => a.active !== false && bankish(a) && a.id !== ownAccountId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const groups = [];
  if (transferTargets.length) groups.push({ label: '↔ Transfer to / from', items: transferTargets.map(a => ({ value: a.id, label: a.name })) });
  for (const [type, label] of TYPE_GROUPS) {
    const accts = categories.filter(a => a.type === type)
      .sort((a, b) => accountLabel(a, accountsById).localeCompare(accountLabel(b, accountsById)));
    if (!accts.length) continue;
    groups.push({ label, items: accts.map(a => ({ value: a.id, label: (a.parentId ? '   ' : '') + accountLabel(a, accountsById) })) });
  }
  return groups;
}

function categorySelect(row, categories, accountsById, preselect, afterAdd) {
  return combobox({ groups: categoryGroups(row, categories, accountsById), value: preselect || '',
    placeholder: 'Search accounts…', minWidth: 180, addLabel: 'Add account…',
    onAdd: () => quickAddAccountModal((account) => afterAdd?.(account)) });
}

// Vendor picker for a Review row — tags THIS transaction with a vendor (separate from
// the ⚡ "make a rule" flow). Inline "＋ Add vendor" creates a name-only vendor.
function vendorSelect(vendors, preselect, afterAdd) {
  return combobox({ groups: [{ label: '', items: vendors.map(v => ({ value: v.id, label: v.name })) }],
    value: preselect || '', placeholder: 'Search vendors…', minWidth: 180, addLabel: 'Add vendor…',
    onAdd: () => quickAddVendorModal((vendor) => afterAdd?.(vendor)) });
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
  // Drop any selection that's no longer pending (approved/skipped elsewhere).
  const pendingIds = new Set(pending.map(r => r.id));
  for (const id of [...selected]) if (!pendingIds.has(id)) selected.delete(id);
  if (!selected.size) selectedBank = null;
  const accountsById = new Map(entities('account').map(a => [a.id, a]));
  const categories = entities('account').filter(a => a.active !== false && !bankish(a));
  const matchCtx = { vendors: entities('vendor'), history: entities('staged') };
  const vendorsList = entities('vendor').slice().sort((a, b) => a.name.localeCompare(b.name));
  const showInvoices = usesInvoices();
  const invoicesList = showInvoices ? entities('invoice').slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')) : [];

  const suggested = [];
  const unmatched = [];
  // Each pending row is a self-contained card with ALL fields visible (no expand) —
  // a 2-line layout: date · description (wraps) · amount · suggestion on top, then
  // category / vendor / invoice / note / actions below, divided by dashed rules.
  const field = (label, node) => el('div', { class: 'rvf' }, el('label', { class: 'field-label', style: 'margin:0 0 2px' }, label), node);
  const rowCard = (row) => {
    let sug = suggestFor(row, matchCtx);
    if (sug && (!accountsById.has(sug.accountId) || accountsById.get(sug.accountId).active === false)) sug = null;
    if (!sug) {
      const ai = aiSuggestions.get(row.id);
      if (ai?.accountId && accountsById.has(ai.accountId) && accountsById.get(ai.accountId).active !== false) sug = { accountId: ai.accountId, by: 'ai', confidence: ai.confidence };
      else unmatched.push(row);
    }
    if (sug) suggested.push({ row, sug });

    const preselect = lastCategory.get(row.id) || sug?.accountId;
    const vendPreselect = lastVendor.has(row.id) ? lastVendor.get(row.id) : sug?.vendorId;
    const sel = categorySelect(row, categories, accountsById, preselect,
      (account) => { lastCategory.set(row.id, account.id); drawBody(body, editable); });
    const memoIn = el('input', { class: 'field-input', placeholder: 'Add a note…', style: 'margin:0;min-width:150px', value: row.memo || '' });
    bindSuggest(memoIn, 'memo');
    const vendSel = vendorSelect(vendorsList, vendPreselect,
      (vendor) => { lastVendor.set(row.id, vendor.id); drawBody(body, editable); });
    const invSel = showInvoices ? invoiceSelect(invoicesList) : null; if (invSel) invSel.style.margin = '0';
    const chip = sug
      ? (sug.by === 'rule' ? el('span', { class: 'pill blue' }, `⚡ ${sug.vendorName}`)
        : sug.by === 'ai' ? el('span', { class: 'pill amber' }, `✨ AI ${sug.confidence}%`)
        : el('span', { class: 'pill green' }, '🕘 Seen before'))
      : el('span', { class: 'pill gray' }, 'No match');

    const approve = el('button', { class: 'btn sm green', disabled: !preselect, onclick: () => {
      lastCategory.delete(row.id); lastVendor.delete(row.id);
      approveRow(row, sel.value, sug, { memo: memoIn.value.trim(), vendorId: vendSel.value, invoiceId: invSel?.value || '' });
    } }, 'Approve');
    sel.addEventListener('change', () => { if (sel.value) lastCategory.set(row.id, sel.value); approve.disabled = !sel.value; });
    vendSel.addEventListener('change', () => { lastVendor.set(row.id, vendSel.value); });
    const actions = [approve,
      el('button', { class: 'btn sm ghost', onclick: () => skipRow(row) }, 'Skip'),
      el('button', { class: 'btn sm ghost', title: 'Auto-categorize this vendor from now on', onclick: () => makeRuleModal(row, sel.value, categories, accountsById) }, '⚡ Rule')];
    if (row.amountCents > 0) {
      actions.push(el('button', { class: 'btn sm ghost', title: 'Deposit with a processing fee taken out', onclick: () => feeSplitModal(row, accountsById) }, '% Fee'));
      actions.push(el('button', { class: 'btn sm ghost', title: 'Match this deposit to recorded sales/payments', onclick: () => matchDepositModal(row, accountsById) }, '⚡$ Match'));
    }

    return el('div', { class: 'revrow' },
      el('div', { class: 'revtop' },
        editable ? el('input', { type: 'checkbox', class: 'revchk', checked: selected.has(row.id), title: 'Select for bulk action',
          onchange: (e) => { if (selectedBank !== row.bankacctId) { selected.clear(); selectedBank = row.bankacctId; } e.target.checked ? selected.add(row.id) : selected.delete(row.id); drawBody(body, editable); } }) : null,
        el('span', { class: 'revdate' }, row.date),
        el('span', { class: 'revdesc' }, row.desc || ''),
        el('span', { class: 'revamt num ' + (row.amountCents < 0 ? 'neg' : 'pos') }, fmtMoney(row.amountCents, { sign: row.amountCents > 0 })),
        chip),
      editable ? el('div', { class: 'revfields' },
        field('Account', sel),
        field('Vendor', vendSel),
        invSel ? field('Invoice', invSel) : null,
        field('Note', memoIn),
        el('div', { class: 'rvf rvactions' }, ...actions)) : null);
  };

  // one collapsible, paginated section per bank account (5.4 / 5.5)
  const sections = [];
  for (const bank of entities('bankacct')) {
    if (reviewFilter.bank !== 'all' && reviewFilter.bank !== bank.id) continue;
    const allMine = applyReviewFilter(
      entities('staged').filter(r => r.bankacctId === bank.id && !r.syncApp && r.status === 'pending'),
      matchCtx, accountsById);
    if (!allMine.length) continue;
    const collapsed = collapsedBanks.has(bank.id);
    const pages = Math.max(1, Math.ceil(allMine.length / REVIEW_PAGE));
    const page = Math.min(Math.max(0, bankPage.get(bank.id) || 0), pages - 1);
    const header = el('div', { class: 'cardtitle', style: 'cursor:pointer;display:flex;align-items:center;gap:8px;margin-bottom:8px;user-select:none',
      onclick: () => { collapsed ? collapsedBanks.delete(bank.id) : collapsedBanks.add(bank.id); drawBody(body, editable); } },
      el('span', { class: 'ms', style: 'font-size:20px;color:var(--mut)' }, collapsed ? 'chevron_right' : 'expand_more'),
      el('span', {}, bank.name), el('span', { class: 'pill amber' }, `${allMine.length} waiting`),
      editable ? el('label', { style: 'margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:#3c3f48;cursor:pointer', onclick: (e) => e.stopPropagation() },
        el('input', { type: 'checkbox', class: 'revchk', checked: allMine.length > 0 && selectedBank === bank.id && allMine.every(r => selected.has(r.id)),
          onchange: (e) => { selected.clear(); selectedBank = bank.id; if (e.target.checked) for (const r of allMine) selected.add(r.id); drawBody(body, editable); } }), 'Select all') : null);
    const kids = [header];
    if (!collapsed) {
      kids.push(el('div', {}, ...allMine.slice(page * REVIEW_PAGE, page * REVIEW_PAGE + REVIEW_PAGE).map(rowCard)));
      if (pages > 1) kids.push(el('div', { style: 'display:flex;gap:10px;align-items:center;margin-top:10px' },
        el('button', { class: 'btn sm ghost', disabled: page <= 0, onclick: () => { bankPage.set(bank.id, page - 1); drawBody(body, editable); } }, '‹ Prev'),
        el('span', { class: 'sub', style: 'margin:0' }, `Page ${page + 1} of ${pages} · ${allMine.length} total`),
        el('button', { class: 'btn sm ghost', disabled: page >= pages - 1, onclick: () => { bankPage.set(bank.id, page + 1); drawBody(body, editable); } }, 'Next ›')));
    }
    sections.push(el('div', { style: 'margin-bottom:18px' }, ...kids));
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
        el('option', { value: '' }, '— pick an account —'),
        ...TYPE_GROUPS.map(([type, label]) => {
          const accts = categories.filter(a => a.type === type)
            .sort((a, b) => accountLabel(a, accountsById).localeCompare(accountLabel(b, accountsById)));
          return accts.length ? el('optgroup', { label }, ...accts.map(a => el('option', { value: a.id, selected: a.id === preselect }, accountLabel(a, accountsById)))) : null;
        }).filter(Boolean),
        el('option', { value: '__new__' }, '＋ Add account…'));
      attachAddCategory(sel, preselect);
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
          el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'From the salon'), el('th', { class: 'num' }, 'Amount'), el('th', {}, 'Account'), el('th', {}, 'Balancing account'), el('th', {}, '')),
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
  // Amount filter — min/max on the absolute amount, committed on blur/Enter (so
  // typing doesn't redraw mid-keystroke). Stored as cents.
  const amtIn = (key, ph) => el('input', { class: 'field-input', inputmode: 'decimal', placeholder: ph, style: 'margin:0;width:84px',
    value: reviewFilter[key] ? (reviewFilter[key] / 100).toFixed(2) : '',
    onchange: (e) => { const c = parseMoney(e.target.value); reviewFilter[key] = (c != null && c > 0) ? c : ''; drawBody(body, editable); } });
  if (reviewDateCtl) reviewDateCtl.setRange({ from: reviewFilter.from || null, to: reviewFilter.to || null });
  const filtersOn = reviewFilter.dir !== 'all' || reviewFilter.status !== 'all' || reviewFilter.bank !== 'all' || reviewFilter.sort !== 'date-desc' || reviewFilter.amountMin !== '' || reviewFilter.amountMax !== '' || reviewFilter.from !== '' || reviewFilter.to !== '';
  // Fixed two-row filter bar: row 1 = what to show / order; row 2 = amount, date, clear.
  const rowStyle = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
  const filterBar = el('div', { style: 'margin-bottom:12px' },
    el('div', { style: rowStyle + ';margin-bottom:8px' },
      el('span', { class: 'sub', style: 'margin:0' }, 'Filter'),
      fsel('dir', [['all', 'All'], ['in', 'Money in'], ['out', 'Money out']]),
      fsel('status', [['all', 'Any status'], ['needs', 'Needs an account'], ['ready', 'Ready']]),
      fsel('bank', [['all', 'All accounts'], ...entities('bankacct').map(b => [b.id, b.name])]),
      fsel('sort', [['date-desc', 'Newest first'], ['date-asc', 'Oldest first'], ['amount-desc', 'Largest first'], ['amount-asc', 'Smallest first']])),
    el('div', { style: rowStyle },
      el('span', { class: 'sub', style: 'margin:0' }, 'Amount'), amtIn('amountMin', 'min $'), el('span', { class: 'sub', style: 'margin:0' }, '–'), amtIn('amountMax', 'max $'),
      reviewDateCtl ? reviewDateCtl.el : el('span'),
      el('button', { class: 'btn sm ghost', disabled: !filtersOn, onclick: () => { reviewFilter = REVIEW_FILTER_DEFAULT(); reviewDateCtl?.setRange({ from: null, to: null }); drawBody(body, editable); } }, 'Clear filters')));
  // Sticky bulk-action bar — shown while a (per-account) selection is active.
  const byCat = new Map(categorized.map(c => [c.row.id, c]));
  const selRows = pending.filter(r => selected.has(r.id));
  const bulkBank = selectedBank ? entities('bankacct').find(b => b.id === selectedBank) : null;
  const readyN = selRows.filter(r => byCat.has(r.id)).length;
  const bulkBar = (editable && selRows.length) ? el('div', { class: 'review-bulkbar' },
    el('span', {}, el('b', {}, `${selRows.length} selected`), bulkBank ? el('span', { class: 'sub', style: 'margin:0 0 0 6px' }, `in ${bulkBank.name}`) : null),
    el('span', { class: 'sub', style: 'margin:0' }, `· ${readyN} ready${selRows.length - readyN ? `, ${selRows.length - readyN} need an account` : ''}`),
    el('span', { style: 'flex:1' }),
    el('button', { class: 'btn sm ghost', onclick: () => bulkSetField('category', selRows, categories, accountsById, vendorsList, body, editable) }, 'Set account'),
    el('button', { class: 'btn sm ghost', onclick: () => bulkSetField('vendor', selRows, categories, accountsById, vendorsList, body, editable) }, 'Set vendor'),
    el('button', { class: 'btn sm green', onclick: () => bulkApprove(byCat, body, editable) }, 'Approve'),
    el('button', { class: 'btn sm ghost', onclick: () => bulkSkip(pending, body, editable) }, 'Skip'),
    el('button', { class: 'btn sm ghost', onclick: () => { selected.clear(); selectedBank = null; drawBody(body, editable); } }, 'Clear')) : null;
  clear(body).append(
    bulkBar || el('span'),
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
  if (!balId || !categoryId) { toast(balId ? 'Pick an account first' : 'Set the Muse mapping in Settings first', 'err'); return; }
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
  logAudit('post', { summary: `Approved (Muse) ${row.date} · ${row.desc || row.syncType}`, kind: 'txn', entityId: txn.id, amountCents: row.amountCents });
  toast('Posted');
}

function approveRow(row, categoryId, sug, { quiet = false, memo = '', vendorId = '', invoiceId = '' } = {}) {
  const bankacct = entities('bankacct').find(b => b.id === row.bankacctId);
  if (!bankacct || !categoryId) { toast('Pick an account first', 'err'); return; }
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
  logAudit('post', { summary: `Approved ${row.date} · ${row.desc || '—'} → ${entities('account').find(a => a.id === categoryId)?.name || categoryId}`, kind: 'txn', entityId: txn.id, amountCents: row.amountCents });
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

// ── Bulk actions on the current (per-account) selection ─────────────────────────
// Approve posts every selected row that has a resolved category; rows still missing
// one stay selected so nothing is silently dropped.
function bulkApprove(byCat, body, editable) {
  let done = 0;
  for (const id of [...selected]) {
    const c = byCat.get(id);
    if (!c) continue;
    lastCategory.delete(c.row.id);
    approveRow(c.row, c.accountId, c.sug, { quiet: true, vendorId: lastVendor.get(c.row.id) || '' });
    selected.delete(id); done++;
  }
  if (!selected.size) selectedBank = null;
  toast(done ? `${done} approved${selected.size ? ` · ${selected.size} still need an account` : ''}` : 'Those rows still need an account', done ? 'ok' : 'err');
  drawBody(body, editable);
}
function bulkSkip(pending, body, editable) {
  const byId = new Map(pending.map(r => [r.id, r]));
  let n = 0;
  for (const id of [...selected]) { const r = byId.get(id); if (r) { dispatch({ op: 'entity.upsert', kind: 'staged', value: { ...r, status: 'skipped' } }); n++; } }
  selected.clear(); selectedBank = null;
  toast(`${n} skipped`);
  drawBody(body, editable);
}
// Apply one category or vendor across the whole selection (they then approve as usual).
function bulkSetField(kind, selRows, categories, accountsById, vendorsList, body, editable) {
  const isCat = kind === 'category';
  const noun = isCat ? 'account' : 'vendor';
  const m = modal(`Set ${noun} for ${selRows.length} row${selRows.length === 1 ? '' : 's'}`);
  const sel = isCat
    ? el('select', { class: 'field-input' }, el('option', { value: '' }, '— choose an account —'), ...categoryOptions(categories, accountsById))
    : el('select', { class: 'field-input' }, el('option', { value: '' }, '— choose a vendor —'), ...vendorsList.map(v => el('option', { value: v.id }, v.name)));
  m.body.append(
    el('label', { class: 'field-label' }, isCat ? 'Account' : 'Vendor'), sel,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: () => {
        if (!sel.value) { toast(`Pick ${isCat ? 'an account' : 'a vendor'}`, 'err'); return; }
        const map = isCat ? lastCategory : lastVendor;
        for (const r of selRows) map.set(r.id, sel.value);
        m.close(); drawBody(body, editable);
      } }, 'Apply')));
}
function categoryOptions(categories, accountsById) {
  return TYPE_GROUPS.map(([type, label]) => {
    const items = categories.filter(c => c.type === type).sort((a, b) => accountLabel(a, accountsById).localeCompare(accountLabel(b, accountsById)));
    return items.length ? el('optgroup', { label }, ...items.map(c => el('option', { value: c.id }, accountLabel(c, accountsById)))) : null;
  }).filter(Boolean);
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
    el('option', { value: '__new__' }, '＋ Add account…'));
  attachAddCategory(incomeSel, incomeAccts[0]?.id);
  const feeSel = el('select', { class: 'field-input' },
    ...feeAccts.map(a => el('option', { value: a.id, selected: a.id === defaultFee.id }, accountLabel(a, accountsById))),
    el('option', { value: '__new__' }, '＋ Add account…'));
  attachAddCategory(feeSel, defaultFee.id);
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
    el('label', { class: 'field-label' }, 'Income account'), incomeSel,
    el('label', { class: 'field-label' }, 'Fee account'), feeSel,
    feeLine,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn green', onclick: () => {
        const g = parseMoney(gross.value);
        if (g == null || g < row.amountCents) { toast('Gross must be at least the deposited amount', 'err'); return; }
        if (!incomeSel.value || incomeSel.value === '__new__') { toast('Pick an income account', 'err'); return; }
        if (!feeSel.value || feeSel.value === '__new__') { toast('Pick a fee account', 'err'); return; }
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
        logAudit('post', { summary: `Deposit with fee ${row.date} · gross ${fmtMoney(g)}${feeCents > 0 ? ` − ${fmtMoney(feeCents)} fee` : ''}`, kind: 'txn', entityId: txn.id, amountCents: row.amountCents });
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
    drawNoMatch(m, row, 'A processing fee of ' + fmtMoney(match.feeCents) + ' needs to be posted, but there are no expense accounts. Add one in Accounts first.');
    return;
  }
  const feeSel = el('select', { class: 'field-input' },
    ...feeAccts.map(a => el('option', { value: a.id, selected: a.id === feeDefault?.id }, accountLabel(a, accountsById))),
    el('option', { value: '__new__' }, '＋ Add account…'));
  attachAddCategory(feeSel, feeDefault?.id);

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
    match.feeCents > 0 ? el('div', {}, el('label', { class: 'field-label' }, 'Fee account'), feeSel) : el('span'),
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
        logAudit('post', { summary: `Matched deposit ${row.date} (${daysLabel}) — ${fmtMoney(match.grossCents)} gross`, kind: 'txn', entityId: txn.id, amountCents: row.amountCents });
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
    if (res.status === 400) { toast('Add some accounts to your chart of accounts first — the AI needs a list to choose from', 'err'); return; }
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
  // Existing vendors are offered for reuse (datalist autocomplete) so a second rule
  // for the same vendor extends it instead of silently overwriting it.
  const existingVendors = entities('vendor').slice().sort((a, b) => a.name.localeCompare(b.name));
  const findVendor = (nm) => { const t = nm.trim().toLowerCase(); return t ? existingVendors.find(v => (v.name || '').trim().toLowerCase() === t) : null; };
  const dl = el('datalist', { id: 'mr-existing-vendors' }, ...existingVendors.map(v => el('option', { value: v.name })));
  const name = el('input', { class: 'field-input', list: 'mr-existing-vendors', value: guessVendorName(row.desc) });
  const hint = el('p', { class: 'sub', style: 'margin:4px 0 0;color:var(--green)' }, '');
  const editor = ruleConditionsEditor({ seed: { conditions: [{ type: 'contains', text: guessVendorName(row.desc).toUpperCase() }] }, onChange: () => updatePreview() });
  const preview = rulePreview();
  const updatePreview = () => {
    const sp = editor.get();
    if (!sp.conditions.length) { preview.set({ n: 0, samples: [] }); return; }
    const hits = entities('staged').filter(r => matchesRule(buildMatchers(sp), r));
    preview.set({ n: hits.length, samples: hits.map(r => r.desc).filter(Boolean) });
  };
  // Bank/card accounts are offered as transfer destinations (a rule can auto-categorize
  // a recurring transfer to another account), mirroring the Vendors-tab rule editor.
  const ownAccountId = entities('bankacct').find(b => b.id === row.bankacctId)?.accountId;
  const transferTargets = entities('account')
    .filter(a => a.active !== false && bankish(a) && a.id !== ownAccountId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const catGroups = [];
  if (transferTargets.length) catGroups.push({ label: '↔ Transfer to / from', items: transferTargets.map(a => ({ value: a.id, label: a.name })) });
  catGroups.push({ label: 'Accounts', items: categories
    .sort((a, b) => accountLabel(a, accountsById).localeCompare(accountLabel(b, accountsById)))
    .map(a => ({ value: a.id, label: accountLabel(a, accountsById) })) });
  const cat = combobox({ groups: catGroups, value: pickedCategoryId || '', placeholder: 'Search accounts…', minWidth: 240,
    addLabel: 'Add account…', onAdd: () => quickAddAccountModal((account) => {
      catGroups.find(g => g.label === 'Accounts').items.push({ value: account.id, label: account.name });
      cat.setGroups(catGroups); cat.value = account.id;
    }) });
  cat.style.cssText = 'display:block;width:100%;max-width:340px';
  // When the typed name matches a vendor that already exists, say so and adopt its
  // category — so the user keeps building one vendor rather than making a duplicate.
  const syncExisting = () => {
    const v = findVendor(name.value);
    hint.textContent = v ? `“${v.name}” already exists — this match text will be added to it.` : '';
    if (v?.defaultAccountId && !cat.value) cat.value = v.defaultAccountId;
  };
  name.addEventListener('input', syncExisting);
  syncExisting();
  m.body.append(
    el('p', { class: 'sub' }, 'Bank descriptions matching the conditions below get this account suggested automatically.'),
    el('label', { class: 'field-label' }, 'Vendor name'), name, dl, hint,
    editor.el,
    el('label', { class: 'field-label' }, 'Account'), cat,
    preview.el,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: () => {
        const nm = name.value.trim(); const spec = editor.get();
        if (!nm || !spec.conditions.length || !cat.value) { toast('Add a vendor name, at least one match condition, and an account', 'err'); return; }
        const existing = findVendor(nm);
        // Extend an existing vendor's rule (don't clobber) — merge conditions by type+text.
        const mergedConds = existing
          ? Array.from(new Map([...matchersToConditions(existing.matchers), ...spec.conditions].map(c => [c.type + ' ' + c.text, c])).values())
          : spec.conditions;
        const matchers = buildMatchers({ ...spec, conditions: mergedConds });
        const vId = existing?.id || ('v-' + nm.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30));
        // Carry the rule just made back onto the row it was opened from — set BEFORE
        // dispatch so the redraw it triggers picks up the selection.
        lastCategory.set(row.id, cat.value);
        lastVendor.set(row.id, vId);
        dispatch({ op: 'entity.upsert', kind: 'vendor', value: {
          ...(existing || {}), id: vId, name: nm, matchers, defaultAccountId: cat.value, used: existing?.used || 0,
        } });
        logAudit('rule', { summary: `${existing ? 'Updated' : 'Created'} rule “${nm}” → ${entities('account').find(a => a.id === cat.value)?.name || cat.value}`, kind: 'vendor', entityId: vId });
        toast(existing ? `Rule updated for “${nm}”` : 'Rule saved — future imports match automatically');
        m.close();
      } }, 'Save rule')),
  );
  updatePreview();
}
