// ── view: reports — P&L, Balance Sheet, tax estimate ────────────────
// Always built from posted ledger entries via lib/posting.js — if it's not
// posted, it's not in a report. The Balance Sheet balances structurally:
// every posted txn sums to zero, so assets always equal liabilities + equity
// + net income to date.
import { el, clear, fmtMoney } from '../ui.js';
import { entities, subscribe } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { activityByAccount, accountBalance } from '../lib/posting.js';
import { accountLabel } from '../lib/coa-templates.js';
import { dateRangeControl, dateControl, presetRange, rangeLabel } from '../daterange.js';

let unsub = null;
let s = null;

export function render(root) {
  s = { asOf: new Date().toISOString().slice(0, 10), range: presetRange('month') };
  const body = el('div');
  // Built once so the smart date picker keeps its state across the redraws that
  // store changes trigger.
  s.rangeCtl = dateRangeControl({ initial: 'month', onChange: (r) => { s.range = r; drawBody(body); } });
  root.append(
    el('h2', {}, 'Reports'),
    el('p', { class: 'sub' }, 'Built from posted entries only — staged and voided transactions never appear here.'),
    body,
  );
  const draw = () => drawBody(body);
  unsub = subscribe(draw);
  draw();
}

export function unmount() { unsub?.(); unsub = null; s = null; }

// Build a CSV of the P&L + Balance Sheet from the same grouped data the view renders.
function buildReportsCsv(presetLabel, asOf, pl, bs) {
  const esc = (v) => { const t = String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const d = (cents) => (cents / 100).toFixed(2);
  const lines = [];
  const row = (...cols) => lines.push(cols.map(esc).join(','));
  row('Profit & Loss', presetLabel);
  row('Section', 'Account', 'Amount');
  const plSec = (title, g, totalLabel) => {
    if (!g.rows.length) return;
    for (const r of g.rows) row(title, r.name, d(r.cents));
    row('', totalLabel, d(g.total));
  };
  plSec('Income', pl.income, 'Total income');
  plSec('Cost of goods', pl.cogs, 'Total cost of goods');
  plSec('Expenses', pl.expenses, 'Total expenses');
  plSec('Other expenses', pl.otherExp, 'Total other expenses');
  row('', 'Net income', d(pl.net));
  row('');
  row('Balance Sheet', 'as of ' + asOf);
  row('Section', 'Account', 'Amount');
  const bsSec = (title, g, totalLabel, extra) => {
    for (const r of g.rows) row(title, r.name, d(r.cents));
    if (extra) row(title, extra.name, d(extra.cents));
    row('', totalLabel, d(g.total + (extra ? extra.cents : 0)));
  };
  bsSec('Assets', bs.assets, 'Total assets');
  bsSec('Liabilities', bs.liabilities, 'Total liabilities');
  bsSec('Equity', bs.equity, 'Total equity', { name: 'Net income to date', cents: bs.netToDate });
  return lines.join('\n');
}

function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function drawBody(body) {
  const txns = entities('txn');
  const accounts = entities('account');
  const accountsById = new Map(accounts.map(a => [a.id, a]));
  const range = s.range || presetRange('month');

  // ── P&L ──
  const act = activityByAccount(txns, range);
  const group = (types) => {
    const rows = [];
    let total = 0;
    for (const [accountId, cents] of act) {
      const a = accountsById.get(accountId);
      if (!a || !types.includes(a.type)) continue;
      const display = a.type === 'income' ? -cents : cents;
      if (display === 0) continue;
      rows.push({ name: accountLabel(a, accountsById), cents: display });
      total += display;
    }
    rows.sort((x, y) => y.cents - x.cents);
    return { rows, total };
  };
  const income = group(['income']);
  const cogs = group(['cogs']);
  const expenses = group(['expense']);
  const otherExp = group(['other-expense', 'personal-expense']);
  const gross = income.total - cogs.total;
  const netOrdinary = gross - expenses.total;          // before below-the-line items
  const net = netOrdinary - otherExp.total;            // adjusted net income

  const plRows = [];
  const section = (title, g, totalLabel) => {
    if (!g.rows.length) return;
    plRows.push(el('tr', {}, el('td', { class: 'coatype', colspan: '2', style: 'padding-top:12px' }, title)));
    for (const r of g.rows) plRows.push(el('tr', {}, el('td', { style: 'padding-left:24px' }, r.name), el('td', { class: 'num' }, fmtMoney(r.cents))));
    plRows.push(el('tr', {}, el('td', {}, el('b', {}, totalLabel)), el('td', { class: 'num' }, el('b', {}, fmtMoney(g.total)))));
  };
  const netRow = (label, value, soft) => plRows.push(el('tr', { style: soft },
    el('td', {}, el('b', {}, label)),
    el('td', { class: 'num' }, el('b', { style: value >= 0 ? 'color:var(--green)' : 'color:var(--red)' }, fmtMoney(value)))));
  section('Income', income, 'Total income');
  if (cogs.rows.length) {
    section('Cost of goods', cogs, 'Total cost of goods');
    plRows.push(el('tr', { style: 'background:var(--brand-soft)' }, el('td', {}, el('b', {}, 'Gross profit')), el('td', { class: 'num' }, el('b', {}, fmtMoney(gross)))));
  }
  section('Expenses', expenses, 'Total expenses');
  if (otherExp.rows.length) {
    // Below-the-line: net ordinary income first, then other/personal expenses,
    // then the adjusted net income.
    netRow('Net ordinary income', netOrdinary, 'background:var(--brand-soft)');
    section('Other expenses', otherExp, 'Total other expenses');
    netRow('Net income', net, net >= 0 ? 'background:var(--green-soft)' : 'background:var(--red-soft)');
  } else {
    netRow('Net profit', net, net >= 0 ? 'background:var(--green-soft)' : 'background:var(--red-soft)');
  }

  // ── Balance Sheet (as of s.asOf) ──
  const bal = (a) => accountBalance(txns, a.id, { to: s.asOf });
  const bsGroup = (type, flip) => {
    const rows = [];
    let total = 0;
    for (const a of accounts.filter(x => x.type === type)) {
      const cents = flip ? -bal(a) : bal(a);
      if (cents === 0) continue;
      rows.push({ name: accountLabel(a, accountsById), cents });
      total += cents;
    }
    rows.sort((x, y) => y.cents - x.cents);
    return { rows, total };
  };
  const assets = bsGroup('asset', false);
  const liabilities = bsGroup('liability', true);
  const equity = bsGroup('equity', true);
  let netToDate = 0;
  for (const a of accounts.filter(x => ['income', 'cogs', 'expense', 'other-expense', 'personal-expense'].includes(x.type))) netToDate += -bal(a);

  const bsRows = [];
  const bsSection = (title, g, totalLabel, extra = null) => {
    bsRows.push(el('tr', {}, el('td', { class: 'coatype', colspan: '2', style: 'padding-top:12px' }, title)));
    for (const r of g.rows) bsRows.push(el('tr', {}, el('td', { style: 'padding-left:24px' }, r.name), el('td', { class: 'num' }, fmtMoney(r.cents))));
    if (extra) { bsRows.push(el('tr', {}, el('td', { style: 'padding-left:24px' }, extra.name), el('td', { class: 'num' }, fmtMoney(extra.cents)))); }
    bsRows.push(el('tr', {}, el('td', {}, el('b', {}, totalLabel)), el('td', { class: 'num' }, el('b', {}, fmtMoney(g.total + (extra?.cents || 0))))));
  };
  bsSection('Assets', assets, 'Total assets');
  bsSection('Liabilities', liabilities, 'Total liabilities');
  bsSection('Equity', equity, 'Total equity', { name: 'Net income to date', cents: netToDate });
  const liabEq = liabilities.total + equity.total + netToDate;
  const balanced = assets.total === liabEq;
  bsRows.push(el('tr', { style: 'background:' + (balanced ? 'var(--brand-soft)' : 'var(--red-soft)') },
    el('td', {}, el('b', {}, 'Liabilities + equity')),
    el('td', { class: 'num' }, el('b', {}, fmtMoney(liabEq) + (balanced ? ' ✓' : ' ≠ assets!')))));

  // ── tax estimate (a planning number, not advice or books data) ──
  // The rate is a synced taxsetting entity so every device shares it. localStorage
  // is the fallback (and pre-sync cache) — read entity-first, fall back to it, then
  // 25%. NOTE: the synced path needs the Worker to know 'taxsetting' (ENTITY_KINDS);
  // until that's deployed the rate stays device-local via localStorage (no regression).
  const rateKey = `bo_tax_rate_${getActiveBiz()}`;
  const synced = entities('taxsetting').find(t => t.id === 'tax');
  const rate = (synced && typeof synced.rate === 'number') ? synced.rate
    : parseFloat(localStorage.getItem(rateKey) || '25');
  const taxEditable = canEdit(getActiveBiz());
  const setAside = net > 0 ? Math.round(net * rate / 100) : 0;
  const rateIn = el('input', { class: 'field-input', style: 'max-width:90px;margin:0', inputmode: 'decimal', value: String(rate), disabled: !taxEditable,
    onchange: (e) => {
      const v = parseFloat(e.target.value);
      if (!(v >= 0 && v <= 99)) { drawBody(body); return; }
      localStorage.setItem(rateKey, String(v));
      dispatch({ op: 'entity.upsert', kind: 'taxsetting', value: { id: 'tax', rate: v, updatedAt: Date.now() } });
      drawBody(body);
    } });

  const presetLabel = rangeLabel(range);
  clear(body).append(
    el('div', { class: 'no-print', style: 'display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center' },
      el('span', { class: 'field-label', style: 'margin:0' }, 'Period'),
      s.rangeCtl.el,
      el('span', { style: 'flex:1' }),
      el('button', { class: 'btn sm ghost', onclick: () => window.print() }, 'Print / PDF'),
      el('button', { class: 'btn sm ghost', onclick: () => downloadCsv(
        `${getActiveBiz()}-reports.csv`,
        buildReportsCsv(presetLabel, s.asOf, { income, cogs, expenses, otherExp, net }, { assets, liabilities, equity, netToDate })) }, 'Export CSV')),
    el('div', { class: 'row' },
      el('div', { class: 'card', style: 'flex:1;min-width:330px;max-width:460px' },
        el('div', { class: 'cardtitle' }, `Profit & Loss — ${presetLabel}`),
        plRows.length > 1 ? el('table', { class: 'data' }, ...plRows) : el('p', { class: 'sub' }, 'No activity in this range.')),
      el('div', { class: 'card', style: 'flex:1;min-width:330px;max-width:460px' },
        el('div', { class: 'cardtitle' }, 'Balance Sheet'),
        el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:8px' },
          el('span', { class: 'field-label', style: 'margin:0' }, 'As of'),
          dateControl({ value: s.asOf, onPick: (iso) => { s.asOf = iso; drawBody(body); } }).el),
        el('table', { class: 'data' }, ...bsRows)),
      el('div', { class: 'card', style: 'flex:1;min-width:240px;max-width:300px' },
        el('div', { class: 'cardtitle' }, 'Tax set-aside estimate'),
        el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:8px' }, rateIn, el('span', { class: 'sub', style: 'margin:0' }, '% of net profit')),
        el('div', { class: 'kpi' }, fmtMoney(setAside)),
        el('p', { class: 'sub' }, `${rate}% of ${fmtMoney(net)} net for the selected range. A rough planning number — not tax advice.`))),
  );
}
