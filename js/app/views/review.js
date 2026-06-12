// ── view: review — approve staged bank rows into the ledger ────────────────
// Approval is THE posting moment. Suggestions come from lib/match.js (rules →
// history) then AI; the user always confirms. Special posting shapes:
//  • Transfer — category is another bank/card account: money moves between
//    accounts, no income/expense. The matching opposite row on the other
//    account is auto-marked so the transfer is never double-counted.
//  • Fee split — a deposit where the processor kept a cut: posts gross income,
//    the fee as its own expense, and the net into the bank, in one balanced txn.
import { el, clear, toast, fmtMoney, modal } from '../ui.js';
import { entities, subscribe } from '../store.js';
import { dispatch, api } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { validateTxn, simpleTxn } from '../lib/posting.js';
import { suggestFor, guessVendorName } from '../lib/match.js';
import { accountLabel } from '../lib/coa-templates.js';
import { parseMoney } from '../lib/money.js';

let unsub = null;
let aiSuggestions = new Map();
let aiBusy = false;

const TYPE_GROUPS = [
  ['income', 'Income'], ['asset', 'Assets'], ['liability', 'Liabilities'],
  ['equity', 'Equity'], ['cogs', 'Cost of goods'], ['expense', 'Expenses'],
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

export function unmount() { unsub?.(); unsub = null; aiSuggestions = new Map(); aiBusy = false; }

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
      ...accts.map(a => el('option', { value: a.id, selected: a.id === preselect }, accountLabel(a, accountsById)))));
  }
  return el('select', { class: 'field-input', style: 'margin:0;min-width:190px' },
    el('option', { value: '' }, '— pick a category —'), ...groups);
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

    const sel = categorySelect(row, categories, accountsById, sug?.accountId);
    const approve = el('button', { class: 'btn sm green', disabled: !sug, onclick: () => approveRow(row, sel.value, sug) }, 'Approve');
    sel.addEventListener('change', () => { approve.disabled = !sel.value; });

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
    }

    return el('tr', {},
      el('td', {}, row.date),
      el('td', {}, el('b', {}, row.desc.slice(0, 55))),
      el('td', { class: 'num ' + (row.amountCents < 0 ? 'neg' : 'pos') }, fmtMoney(row.amountCents, { sign: row.amountCents > 0 })),
      el('td', {}, editable ? sel : '—'),
      el('td', {}, chip),
      el('td', {}, editable ? el('div', { style: 'display:flex;gap:6px' }, ...actions) : ''),
    );
  };

  // one section per bank account (1.)
  const sections = [];
  for (const bank of entities('bankacct')) {
    const mine = pending.filter(r => r.bankacctId === bank.id).slice(0, 100);
    if (!mine.length) continue;
    sections.push(el('div', { style: 'margin-bottom:18px' },
      el('div', { class: 'cardtitle', style: 'margin-bottom:8px' }, `${bank.name} `, el('span', { class: 'pill amber' }, `${mine.length} waiting`)),
      el('div', { class: 'card', style: 'padding:0;overflow:hidden' },
        el('table', { class: 'data' },
          el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Bank description'), el('th', { class: 'num' }, 'Amount'), el('th', {}, 'Category'), el('th', {}, 'Suggested by'), el('th', {}, '')),
          ...mine.map(rowEl)))));
  }

  clear(body).append(
    el('div', { style: 'display:flex;gap:9px;align-items:center;margin-bottom:12px;flex-wrap:wrap' },
      (editable && suggested.length) ? el('button', { class: 'btn sm green', onclick: () => {
        for (const { row, sug } of suggested) approveRow(row, sug.accountId, sug, { quiet: true });
        toast(`${suggested.length} approved`);
      } }, `Approve all suggested (${suggested.length})`) : el('span'),
      (editable && unmatched.length && !aiBusy) ? el('button', { class: 'btn sm', onclick: () => askAI(unmatched, categories, body, editable) }, `✨ Get AI suggestions (${unmatched.length})`) : el('span'),
      aiBusy ? el('span', { class: 'pill gray' }, '✨ Asking Claude…') : el('span')),
    ...sections,
  );
}

const postCtx = () => ({
  accountsById: new Map(entities('account').map(a => [a.id, a])),
  locks: new Set(entities('lock').map(l => l.id)),
});

function approveRow(row, categoryId, sug, { quiet = false } = {}) {
  const bankacct = entities('bankacct').find(b => b.id === row.bankacctId);
  if (!bankacct || !categoryId) { toast('Pick a category first', 'err'); return; }
  const target = entities('account').find(a => a.id === categoryId);
  const isTransfer = target && bankish(target);
  const txn = simpleTxn({
    id: 't-' + row.id,
    date: row.date,
    payee: row.desc,
    memo: isTransfer ? 'Transfer between accounts' : '',
    amountCents: Math.abs(row.amountCents),
    direction: row.amountCents < 0 ? 'out' : 'in',
    bankAccountId: bankacct.accountId,
    categoryAccountId: categoryId,
    source: { app: 'import', importId: row.importId, sourceId: row.id },
  });
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
  const incomeSel = el('select', { class: 'field-input' }, ...incomeAccts.map(a => el('option', { value: a.id }, accountLabel(a, accountsById))));
  const feeSel = el('select', { class: 'field-input' }, ...feeAccts.map(a => el('option', { value: a.id, selected: a.id === defaultFee.id }, accountLabel(a, accountsById))));
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
          source: { app: 'import', importId: row.importId, sourceId: row.id },
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
  const cat = el('select', { class: 'field-input' },
    el('option', { value: '' }, '— category —'),
    ...categories
      .sort((a, b) => accountLabel(a, accountsById).localeCompare(accountLabel(b, accountsById)))
      .map(a => el('option', { value: a.id, selected: a.id === pickedCategoryId }, accountLabel(a, accountsById))));
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
