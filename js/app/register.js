// ── Shared transaction register — QuickBooks-style drill-down ──────────────────
// A full-page register of POSTED transactions, used by the Accounts view (per
// account → running balance) and the Vendors view (per vendor → total spent). The
// host view passes the already-filtered transactions; this renders the date-range
// filter, the table, a total, and Print / CSV export. Reuses the @media print rules.

import { el, clear, fmtMoney } from './ui.js';
import { entities, subscribe, usesInvoices } from './store.js';
import { canEdit, getActiveBiz } from './session.js';
import { categoryField, vendorField, memoField, invoiceField, categoryName, stackedEditor } from './txn-inline.js';
import { dateRangeControl } from './daterange.js';
import { editTxnModal } from './views/ledger.js';

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
  const state = { from: '', to: '', sortKey: 'date', sortDir: 'asc' };
  const body = el('div');
  opts.root.append(body);
  // Built once so the date picker keeps its state across the redraws store changes trigger.
  state.rangeCtl = dateRangeControl({ initial: 'all', onChange: (r) => { state.from = r.from || ''; state.to = r.to || ''; drawRegister(body, opts, state); } });
  const draw = () => drawRegister(body, opts, state);
  const unsub = subscribe(draw);
  draw();
  return unsub;
}

function drawRegister(body, opts, state) {
  const { title, subtitle, backHash, backLabel, getTxns, focusAccountId, filename } = opts;
  const isAcct = !!focusAccountId;
  const byId = new Map(entities('account').map(a => [a.id, a]));
  const filtered = (getTxns() || []).filter(t => inRange(t.date, state.from, state.to));
  const amtOf = (t) => isAcct ? lineOn(t, focusAccountId) : magnitude(t);

  // Running balance is computed CHRONOLOGICALLY so it stays correct no matter how
  // the table is sorted for display.
  let run = 0; const balAfter = new Map();
  for (const t of [...filtered].sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : 1))) {
    if (isAcct) run += amtOf(t);
    balAfter.set(t.id, run);
  }

  const dir = state.sortDir === 'desc' ? -1 : 1;
  const cmp = ({
    date: (a, b) => a.date.localeCompare(b.date),
    payee: (a, b) => (a.payee || '').localeCompare(b.payee || ''),
    amount: (a, b) => amtOf(a) - amtOf(b),
  })[state.sortKey] || ((a, b) => a.date.localeCompare(b.date));
  const rows = [...filtered].sort((a, b) => dir * cmp(a, b) || (a.id < b.id ? -1 : 1));

  const editable = canEdit(getActiveBiz());
  const showInv = usesInvoices();
  const invById = new Map(entities('invoice').map(i => [i.id, i]));
  // Editable mode adds inline Category/Vendor/Memo(/Invoice) columns before Amount.
  const extraCols = editable ? (showInv ? 4 : 3) : 0;
  const colCount = 2 + extraCols + 1 + (isAcct ? 1 : 0); // date,payee,…,amount,(balance)

  let total = 0;
  const trs = rows.flatMap(t => {
    const amt = amtOf(t);
    total += amt;
    if (!editable) {
      return [el('tr', {},
        el('td', {}, t.date),
        el('td', {}, t.payee || '—'),
        el('td', {}, otherSide(t, focusAccountId || '', byId)),
        el('td', {}, t.memo || ''),
        el('td', { class: 'num ' + (amt < 0 ? 'neg' : amt > 0 ? 'pos' : '') }, fmtMoney(amt, { sign: isAcct })),
        isAcct ? el('td', { class: 'num' }, fmtMoney(balAfter.get(t.id) || 0)) : null)];
    }
    const detail = el('tr', { class: 'txrow-detail' },
      el('td', { colspan: String(colCount), style: 'background:var(--bg);padding:12px 14px' }, stackedEditor(t)));
    const inv = t.invoiceId ? invById.get(t.invoiceId) : null;
    const chevron = el('i', { class: 'ti ti-chevron-down txchev' });
    const compact = el('div', { class: 'txcompact', onclick: () => { detail.classList.toggle('open'); chevron.className = detail.classList.contains('open') ? 'ti ti-chevron-up txchev' : 'ti ti-chevron-down txchev'; } },
      el('span', { style: 'color:var(--mut)' }, categoryName(t) || otherSide(t, focusAccountId || '', byId)),
      (showInv && inv) ? el('span', { class: 'pill blue', style: 'font-size:10px;padding:2px 7px' }, `#${inv.number || inv.id}`) : '',
      chevron);
    const summary = el('tr', {},
      el('td', { style: 'white-space:nowrap' }, t.date),
      el('td', {}, el('b', {}, t.payee || '—'),
        el('button', { class: 'btn sm ghost', style: 'margin-left:8px;padding:2px 9px;font-size:11px', title: 'Open the full transaction editor (amount, date, splits, delete)', onclick: () => editTxnModal(t) }, 'Edit'),
        compact),
      el('td', { class: 'txinline' }, categoryField(t)),
      el('td', { class: 'txinline' }, vendorField(t)),
      el('td', { class: 'txinline' }, memoField(t)),
      showInv ? el('td', { class: 'txinline' }, invoiceField(t)) : null,
      el('td', { class: 'num ' + (amt < 0 ? 'neg' : amt > 0 ? 'pos' : ''), style: 'white-space:nowrap' }, fmtMoney(amt, { sign: isAcct })),
      isAcct ? el('td', { class: 'num' }, fmtMoney(balAfter.get(t.id) || 0)) : null);
    return [summary, detail];
  });

  const arrow = (key) => state.sortKey === key ? (state.sortDir === 'desc' ? ' ▼' : ' ▲') : '';
  const th = (key, label, cls) => el('th', { class: cls || '', style: 'cursor:pointer;user-select:none', title: 'Click to sort',
    onclick: () => { if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc'; else { state.sortKey = key; state.sortDir = key === 'amount' ? 'desc' : 'asc'; } drawRegister(body, opts, state); } },
    label + arrow(key));

  clear(body).append(
    // Breadcrumb trail (kept alongside the ← Back button) — shows where you are and
    // lets you click the parent to step back. Skipped in modal mode (it has its own head).
    opts.modal ? null : el('div', { class: 'crumb no-print' },
      el('a', { class: 'crumb-link', href: '#' + backHash }, backLabel || 'Back'),
      el('span', { class: 'crumb-sep' }, '›'),
      el('span', { class: 'crumb-cur' }, title)),
    el('div', { class: 'no-print', style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px' },
      // In a modal the X closes it — the back link only matters on the full-page route.
      opts.modal ? el('span') : el('a', { class: 'btn sm ghost', href: '#' + backHash }, '← ' + (backLabel || 'Back')),
      el('span', { style: 'flex:1' }),
      el('span', { class: 'field-label', style: 'margin:0' }, 'Period'), state.rangeCtl.el,
      el('button', { class: 'btn sm ghost', onclick: () => window.print() }, 'Print / PDF'),
      el('button', { class: 'btn sm ghost', onclick: () => downloadCsv(filename, buildCsv(title, subtitle, rows, focusAccountId, byId)) }, 'Export CSV')),
    opts.modal ? null : el('h2', {}, title),   // the modal head already shows the title
    subtitle ? el('p', { class: 'sub' }, subtitle) : null,
    el('div', { class: 'card', style: 'padding:0;overflow-x:auto' },
      rows.length
        ? el('table', { class: 'data' + (editable ? ' txedit' : '') },
            el('tr', {},
              th('date', 'Date'), th('payee', 'Payee'),
              editable
                ? [el('th', { class: 'txinline' }, 'Account'),
                   el('th', { class: 'txinline' }, 'Vendor'),
                   el('th', { class: 'txinline' }, 'Memo'),
                   showInv ? el('th', { class: 'txinline' }, 'Invoice') : null]
                : [el('th', {}, 'Account'), el('th', {}, 'Memo')],
              th('amount', isAcct ? 'Amount' : 'Spent', 'num'),
              isAcct ? el('th', { class: 'num' }, 'Balance') : null),
            ...trs,
            el('tr', { style: 'background:var(--brand-soft)' },
              el('td', { colspan: String(editable ? 2 + extraCols : 4) }, el('b', {}, `Total — ${rows.length} transaction${rows.length === 1 ? '' : 's'}`)),
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
    line('Date', 'Payee', 'Account', 'Memo', 'Amount', 'Balance');
    let running = 0, total = 0;
    for (const t of rows) { const a = lineOn(t, focusAccountId); running += a; total += a; line(t.date, t.payee || '', otherSide(t, focusAccountId, byId), t.memo || '', d(a), d(running)); }
    line('', '', '', 'Total', d(total), '');
  } else {
    line('Date', 'Payee', 'Account', 'Memo', 'Spent');
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
