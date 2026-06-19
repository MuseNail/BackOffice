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
  s = {
    asOf: new Date().toISOString().slice(0, 10),
    range: presetRange('month'),
    compare: 'none',       // 'none' | 'prev' | 'ly' | 'trend'
    pctOfIncome: false,    // common-size column (each line as % of total income)
  };
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

// ── Comparison-period helpers (pure date math, local-time to avoid TZ drift) ──
const MABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');
const fmtLocal = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseIso = (iso) => new Date(iso + 'T00:00:00');
function addDaysIso(iso, n) { const d = parseIso(iso); d.setDate(d.getDate() + n); return fmtLocal(d); }
function addYearsIso(iso, n) { const d = parseIso(iso); d.setFullYear(d.getFullYear() + n); return fmtLocal(d); }

// The period to compare the selected range against. 'ly' = same dates a year back;
// 'prev' = the same-length window immediately before. Null when the range is unbounded
// (All time) — there's nothing meaningful to compare against.
function comparisonRange(range, mode) {
  if (!range.from || !range.to) return null;
  if (mode === 'ly') return { from: addYearsIso(range.from, -1), to: addYearsIso(range.to, -1) };
  const days = Math.round((parseIso(range.to) - parseIso(range.from)) / 86400000) + 1;
  return { from: addDaysIso(range.from, -days), to: addDaysIso(range.to, -days) };
}

// One {label, from, to} bucket per calendar month in the range (≤12, most-recent kept).
// Unbounded range → the last 12 months ending today.
function monthBuckets(range) {
  let sy, sm, ey, em;
  if (range.from && range.to) {
    const f = parseIso(range.from), t = parseIso(range.to);
    sy = f.getFullYear(); sm = f.getMonth(); ey = t.getFullYear(); em = t.getMonth();
  } else {
    const now = new Date(); ey = now.getFullYear(); em = now.getMonth();
    const s0 = new Date(ey, em - 11, 1); sy = s0.getFullYear(); sm = s0.getMonth();
  }
  const out = [];
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    const last = new Date(y, m + 1, 0).getDate();
    out.push({ label: `${MABBR[m]} ’${String(y).slice(2)}`, from: `${y}-${pad2(m + 1)}-01`, to: `${y}-${pad2(m + 1)}-${pad2(last)}` });
    m++; if (m > 11) { m = 0; y++; }
  }
  return out.length > 12 ? out.slice(out.length - 12) : out;
}

// Compact label for a column header: "Jun 2026" / "2026" / "Jun 1 – Jul 15" / "All time".
function compactRangeLabel(range) {
  if (!range || (!range.from && !range.to)) return 'All time';
  const f = parseIso(range.from), t = parseIso(range.to);
  const firstOf = f.getDate() === 1;
  const lastOf = t.getDate() === new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  const sameMonth = f.getFullYear() === t.getFullYear() && f.getMonth() === t.getMonth();
  if (firstOf && lastOf && sameMonth) return `${MABBR[f.getMonth()]} ${f.getFullYear()}`;
  if (firstOf && lastOf && f.getMonth() === 0 && t.getMonth() === 11 && f.getFullYear() === t.getFullYear()) return `${f.getFullYear()}`;
  const sd = (d) => `${MABBR[d.getMonth()]} ${d.getDate()}`;
  return `${sd(f)} – ${sd(t)}`;
}

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
// `cmp` carries the active comparison so the export columns mirror what's on screen.
function buildReportsCsv(presetLabel, asOf, pl, bs, cmp) {
  const esc = (v) => { const t = String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const d = (cents) => (cents / 100).toFixed(2);
  const lines = [];
  const row = (...cols) => lines.push(cols.map(esc).join(','));
  const pctOf = (c) => (cmp.incomeTotal ? (c / cmp.incomeTotal * 100).toFixed(1) : '');
  const pctChg = (c, cm) => (cm ? ((c - cm) / cm * 100).toFixed(1) : '');

  if (cmp.mode === 'trend') {
    row('Profit & Loss', 'Monthly trend');
    row('Section', 'Account', ...cmp.bucketLabels);
    const sec = (title, g, totalLabel) => {
      if (!g.nodes.length) return;
      for (const r of g.rows) row(title, r.name, ...r.trend.map(d));
      row('', totalLabel, ...g.totalTrend.map(d));
    };
    sec('Income', pl.income, 'Total income');
    if (pl.cogs.nodes.length) { sec('Cost of goods', pl.cogs, 'Total cost of goods'); row('', 'Gross profit', ...pl.grossTrend.map(d)); }
    sec('Expenses', pl.expenses, 'Total expenses');
    sec('Other expenses', pl.otherExp, 'Total other expenses');
    row('', 'Net income', ...pl.netTrend.map(d));
  } else if (cmp.mode === 'prev' || cmp.mode === 'ly') {
    row('Profit & Loss', `${cmp.curLabel} vs ${cmp.cmpLabel}`);
    const head = ['Section', 'Account', cmp.curLabel];
    if (cmp.pctOn) head.push('% of income');
    head.push(cmp.cmpLabel, 'Change ($)', 'Change (%)');
    row(...head);
    const line = (title, name, c, cm) => {
      const cols = [title, name, d(c)];
      if (cmp.pctOn) cols.push(pctOf(c));
      cols.push(d(cm), d(c - cm), pctChg(c, cm));
      row(...cols);
    };
    const sec = (title, g, totalLabel) => {
      if (!g.nodes.length) return;
      for (const r of g.rows) line(title, r.name, r.cents, r.centsCmp);
      line('', totalLabel, g.total, g.totalCmp);
    };
    sec('Income', pl.income, 'Total income');
    if (pl.cogs.nodes.length) { sec('Cost of goods', pl.cogs, 'Total cost of goods'); line('', 'Gross profit', pl.gross, pl.grossCmp); }
    sec('Expenses', pl.expenses, 'Total expenses');
    sec('Other expenses', pl.otherExp, 'Total other expenses');
    line('', 'Net income', pl.net, pl.netCmp);
  } else {
    row('Profit & Loss', presetLabel);
    const head = ['Section', 'Account', 'Amount'];
    if (cmp.pctOn) head.push('% of income');
    row(...head);
    const line = (title, name, c) => { const cols = [title, name, d(c)]; if (cmp.pctOn) cols.push(pctOf(c)); row(...cols); };
    const sec = (title, g, totalLabel) => {
      if (!g.nodes.length) return;
      for (const r of g.rows) line(title, r.name, r.cents);
      line('', totalLabel, g.total);
    };
    sec('Income', pl.income, 'Total income');
    if (pl.cogs.nodes.length) { sec('Cost of goods', pl.cogs, 'Total cost of goods'); line('', 'Gross profit', pl.gross); }
    sec('Expenses', pl.expenses, 'Total expenses');
    sec('Other expenses', pl.otherExp, 'Total other expenses');
    line('', 'Net income', pl.net);
  }

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

  // ── comparison context ──
  const cmpMode = s.compare;
  const cmpRange = (cmpMode === 'prev' || cmpMode === 'ly') ? comparisonRange(range, cmpMode) : null;
  const modeTrend = cmpMode === 'trend';
  const buckets = modeTrend ? monthBuckets(range) : [];
  const act = activityByAccount(txns, range);
  const actCmp = cmpRange ? activityByAccount(txns, cmpRange) : null;
  const actBuckets = modeTrend ? buckets.map(b => activityByAccount(txns, b)) : null;
  const mode2 = !!actCmp;                       // a two-period (prev / last-year) comparison
  const pctOn = s.pctOfIncome && !modeTrend;    // % of income column
  const colspan = modeTrend ? (1 + buckets.length) : (mode2 ? (pctOn ? 5 : 4) : (pctOn ? 3 : 2));

  const nz = (...xs) => xs.some(x => x !== 0);
  // Display amount for an account in P&L sign convention (income shown positive).
  const dispFrom = (m, a) => a.type === 'income' ? -(m.get(a.id) || 0) : (m.get(a.id) || 0);

  // Hierarchical group: top-level accounts each carry their own activity + a rolled-up
  // total of their children, for the current period (own/total), the comparison period
  // (ownCmp/totalCmp) and the month buckets (ownTrend/totalTrend). `nodes` drives the
  // (expandable) display; `rows` is the flat list the CSV export uses.
  const group = (types) => {
    const tops = accounts.filter(a => types.includes(a.type) && !a.parentId);
    const topIds = new Set(tops.map(a => a.id));
    const orphans = accounts.filter(a => types.includes(a.type) && a.parentId && !topIds.has(a.parentId));
    const cur = (a) => dispFrom(act, a);
    const cmp = (a) => actCmp ? dispFrom(actCmp, a) : 0;
    const trd = (a) => actBuckets ? actBuckets.map(m => dispFrom(m, a)) : [];
    const nodes = [], rows = [];
    let total = 0, totalCmp = 0;
    const totalTrend = actBuckets ? actBuckets.map(() => 0) : [];
    const pushRow = (name, cents, centsCmp, trend) => rows.push({ name, cents, centsCmp, trend });
    for (const a of tops) {
      const own = cur(a), ownCmp = cmp(a), ownTrend = trd(a);
      const kids = accounts.filter(x => x.parentId === a.id && types.includes(x.type))
        .map(k => ({ account: k, amount: cur(k), amountCmp: cmp(k), trend: trd(k) }))
        .sort((x, y) => y.amount - x.amount);
      const sumKids = kids.reduce((sm, k) => sm + k.amount, 0);
      const sumKidsCmp = kids.reduce((sm, k) => sm + k.amountCmp, 0);
      const nodeTotal = own + sumKids, nodeTotalCmp = ownCmp + sumKidsCmp;
      const nodeTrend = ownTrend.map((v, i) => v + kids.reduce((sm, k) => sm + (k.trend[i] || 0), 0));
      const visibleKids = kids.filter(k => nz(k.amount, k.amountCmp, ...(k.trend || [])));
      if (!nz(nodeTotal, nodeTotalCmp, ...nodeTrend) && !visibleKids.length) continue;
      nodes.push({ account: a, own, ownCmp, ownTrend, total: nodeTotal, totalCmp: nodeTotalCmp, totalTrend: nodeTrend, children: visibleKids });
      total += nodeTotal; totalCmp += nodeTotalCmp; nodeTrend.forEach((v, i) => totalTrend[i] += v);
      if (visibleKids.length) {
        if (nz(own, ownCmp, ...(ownTrend || []))) pushRow(accountLabel(a, accountsById) + ' (direct)', own, ownCmp, ownTrend);
        for (const k of visibleKids) pushRow(accountLabel(k.account, accountsById), k.amount, k.amountCmp, k.trend);
      } else {
        pushRow(accountLabel(a, accountsById), nodeTotal, nodeTotalCmp, nodeTrend);
      }
    }
    for (const o of orphans) {
      const amt = cur(o), amtCmp = cmp(o), tr = trd(o);
      if (!nz(amt, amtCmp, ...(tr || []))) continue;
      nodes.push({ account: o, own: amt, ownCmp: amtCmp, ownTrend: tr, total: amt, totalCmp: amtCmp, totalTrend: tr, children: [] });
      total += amt; totalCmp += amtCmp; tr.forEach((v, i) => totalTrend[i] += v);
      pushRow(accountLabel(o, accountsById), amt, amtCmp, tr);
    }
    nodes.sort((x, y) => y.total - x.total);
    rows.sort((x, y) => y.cents - x.cents);
    return { nodes, rows, total, totalCmp, totalTrend };
  };
  const income = group(['income']);
  const cogs = group(['cogs']);
  const expenses = group(['expense']);
  const otherExp = group(['other-expense', 'personal-expense']);
  const gross = income.total - cogs.total;
  const grossCmp = income.totalCmp - cogs.totalCmp;
  const grossTrend = income.totalTrend.map((v, i) => v - (cogs.totalTrend[i] || 0));
  const netOrdinary = gross - expenses.total;
  const netOrdinaryCmp = grossCmp - expenses.totalCmp;
  const netOrdinaryTrend = grossTrend.map((v, i) => v - (expenses.totalTrend[i] || 0));
  const net = netOrdinary - otherExp.total;
  const netCmp = netOrdinaryCmp - otherExp.totalCmp;
  const netTrend = netOrdinaryTrend.map((v, i) => v - (otherExp.totalTrend[i] || 0));

  const incTot = income.total;
  const pctStr = (c) => (incTot ? (c / incTot * 100).toFixed(1) + '%' : '—');

  // Variance cell: colored by impact on profit (favorable = green, unfavorable = red).
  // For income/gross/net a rise is favorable; for cost/expense a rise is unfavorable.
  const changeCell = (c, cm, good) => {
    const dd = c - cm;
    if (dd === 0) return el('td', { class: 'num', style: 'color:var(--mut)' }, fmtMoney(0));
    const fav = good === 'up' ? dd > 0 : dd < 0;
    const col = fav ? 'var(--green)' : 'var(--red)';
    const tri = dd > 0 ? '▲' : '▼';
    const pctText = cm ? `${tri}${Math.abs(dd / cm * 100).toFixed(1)}%` : 'new';
    return el('td', { class: 'num' },
      el('span', { style: `color:${col}` }, fmtMoney(dd, { sign: true })),
      el('span', { style: `color:${col};font-size:11px;margin-left:4px` }, pctText));
  };

  // Trailing money cells for a row, per the active mode. `bold` for totals.
  const valueCells = (cur, cmp, trend, good, bold, colorVal) => {
    const tds = [];
    const m = (v) => bold ? el('b', colorVal ? { style: `color:${v >= 0 ? 'var(--green)' : 'var(--red)'}` } : {}, fmtMoney(v))
      : (colorVal ? el('span', { style: `color:${v >= 0 ? 'var(--green)' : 'var(--red)'}` }, fmtMoney(v)) : fmtMoney(v));
    if (modeTrend) { (trend || []).forEach(v => tds.push(el('td', { class: 'num' }, m(v)))); return tds; }
    tds.push(el('td', { class: 'num' }, m(cur)));
    if (pctOn) tds.push(el('td', { class: 'num', style: 'color:var(--mut)' }, pctStr(cur)));
    if (mode2) { tds.push(el('td', { class: 'num', style: 'color:var(--mut)' }, fmtMoney(cmp))); tds.push(changeCell(cur, cmp, good)); }
    return tds;
  };

  const plRows = [];
  // Column header — only when a comparison adds columns to label (single view keeps the
  // headerless two-column look it has today).
  if (modeTrend) plRows.push(el('tr', {}, el('th', {}, 'Account'), ...buckets.map(b => el('th', { class: 'num' }, b.label))));
  else if (mode2) {
    const h = [el('th', {}, 'Account'), el('th', { class: 'num' }, compactRangeLabel(range))];
    if (pctOn) h.push(el('th', { class: 'num' }, '% inc'));
    h.push(el('th', { class: 'num' }, compactRangeLabel(cmpRange)), el('th', { class: 'num' }, 'Change'));
    plRows.push(el('tr', {}, ...h));
  } else if (pctOn) plRows.push(el('tr', {}, el('th', {}, 'Account'), el('th', { class: 'num' }, 'Amount'), el('th', { class: 'num' }, '% inc')));

  // A clickable leaf row → opens the account's transactions for the current range.
  // (Trend leaves aren't clickable — there's no single period to drill into.)
  const leafRow = (account, cur, cmp, trend, label, good, padLeft) => {
    const clickable = !modeTrend;
    const name = el('td', { style: `padding-left:${padLeft}px` }, label,
      clickable ? el('span', { class: 'linklike', style: 'margin-left:6px;font-size:11px' }, '›') : null);
    const attrs = clickable ? { style: 'cursor:pointer', title: 'View transactions', onclick: () => openAccountTxns(account, label) } : {};
    return el('tr', attrs, name, ...valueCells(cur, cmp, trend, good, false, false));
  };
  const totalRow = (label, cur, cmp, trend, good, rowStyle, colorVal) =>
    el('tr', rowStyle ? { style: rowStyle } : {}, el('td', {}, el('b', {}, label)), ...valueCells(cur, cmp, trend, good, true, colorVal));

  const section = (title, g, totalLabel, good) => {
    if (!g.nodes.length) return;
    plRows.push(el('tr', {}, el('td', { class: 'coatype', colspan: String(colspan), style: 'padding-top:12px' }, title)));
    for (const node of g.nodes) {
      if (node.children.length) {
        const open = plExpanded.has(node.account.id);
        const name = el('td', { style: 'padding-left:4px' },
          el('span', { class: 'ms', style: 'font-size:18px;vertical-align:-4px;color:var(--mut)' }, open ? 'expand_more' : 'chevron_right'),
          ' ', el('b', {}, node.account.name));
        plRows.push(el('tr', { style: 'cursor:pointer', title: open ? 'Collapse' : 'Show sub-accounts',
          onclick: () => { open ? plExpanded.delete(node.account.id) : plExpanded.add(node.account.id); drawBody(body); } },
          name, ...valueCells(node.total, node.totalCmp, node.totalTrend, good, true, false)));
        if (open) {
          if (nz(node.own, node.ownCmp, ...(node.ownTrend || []))) plRows.push(leafRow(node.account, node.own, node.ownCmp, node.ownTrend, node.account.name + ' (direct)', good, 36));
          for (const k of node.children) plRows.push(leafRow(k.account, k.amount, k.amountCmp, k.trend, k.account.name, good, 36));
        }
      } else {
        plRows.push(leafRow(node.account, node.total, node.totalCmp, node.totalTrend, node.account.name, good, 24));
      }
    }
    plRows.push(totalRow(totalLabel, g.total, g.totalCmp, g.totalTrend, good, '', false));
  };

  section('Income', income, 'Total income', 'up');
  if (cogs.nodes.length) {
    section('Cost of goods', cogs, 'Total cost of goods', 'down');
    plRows.push(totalRow('Gross profit', gross, grossCmp, grossTrend, 'up', 'background:var(--brand-soft)', false));
  }
  section('Expenses', expenses, 'Total expenses', 'down');
  if (otherExp.nodes.length) {
    plRows.push(totalRow('Net ordinary income', netOrdinary, netOrdinaryCmp, netOrdinaryTrend, 'up', 'background:var(--brand-soft)', true));
    section('Other expenses', otherExp, 'Total other expenses', 'down');
    plRows.push(totalRow('Net income', net, netCmp, netTrend, 'up', net >= 0 ? 'background:var(--green-soft)' : 'background:var(--red-soft)', true));
  } else {
    plRows.push(totalRow('Net profit', net, netCmp, netTrend, 'up', net >= 0 ? 'background:var(--green-soft)' : 'background:var(--red-soft)', true));
  }
  const hasActivity = income.nodes.length || cogs.nodes.length || expenses.nodes.length || otherExp.nodes.length;

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
  const rateIn = el('input', { class: 'field-input', style: 'max-width:90px;margin:0', inputmode: 'decimal', 'data-nocents': '1', value: String(rate), disabled: !taxEditable,
    onchange: (e) => {
      const v = parseFloat(e.target.value);
      if (!(v >= 0 && v <= 99)) { drawBody(body); return; }
      localStorage.setItem(rateKey, String(v));
      dispatch({ op: 'entity.upsert', kind: 'taxsetting', value: { id: 'tax', rate: v, updatedAt: Date.now() } });
      drawBody(body);
    } });

  // ── P&L comparison controls (one line: period · compare-to · % of income) ──
  const compareSel = el('select', { class: 'cmp-select', onchange: (e) => { s.compare = e.target.value; drawBody(body); } },
    el('option', { value: 'none' }, 'No comparison'),
    el('option', { value: 'prev' }, 'Previous period'),
    el('option', { value: 'ly' }, 'Same period last year'),
    el('option', { value: 'trend' }, 'Monthly trend'));
  compareSel.value = s.compare;
  const pctChk = el('input', { type: 'checkbox', id: 'pl-pct', checked: s.pctOfIncome, disabled: modeTrend,
    onchange: (e) => { s.pctOfIncome = e.target.checked; drawBody(body); } });
  const pctToggle = el('label', { class: 'pct-toggle' + (modeTrend ? ' off' : ''), for: 'pl-pct', title: modeTrend ? 'Not shown in trend view' : '' }, pctChk, ' % of income');

  const presetLabel = rangeLabel(range);
  const plCardStyle = (cmpMode === 'none') ? 'flex:1;min-width:330px;max-width:460px' : 'flex:1 1 100%;min-width:330px';
  const csvCmp = {
    mode: mode2 ? cmpMode : (modeTrend ? 'trend' : 'none'),
    pctOn, incomeTotal: incTot,
    curLabel: compactRangeLabel(range), cmpLabel: cmpRange ? compactRangeLabel(cmpRange) : '',
    bucketLabels: buckets.map(b => b.label),
  };
  const plData = { income, cogs, expenses, otherExp, net, netCmp, netTrend, gross, grossCmp, grossTrend };

  clear(body).append(
    el('div', { class: 'row', style: 'align-items:flex-start' },
      el('div', { class: 'card', style: plCardStyle },
        // Sticky header: title + Print/Export + the period/compare controls stay pinned
        // while the (often long) P&L table scrolls beneath them.
        el('div', { class: 'pl-stickyhead' },
          el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:8px' },
            el('div', { class: 'cardtitle', style: 'margin:0' }, 'Profit & Loss'),
            el('span', { style: 'flex:1' }),
            // The client app is view-only — no export/print of the books.
            document.body.classList.contains('bo-client') ? null : el('button', { class: 'btn sm ghost no-print', onclick: () => window.print() }, 'Print / PDF'),
            document.body.classList.contains('bo-client') ? null : el('button', { class: 'btn sm ghost no-print', onclick: () => downloadCsv(
              `${getActiveBiz()}-reports.csv`,
              buildReportsCsv(presetLabel, s.asOf, plData, { assets, liabilities, equity, netToDate }, csvCmp)) }, 'Export CSV')),
          el('div', { class: 'sub print-only', style: 'margin:0 0 6px' },
            presetLabel + (mode2 ? ` vs ${compactRangeLabel(cmpRange)}` : modeTrend ? ' · monthly trend' : '')),
          el('div', { class: 'pl-controls no-print' }, s.rangeCtl.el,
            el('span', { class: 'field-label', style: 'margin:0;white-space:nowrap' }, 'Compare to'),
            compareSel, pctToggle)),
        hasActivity ? (modeTrend ? el('div', { style: 'overflow-x:auto' }, el('table', { class: 'data cmp' }, ...plRows)) : el('table', { class: 'data' + ((mode2 || pctOn) ? ' cmp' : '') }, ...plRows)) : el('p', { class: 'sub' }, 'No activity in this range.')),
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
