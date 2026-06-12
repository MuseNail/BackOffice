// ── view: reports — P&L, Balance Sheet, tax estimate ────────────────
// Always built from posted ledger entries via lib/posting.js — if it's not
// posted, it's not in a report. The Balance Sheet balances structurally:
// every posted txn sums to zero, so assets always equal liabilities + equity
// + net income to date.
import { el, clear, fmtMoney } from '../ui.js';
import { entities, subscribe } from '../store.js';
import { getActiveBiz } from '../session.js';
import { profitAndLoss, activityByAccount, accountBalance } from '../lib/posting.js';

let unsub = null;
let s = null;

const PRESETS = [
  ['this-month', 'This month'],
  ['last-month', 'Last month'],
  ['this-year', 'This year'],
  ['all', 'All time'],
];

function presetRange(key) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const iso = (d) => d.toISOString().slice(0, 10);
  if (key === 'this-month') return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) };
  if (key === 'last-month') return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
  if (key === 'this-year') return { from: `${y}-01-01`, to: `${y}-12-31` };
  return {};
}

export function render(root) {
  s = { preset: 'this-month', asOf: new Date().toISOString().slice(0, 10) };
  const body = el('div');
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

function drawBody(body) {
  const txns = entities('txn');
  const accounts = entities('account');
  const accountsById = new Map(accounts.map(a => [a.id, a]));
  const range = presetRange(s.preset);

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
      rows.push({ name: a.name, cents: display });
      total += display;
    }
    rows.sort((x, y) => y.cents - x.cents);
    return { rows, total };
  };
  const income = group(['income']);
  const cogs = group(['cogs']);
  const expenses = group(['expense']);
  const gross = income.total - cogs.total;
  const net = gross - expenses.total;

  const plRows = [];
  const section = (title, g, totalLabel) => {
    if (!g.rows.length) return;
    plRows.push(el('tr', {}, el('td', { class: 'coatype', colspan: '2', style: 'padding-top:12px' }, title)));
    for (const r of g.rows) plRows.push(el('tr', {}, el('td', { style: 'padding-left:24px' }, r.name), el('td', { class: 'num' }, fmtMoney(r.cents))));
    plRows.push(el('tr', {}, el('td', {}, el('b', {}, totalLabel)), el('td', { class: 'num' }, el('b', {}, fmtMoney(g.total)))));
  };
  section('Income', income, 'Total income');
  if (cogs.rows.length) {
    section('Cost of goods', cogs, 'Total cost of goods');
    plRows.push(el('tr', { style: 'background:var(--brand-soft)' }, el('td', {}, el('b', {}, 'Gross profit')), el('td', { class: 'num' }, el('b', {}, fmtMoney(gross)))));
  }
  section('Expenses', expenses, 'Total expenses');
  plRows.push(el('tr', { style: net >= 0 ? 'background:var(--green-soft)' : 'background:var(--red-soft)' },
    el('td', {}, el('b', {}, 'Net profit')),
    el('td', { class: 'num' }, el('b', { style: net >= 0 ? 'color:var(--green)' : 'color:var(--red)' }, fmtMoney(net)))));

  // ── Balance Sheet (as of s.asOf) ──
  const bal = (a) => accountBalance(txns, a.id, { to: s.asOf });
  const bsGroup = (type, flip) => {
    const rows = [];
    let total = 0;
    for (const a of accounts.filter(x => x.type === type)) {
      const cents = flip ? -bal(a) : bal(a);
      if (cents === 0) continue;
      rows.push({ name: a.name, cents });
      total += cents;
    }
    rows.sort((x, y) => y.cents - x.cents);
    return { rows, total };
  };
  const assets = bsGroup('asset', false);
  const liabilities = bsGroup('liability', true);
  const equity = bsGroup('equity', true);
  let netToDate = 0;
  for (const a of accounts.filter(x => ['income', 'cogs', 'expense'].includes(x.type))) netToDate += -bal(a);

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

  // ── tax estimate (device-local rate — an estimate, not advice or books data) ──
  const rateKey = `bo_tax_rate_${getActiveBiz()}`;
  const rate = parseFloat(localStorage.getItem(rateKey) || '25');
  const setAside = net > 0 ? Math.round(net * rate / 100) : 0;
  const rateIn = el('input', { class: 'field-input', style: 'max-width:90px;margin:0', inputmode: 'decimal', value: String(rate),
    onchange: (e) => { const v = parseFloat(e.target.value); if (v >= 0 && v <= 99) localStorage.setItem(rateKey, String(v)); drawBody(body); } });

  clear(body).append(
    el('div', { style: 'display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap' },
      ...PRESETS.map(([key, label]) => el('button', {
        class: 'btn sm ' + (s.preset === key ? '' : 'ghost'),
        onclick: () => { s.preset = key; drawBody(body); },
      }, label))),
    el('div', { class: 'row' },
      el('div', { class: 'card', style: 'flex:1;min-width:330px;max-width:460px' },
        el('div', { class: 'cardtitle' }, `Profit & Loss — ${PRESETS.find(p => p[0] === s.preset)[1]}`),
        plRows.length > 1 ? el('table', { class: 'data' }, ...plRows) : el('p', { class: 'sub' }, 'No activity in this range.')),
      el('div', { class: 'card', style: 'flex:1;min-width:330px;max-width:460px' },
        el('div', { class: 'cardtitle' }, 'Balance Sheet'),
        el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:8px' },
          el('span', { class: 'field-label', style: 'margin:0' }, 'As of'),
          el('input', { class: 'field-input', type: 'date', style: 'max-width:160px;margin:0', value: s.asOf,
            onchange: (e) => { s.asOf = e.target.value; drawBody(body); } })),
        el('table', { class: 'data' }, ...bsRows)),
      el('div', { class: 'card', style: 'flex:1;min-width:240px;max-width:300px' },
        el('div', { class: 'cardtitle' }, 'Tax set-aside estimate'),
        el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:8px' }, rateIn, el('span', { class: 'sub', style: 'margin:0' }, '% of net profit')),
        el('div', { class: 'kpi' }, fmtMoney(setAside)),
        el('p', { class: 'sub' }, `${rate}% of ${fmtMoney(net)} net for the selected range. A rough planning number — not tax advice.`))),
  );
}
