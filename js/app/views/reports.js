// ── view: reports — P&L, Balance Sheet, tax estimate ────────────────
// Always built from posted ledger entries via lib/posting.js — if it's not
// posted, it's not in a report. The Balance Sheet balances structurally:
// every posted txn sums to zero, so assets always equal liabilities + equity
// + net income to date.
import { el, clear, fmtMoney, modal } from '../ui.js';
import { entities, subscribe } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { activityByAccount, accountBalance } from '../lib/posting.js';
import { accountLabel } from '../lib/coa-templates.js';
import { dateRangeControl, dateControl, presetRange, rangeLabel } from '../daterange.js';
import { editTxnModal } from './ledger.js';

let unsub = null;
let s = null;
// P&L parent accounts the user has expanded to reveal their children. Module-level so
// it survives the redraws store changes trigger.
let plExpanded = new Set();

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

export function unmount() { unsub?.(); unsub = null; s = null; plExpanded = new Set(); }

// Drill-down: every posted transaction hitting an account within the current range.
// Each row opens the Ledger's transaction editor; the list re-renders on any change.
function openAccountTxns(account, label) {
  let unsubM = null;
  const m = modal(`${label} — ${rangeLabel(s.range || presetRange('month'))}`, () => unsubM?.());
  const host = el('div');
  m.body.append(host);
  const draw = () => {
    const r = s.range || presetRange('month');
    const lineOn = (t) => (t.lines || []).filter(l => l.accountId === account.id).reduce((a, l) => a + l.amountCents, 0);
    const disp = (t) => account.type === 'income' ? -lineOn(t) : lineOn(t);
    const txns = entities('txn').filter(t => t.status === 'posted'
      && (!r.from || t.date >= r.from) && (!r.to || t.date <= r.to)
      && (t.lines || []).some(l => l.accountId === account.id))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const total = txns.reduce((sum, t) => sum + disp(t), 0);
    clear(host).append(
      el('p', { class: 'sub', style: 'margin:0 0 8px' }, `${txns.length} transaction${txns.length === 1 ? '' : 's'} · ${fmtMoney(total)}`),
      txns.length ? el('div', { class: 'card', style: 'padding:0;overflow:auto;max-height:55vh;margin:0' },
        el('table', { class: 'data' },
          el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Payee / memo'), el('th', { class: 'num' }, 'Amount')),
          ...txns.map(t => el('tr', { style: 'cursor:pointer', title: 'Edit transaction', onclick: () => editTxnModal(t) },
            el('td', { style: 'white-space:nowrap' }, t.date),
            el('td', {}, el('b', {}, t.payee || '—'), t.memo ? el('div', { class: 'sub', style: 'margin:0' }, t.memo.slice(0, 90)) : ''),
            el('td', { class: 'num ' + (disp(t) < 0 ? 'neg' : 'pos') }, fmtMoney(disp(t)))))))
        : el('p', { class: 'sub' }, 'No transactions in this range.'));
  };
  draw();
  unsubM = subscribe(draw);
}

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
  // Display amount for an account in P&L sign convention (income shown positive).
  const displayCents = (a) => { const c = act.get(a.id) || 0; return a.type === 'income' ? -c : c; };
  // Hierarchical group: top-level accounts each carry their own activity + a rolled-up
  // total of their children. `nodes` drives the (expandable) display; `rows` is the
  // flat list the CSV export uses.
  const group = (types) => {
    const tops = accounts.filter(a => types.includes(a.type) && !a.parentId);
    const topIds = new Set(tops.map(a => a.id));
    const orphans = accounts.filter(a => types.includes(a.type) && a.parentId && !topIds.has(a.parentId));
    const nodes = [], rows = [];
    let total = 0;
    for (const a of tops) {
      const own = displayCents(a);
      const kids = accounts.filter(x => x.parentId === a.id && types.includes(x.type))
        .map(k => ({ account: k, amount: displayCents(k) }))
        .sort((x, y) => y.amount - x.amount);
      const childSum = kids.reduce((s, k) => s + k.amount, 0);
      const nodeTotal = own + childSum;
      const visibleKids = kids.filter(k => k.amount !== 0);
      if (nodeTotal === 0 && !visibleKids.length) continue;
      nodes.push({ account: a, own, total: nodeTotal, children: visibleKids });
      total += nodeTotal;
      if (visibleKids.length) {
        if (own !== 0) rows.push({ name: accountLabel(a, accountsById) + ' (direct)', cents: own });
        for (const k of visibleKids) rows.push({ name: accountLabel(k.account, accountsById), cents: k.amount });
      } else {
        rows.push({ name: accountLabel(a, accountsById), cents: nodeTotal });
      }
    }
    for (const o of orphans) {
      const amt = displayCents(o);
      if (amt === 0) continue;
      nodes.push({ account: o, own: amt, total: amt, children: [] });
      total += amt;
      rows.push({ name: accountLabel(o, accountsById), cents: amt });
    }
    nodes.sort((x, y) => y.total - x.total);
    rows.sort((x, y) => y.cents - x.cents);
    return { nodes, rows, total };
  };
  const income = group(['income']);
  const cogs = group(['cogs']);
  const expenses = group(['expense']);
  const otherExp = group(['other-expense', 'personal-expense']);
  const gross = income.total - cogs.total;
  const netOrdinary = gross - expenses.total;          // before below-the-line items
  const net = netOrdinary - otherExp.total;            // adjusted net income

  const plRows = [];
  // A clickable leaf row → opens the account's transactions for the range.
  const leafRow = (account, cents, label, padLeft) => el('tr', { style: 'cursor:pointer', title: 'View transactions', onclick: () => openAccountTxns(account, label) },
    el('td', { style: `padding-left:${padLeft}px` }, label, el('span', { class: 'linklike', style: 'margin-left:6px;font-size:11px' }, '›')),
    el('td', { class: 'num' }, fmtMoney(cents)));
  const section = (title, g, totalLabel) => {
    if (!g.nodes.length) return;
    plRows.push(el('tr', {}, el('td', { class: 'coatype', colspan: '2', style: 'padding-top:12px' }, title)));
    for (const node of g.nodes) {
      if (node.children.length) {
        const open = plExpanded.has(node.account.id);
        plRows.push(el('tr', { style: 'cursor:pointer', title: open ? 'Collapse' : 'Show sub-accounts',
          onclick: () => { open ? plExpanded.delete(node.account.id) : plExpanded.add(node.account.id); drawBody(body); } },
          el('td', { style: 'padding-left:4px' },
            el('span', { class: 'ms', style: 'font-size:18px;vertical-align:-4px;color:var(--mut)' }, open ? 'expand_more' : 'chevron_right'),
            ' ', el('b', {}, node.account.name)),
          el('td', { class: 'num' }, el('b', {}, fmtMoney(node.total)))));
        if (open) {
          if (node.own !== 0) plRows.push(leafRow(node.account, node.own, node.account.name + ' (direct)', 36));
          for (const k of node.children) plRows.push(leafRow(k.account, k.amount, k.account.name, 36));
        }
      } else {
        plRows.push(leafRow(node.account, node.total, node.account.name, 24));
      }
    }
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
      el('span', { style: 'flex:1' }),
      el('button', { class: 'btn sm ghost', onclick: () => window.print() }, 'Print / PDF'),
      el('button', { class: 'btn sm ghost', onclick: () => downloadCsv(
        `${getActiveBiz()}-reports.csv`,
        buildReportsCsv(presetLabel, s.asOf, { income, cogs, expenses, otherExp, net }, { assets, liabilities, equity, netToDate })) }, 'Export CSV')),
    el('div', { class: 'row' },
      // P&L and Balance Sheet headers share the same flex layout (title left, date
      // picker right) so their first section rows — Income / Assets — line up.
      // Both headers are two rows — title, then the date picker — so each panel's
      // first section row (Income / Assets) starts at the same height.
      el('div', { class: 'card', style: 'flex:1;min-width:330px;max-width:460px' },
        el('div', { style: 'margin-bottom:10px' },
          el('div', { class: 'cardtitle', style: 'margin:0 0 6px' }, 'Profit & Loss'),
          el('div', { style: 'display:flex;gap:6px;align-items:center' },
            el('span', { class: 'field-label', style: 'margin:0' }, 'Period'),
            s.rangeCtl.el)),
        plRows.length > 1 ? el('table', { class: 'data' }, ...plRows) : el('p', { class: 'sub' }, 'No activity in this range.')),
      el('div', { class: 'card', style: 'flex:1;min-width:330px;max-width:460px' },
        el('div', { style: 'margin-bottom:10px' },
          el('div', { class: 'cardtitle', style: 'margin:0 0 6px' }, 'Balance Sheet'),
          el('div', { style: 'display:flex;gap:6px;align-items:center' },
            el('span', { class: 'field-label', style: 'margin:0' }, 'As of'),
            dateControl({ value: s.asOf, onPick: (iso) => { s.asOf = iso; drawBody(body); } }).el)),
        el('table', { class: 'data' }, ...bsRows)),
      el('div', { class: 'card', style: 'flex:1;min-width:240px;max-width:300px' },
        el('div', { class: 'cardtitle' }, 'Tax set-aside estimate'),
        el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:8px' }, rateIn, el('span', { class: 'sub', style: 'margin:0' }, '% of net profit')),
        el('div', { class: 'kpi' }, fmtMoney(setAside)),
        el('p', { class: 'sub' }, `${rate}% of ${fmtMoney(net)} net for the selected range. A rough planning number — not tax advice.`))),
  );
}
