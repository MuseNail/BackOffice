// ── Shared transaction register — QuickBooks-style drill-down ──────────────────
// A full-page register of POSTED transactions, used by the Accounts view (per
// account → running balance) and the Vendors view (per vendor → total spent). The
// host view passes the already-filtered transactions; this renders the date-range
// filter, the table, a total, and Print / CSV export. Reuses the @media print rules.

import { el, clear, fmtMoney } from './ui.js';
import { entities, subscribe } from './store.js';

const lineOn = (txn, acctId) => (txn.lines || []).filter(l => l.accountId === acctId).reduce((s, l) => s + l.amountCents, 0);
const magnitude = (txn) => (txn.lines || []).reduce((s, l) => s + Math.max(0, l.amountCents), 0);
// The other side(s) of the entry relative to acctId — the category / account names.
const otherSide = (txn, acctId, byId) => ((txn.lines || [])
  .filter(l => l.accountId !== acctId)
  .map(l => byId.get(l.accountId)?.name || '—').join(', ')) || '—';
const inRange = (date, from, to) => (!from || date >= from) && (!to || date <= to);

// opts: { root, title, subtitle, backHash, backLabel, getTxns(), focusAccountId, filename }
// getTxns() is re-evaluated on every store change; the date filter persists. Returns
// an unsubscribe the host should call on unmount.
export function renderRegister(opts) {
  const state = { from: '', to: '' };
  const body = el('div');
  opts.root.append(body);
  const draw = () => drawRegister(body, opts, state);
  const unsub = subscribe(draw);
  draw();
  return unsub;
}

function drawRegister(body, opts, state) {
  const { title, subtitle, backHash, backLabel, getTxns, focusAccountId, filename } = opts;
  const isAcct = !!focusAccountId;
  const byId = new Map(entities('account').map(a => [a.id, a]));
  const rows = (getTxns() || [])
    .filter(t => inRange(t.date, state.from, state.to))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : 1));

  let running = 0, total = 0;
  const trs = rows.map(t => {
    const amt = isAcct ? lineOn(t, focusAccountId) : magnitude(t);
    total += amt;
    if (isAcct) running += amt;
    return el('tr', {},
      el('td', {}, t.date),
      el('td', {}, t.payee || '—'),
      el('td', {}, otherSide(t, focusAccountId || '', byId)),
      el('td', {}, t.memo || ''),
      el('td', { class: 'num ' + (amt < 0 ? 'neg' : amt > 0 ? 'pos' : '') }, fmtMoney(amt, { sign: isAcct })),
      isAcct ? el('td', { class: 'num' }, fmtMoney(running)) : null);
  });

  const dateIn = (key) => el('input', { class: 'field-input', type: 'date', value: state[key], style: 'max-width:155px',
    onchange: (e) => { state[key] = e.target.value; drawRegister(body, opts, state); } });

  clear(body).append(
    el('div', { class: 'no-print', style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px' },
      el('a', { class: 'btn sm ghost', href: '#' + backHash }, '← ' + (backLabel || 'Back')),
      el('span', { style: 'flex:1' }),
      el('span', { class: 'field-label', style: 'margin:0' }, 'From'), dateIn('from'),
      el('span', { class: 'field-label', style: 'margin:0' }, 'To'), dateIn('to'),
      el('button', { class: 'btn sm ghost', onclick: () => window.print() }, 'Print / PDF'),
      el('button', { class: 'btn sm ghost', onclick: () => downloadCsv(filename, buildCsv(title, subtitle, rows, focusAccountId, byId)) }, 'Export CSV')),
    el('h2', {}, title),
    subtitle ? el('p', { class: 'sub' }, subtitle) : null,
    el('div', { class: 'card', style: 'padding:0;overflow:hidden' },
      rows.length
        ? el('table', { class: 'data' },
            el('tr', {},
              el('th', {}, 'Date'), el('th', {}, 'Payee'),
              el('th', {}, isAcct ? 'Category / account' : 'Category'), el('th', {}, 'Memo'),
              el('th', { class: 'num' }, isAcct ? 'Amount' : 'Spent'),
              isAcct ? el('th', { class: 'num' }, 'Balance') : null),
            ...trs,
            el('tr', { style: 'background:var(--brand-soft)' },
              el('td', { colspan: '4' }, el('b', {}, `Total — ${rows.length} transaction${rows.length === 1 ? '' : 's'}`)),
              el('td', { class: 'num' }, el('b', {}, fmtMoney(total, { sign: isAcct }))),
              isAcct ? el('td', {}) : null))
        : el('p', { class: 'sub', style: 'padding:14px' }, 'No transactions in this range.')),
  );
}

function buildCsv(title, subtitle, rows, focusAccountId, byId) {
  const esc = (v) => { const t = String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const d = (c) => (c / 100).toFixed(2);
  const isAcct = !!focusAccountId;
  const out = [];
  const line = (...c) => out.push(c.map(esc).join(','));
  line(title); if (subtitle) line(subtitle);
  if (isAcct) {
    line('Date', 'Payee', 'Category/account', 'Memo', 'Amount', 'Balance');
    let running = 0, total = 0;
    for (const t of rows) { const a = lineOn(t, focusAccountId); running += a; total += a; line(t.date, t.payee || '', otherSide(t, focusAccountId, byId), t.memo || '', d(a), d(running)); }
    line('', '', '', 'Total', d(total), '');
  } else {
    line('Date', 'Payee', 'Category', 'Memo', 'Spent');
    let total = 0;
    for (const t of rows) { const a = magnitude(t); total += a; line(t.date, t.payee || '', otherSide(t, '', byId), t.memo || '', d(a)); }
    line('', '', '', 'Total', d(total));
  }
  return out.join('\n');
}

function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
