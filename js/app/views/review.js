// ── view: review — approve staged bank rows into the ledger ────────────────
// Approval is THE posting moment: it builds the balanced double entry and
// links it back to its import (source.importId + sourceId). Suggestions come
// from lib/match.js (rules → history); the user always confirms.
import { el, clear, toast, fmtMoney, modal } from '../ui.js';
import { entities, subscribe } from '../store.js';
import { dispatch, api } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { validateTxn, simpleTxn } from '../lib/posting.js';
import { suggestFor, guessVendorName } from '../lib/match.js';

let unsub = null;
// AI suggestions are transient (never persisted): rowId → {accountId, confidence}.
// Rules and history always win — AI only fills rows they couldn't.
let aiSuggestions = new Map();
let aiBusy = false;

export function render(root) {
  const editable = canEdit(getActiveBiz());
  const body = el('div');
  root.append(
    el('h2', {}, 'Review'),
    el('p', { class: 'sub' }, 'Imported transactions wait here. Suggestions show where they came from — nothing posts without your approval.'),
    body,
  );
  const draw = () => drawBody(body, editable);
  unsub = subscribe(draw);
  draw();
}

export function unmount() { unsub?.(); unsub = null; aiSuggestions = new Map(); aiBusy = false; }

const bankName = (id) => entities('bankacct').find(b => b.id === id)?.name || id;

function drawBody(body, editable) {
  const pending = entities('staged')
    .filter(s => s.status === 'pending')
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!pending.length) {
    clear(body).append(el('p', { class: 'sub' }, 'All caught up — nothing waiting. Import a CSV from Banking to fill this screen.'));
    return;
  }
  const accountsById = new Map(entities('account').map(a => [a.id, a]));
  const categories = entities('account')
    .filter(a => a.active !== false && a.qbType !== 'BANK' && a.qbType !== 'CCARD')
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  const matchCtx = { vendors: entities('vendor'), history: entities('staged') };

  const suggested = [];
  const unmatched = [];
  const rows = pending.slice(0, 100).map(row => {
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

    const sel = el('select', { class: 'field-input', style: 'margin:0;min-width:180px' },
      el('option', { value: '' }, '— pick a category —'),
      ...categories.map(a => el('option', { value: a.id, selected: sug?.accountId === a.id }, a.name)));
    const approve = el('button', { class: 'btn sm green', disabled: !sug, onclick: () => approveRow(row, sel.value, sug) }, 'Approve');
    sel.addEventListener('change', () => { approve.disabled = !sel.value; });

    const chip = sug
      ? (sug.by === 'rule'
        ? el('span', { class: 'pill blue' }, `⚡ Rule · ${sug.vendorName}`)
        : sug.by === 'ai'
          ? el('span', { class: 'pill amber' }, `✨ AI · ${sug.confidence}%`)
          : el('span', { class: 'pill green' }, '🕘 You did this before'))
      : el('span', { class: 'pill gray' }, 'No match');

    return el('tr', {},
      el('td', {}, row.date),
      el('td', {}, el('b', {}, row.desc.slice(0, 55)), el('div', { class: 'sub', style: 'margin:0;font-size:11px' }, bankName(row.bankacctId))),
      el('td', { class: 'num ' + (row.amountCents < 0 ? 'neg' : 'pos') }, fmtMoney(row.amountCents, { sign: row.amountCents > 0 })),
      el('td', {}, editable ? sel : '—'),
      el('td', {}, chip),
      el('td', {}, editable ? el('div', { style: 'display:flex;gap:6px' }, approve,
        el('button', { class: 'btn sm ghost', onclick: () => skipRow(row) }, 'Skip'),
        el('button', { class: 'btn sm ghost', title: 'Auto-categorize this vendor from now on', onclick: () => makeRuleModal(row, sel.value, categories) }, '⚡')) : ''),
    );
  });

  clear(body).append(
    el('div', { style: 'display:flex;gap:9px;align-items:center;margin-bottom:12px;flex-wrap:wrap' },
      (editable && suggested.length) ? el('button', { class: 'btn sm green', onclick: () => {
        for (const { row, sug } of suggested) approveRow(row, sug.accountId, sug, { quiet: true });
        toast(`${suggested.length} approved`);
      } }, `Approve all suggested (${suggested.length})`) : el('span'),
      (editable && unmatched.length && !aiBusy) ? el('button', { class: 'btn sm', onclick: () => askAI(unmatched, categories, body, editable) }, `✨ Get AI suggestions (${unmatched.length})`) : el('span'),
      aiBusy ? el('span', { class: 'pill gray' }, '✨ Asking Claude…') : el('span'),
      el('span', { class: 'pill amber' }, `${pending.length} waiting`)),
    el('div', { class: 'card', style: 'padding:0;overflow:hidden' },
      el('table', { class: 'data' },
        el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Bank description'), el('th', { class: 'num' }, 'Amount'), el('th', {}, 'Category'), el('th', {}, 'Suggested by'), el('th', {}, '')),
        ...rows)),
    pending.length > 100 ? el('p', { class: 'sub' }, `Showing the first 100 of ${pending.length}.`) : el('span'),
  );
}

function approveRow(row, categoryId, sug, { quiet = false } = {}) {
  const bankacct = entities('bankacct').find(b => b.id === row.bankacctId);
  if (!bankacct || !categoryId) { toast('Pick a category first', 'err'); return; }
  const txn = simpleTxn({
    id: 't-' + row.id,
    date: row.date,
    payee: row.desc,
    amountCents: Math.abs(row.amountCents),
    direction: row.amountCents < 0 ? 'out' : 'in',
    bankAccountId: bankacct.accountId,
    categoryAccountId: categoryId,
    source: { app: 'import', importId: row.importId, sourceId: row.id },
  });
  const v = validateTxn(txn, {
    accountsById: new Map(entities('account').map(a => [a.id, a])),
    locks: new Set(entities('lock').map(l => l.id)),
  });
  if (!v.ok) { toast(v.error, 'err'); return; }
  dispatch({ op: 'entity.upsert', kind: 'txn', value: txn });
  dispatch({ op: 'entity.upsert', kind: 'staged', value: { ...row, status: 'approved', txnId: txn.id, categoryId } });
  if (sug?.vendorId && sug.accountId === categoryId) {
    const vend = entities('vendor').find(x => x.id === sug.vendorId);
    if (vend) dispatch({ op: 'entity.upsert', kind: 'vendor', value: { ...vend, used: (vend.used || 0) + 1 } });
  }
  if (!quiet) toast('Posted to the ledger');
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

function skipRow(row) {
  dispatch({ op: 'entity.upsert', kind: 'staged', value: { ...row, status: 'skipped' } });
  toast('Skipped');
}

function makeRuleModal(row, pickedCategoryId, categories) {
  const m = modal('Auto-categorize this vendor');
  const name = el('input', { class: 'field-input', value: guessVendorName(row.desc) });
  const keyword = el('input', { class: 'field-input', value: guessVendorName(row.desc).toUpperCase() });
  const cat = el('select', { class: 'field-input' },
    el('option', { value: '' }, '— category —'),
    ...categories.map(a => el('option', { value: a.id, selected: a.id === pickedCategoryId }, a.name)));
  m.body.append(
    el('p', { class: 'sub' }, `Bank descriptions containing the match text get this category suggested automatically.`),
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
