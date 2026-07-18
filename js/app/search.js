// ── Global search — header search across txns / invoices / vendors / accounts ──
// In-memory scan of the active business's store, grouped results, jumps to the item.
// Transactions have no detail route, so they deep-link the Ledger's text filter.
import { entities } from './store.js';
import { todayLocal } from './lib/day.js';
import { getActiveBiz } from './session.js';
import { setLedgerQuery } from './views/ledger.js';
import { setReviewQuery } from './views/review.js';
import { openView } from './windows.js';
import { prettyDesc } from './ui.js';

let _input, _panel, _wrap;
const money = (c) => (c < 0 ? '−$' : '$') + (Math.abs(c || 0) / 100).toFixed(2);

const bankish = (a) => a && (a.qbType === 'BANK' || a.qbType === 'CCARD');
// What kind of transaction is this? Transfers (both sides are your own bank/card
// accounts) first, then payment-rail keywords from the description, then the plain
// money-in / money-out direction. Shown so a search hit reads at a glance.
function txnType(t, acctById) {
  const d = `${t.payee || ''} ${t.memo || ''}`.toLowerCase();
  const lines = t.lines || [];
  if (lines.length === 2 && lines.every(l => bankish(acctById.get(l.accountId)))) return 'Transfer';
  if (/zelle/.test(d)) return 'Zelle';
  if (/\bach\b/.test(d)) return 'ACH';
  if (/\b(wire|xfer|transfer)\b/.test(d)) return 'Transfer';
  if (t.checkNo || /\b(check|chk|cheque)\b/.test(d)) return 'Check';
  if (/\batm\b/.test(d)) return 'ATM';
  if (/\b(card|pos|debit|purchase)\b/.test(d)) return 'Card';
  const bankLine = lines.find(l => bankish(acctById.get(l.accountId)));
  const net = bankLine ? bankLine.amountCents : lines.reduce((s, l) => s + l.amountCents, 0);
  return net >= 0 ? 'Deposit' : 'Expense';
}

// Match a typed amount ("190.64", "$1,988.10", "190") against any of a row's line
// amounts — so searching a dollar figure finds the transaction even when the amount
// isn't in its description. Only fires when the query actually contains a digit.
function amountMatch(centsList, ql) {
  const qd = ql.replace(/[^0-9.]/g, '');
  if (!qd || !/[0-9]/.test(qd)) return false;
  return centsList.some(c => (Math.abs(c || 0) / 100).toFixed(2).includes(qd));
}

function searchAll(ql) {
  return {
    txns: entities('txn').filter(t => t.status !== 'void' && (
      `${t.payee || ''} ${t.memo || ''} ${t.checkNo || ''}`.toLowerCase().includes(ql) ||
      amountMatch((t.lines || []).map(l => l.amountCents), ql))).slice(0, 24),
    // Review (not-yet-posted) rows — pending + skipped, matched by description or amount.
    staged: entities('staged').filter(s => (s.status === 'pending' || s.status === 'skipped') && (
      `${s.desc || ''} ${s.memo || ''}`.toLowerCase().includes(ql) ||
      amountMatch([s.amountCents], ql))).slice(0, 12),
    invoices: entities('invoice').filter(i => `${i.number || ''} ${i.clientName || ''}`.toLowerCase().includes(ql)).slice(0, 8),
    vendors: entities('vendor').filter(v => (v.name || '').toLowerCase().includes(ql)).slice(0, 8),
    accounts: entities('account').filter(a => a.active !== false && (a.name || '').toLowerCase().includes(ql)).slice(0, 8),
  };
}

// ── Result filters (narrow the transaction results) — by account, category, or date ──
let filt = { acct: '', cat: '', date: '' };   // bank-account id · category-account id · date preset
function dateFrom(preset) {
  const d = new Date();
  if (preset === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  if (preset === 'year') return `${d.getFullYear()}-01-01`;
  if (preset === '90') return todayLocal(new Date(d.getTime() - 90 * 864e5));
  return '';
}
function txnPasses(t) {
  const from = dateFrom(filt.date);
  if (from && (t.date || '') < from) return false;
  if (filt.acct && !(t.lines || []).some(l => l.accountId === filt.acct)) return false;   // touches this account
  if (filt.cat && !(t.lines || []).some(l => l.accountId === filt.cat)) return false;     // touches this category
  return true;
}
// Transactions are grouped by their exact type; this is the display order + plural labels.
const TYPE_ORDER = ['Transfer', 'Deposit', 'Expense', 'Card', 'Check', 'ACH', 'Zelle', 'ATM'];
const TYPE_LABEL = { Transfer: 'Transfers', Deposit: 'Deposits', Expense: 'Expenses', Card: 'Card payments', Check: 'Checks', ACH: 'ACH', Zelle: 'Zelle', ATM: 'ATM' };

// Open (or focus) the view's window directly — robust even when the hash is already
// the target (which would not fire a hashchange) — then sync the URL. force=true
// re-renders so a freshly-applied filter (e.g. a clicked transaction) always shows.
function goView(name, detail) {
  const biz = getActiveBiz();
  _panel.hidden = true; _input.value = '';
  openView(name, detail, true);
  if (biz) location.hash = `#/b/${biz}/${name}${detail ? '/' + detail : ''}`;
}

// A small filter bar pinned to the top of the results — narrows the transaction groups
// by account / category / date. Rebuilt each render; `filt` persists the selection.
function filterBar() {
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:8px 11px;border-bottom:1px solid var(--line);position:sticky;top:0;background:#fff;z-index:2';
  bar.appendChild(Object.assign(document.createElement('span'), { textContent: 'Filter' , style: 'font-size:11px;color:var(--mut);font-weight:700' }));
  const mkSel = (key, placeholder, options) => {
    const s = document.createElement('select');
    s.style.cssText = 'font-size:11px;padding:3px 6px;border:1px solid #d2d6e0;border-radius:6px;max-width:150px;background:#fff';
    s.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: placeholder }));
    for (const [v, l] of options) { const o = document.createElement('option'); o.value = v; o.textContent = l; if (filt[key] === v) o.selected = true; s.appendChild(o); }
    s.onchange = () => { filt[key] = s.value; render(_input.value.trim()); };
    return s;
  };
  const byName = (a, b) => a.name.localeCompare(b.name);
  const banks = entities('account').filter(a => a.active !== false && bankish(a)).sort(byName);
  const cats = entities('account').filter(a => a.active !== false && !bankish(a)).sort(byName);
  bar.appendChild(mkSel('acct', 'Any account', banks.map(a => [a.id, a.name])));
  bar.appendChild(mkSel('cat', 'Any category', cats.map(a => [a.id, a.name])));
  bar.appendChild(mkSel('date', 'Any date', [['month', 'This month'], ['year', 'This year'], ['90', 'Last 90 days']]));
  if (filt.acct || filt.cat || filt.date) {
    const clr = document.createElement('button');
    clr.textContent = 'Clear'; clr.style.cssText = 'font-size:11px;padding:3px 9px;border:1px solid #d2d6e0;border-radius:6px;background:#fff;cursor:pointer;color:var(--mut)';
    clr.onclick = () => { filt = { acct: '', cat: '', date: '' }; render(_input.value.trim()); };
    bar.appendChild(clr);
  }
  return bar;
}

function render(q) {
  const biz = getActiveBiz();
  if (!q || q.length < 2 || !biz) { _panel.hidden = true; return; }
  const r = searchAll(q.toLowerCase());
  const acctById = new Map(entities('account').map(a => [a.id, a]));
  // The transaction's signed amount = its bank-line amount (− for money out, + for in).
  const amtOf = (t) => { const bl = (t.lines || []).find(l => bankish(acctById.get(l.accountId))); return bl ? bl.amountCents : (t.lines || []).reduce((s, l) => l.amountCents > 0 ? s + l.amountCents : s, 0); };
  _panel.innerHTML = '';
  _panel.appendChild(filterBar());

  const subhead = (text) => Object.assign(document.createElement('div'), { textContent: text,
    style: 'font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);padding:9px 11px 2px;font-weight:700' });
  // One transaction = three aligned columns: date · payee · amount.
  const colRow = (date, payee, amt, onPick) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;padding:6px 11px;cursor:pointer;font-size:12.5px;align-items:baseline';
    row.onmouseenter = () => { row.style.background = '#eef0f4'; };
    row.onmouseleave = () => { row.style.background = ''; };
    row.onclick = onPick;
    row.appendChild(Object.assign(document.createElement('span'), { textContent: date, style: 'color:var(--mut);white-space:nowrap;font-variant-numeric:tabular-nums' }));
    row.appendChild(Object.assign(document.createElement('span'), { textContent: payee, style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }));
    row.appendChild(Object.assign(document.createElement('span'), { textContent: amt, style: 'text-align:right;font-weight:700;white-space:nowrap;font-variant-numeric:tabular-nums' }));
    return row;
  };

  // Transactions — grouped by exact type, each a columnar list.
  const passTxns = r.txns.filter(txnPasses);
  const byType = new Map();
  for (const t of passTxns) { const ty = txnType(t, acctById); (byType.get(ty) || byType.set(ty, []).get(ty)).push(t); }
  for (const ty of TYPE_ORDER) {
    const items = byType.get(ty);
    if (!items || !items.length) continue;
    _panel.appendChild(subhead(`${TYPE_LABEL[ty] || ty} · ${items.length}`));
    for (const t of items) _panel.appendChild(colRow(t.date, prettyDesc(t.payee) || '—', money(amtOf(t)), () => { setLedgerQuery(t.payee || t.memo || t.checkNo || ''); goView('ledger'); }));
  }

  // In Review (raw bank rows) — date + account filter only (no category on a raw row yet).
  const bankAcctOf = new Map(entities('bankacct').map(b => [b.id, b.accountId]));
  const passStaged = r.staged.filter(s => {
    const from = dateFrom(filt.date); if (from && (s.date || '') < from) return false;
    if (filt.acct && bankAcctOf.get(s.bankacctId) !== filt.acct) return false;
    if (filt.cat) return false;
    return true;
  });
  if (passStaged.length) {
    _panel.appendChild(subhead(`In review · ${passStaged.length}`));
    for (const s of passStaged) _panel.appendChild(colRow(s.date, prettyDesc(s.desc) || '—', money(s.amountCents), () => { setReviewQuery(q); goView('review'); }));
  }

  // Non-transaction matches (text only) — plain one-line rows.
  const simpleGroup = (title, items, label, onPick) => {
    if (!items.length) return;
    _panel.appendChild(subhead(title));
    for (const it of items) {
      const row = document.createElement('div');
      row.textContent = label(it);
      row.style.cssText = 'padding:6px 11px;cursor:pointer;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      row.onmouseenter = () => { row.style.background = '#eef0f4'; };
      row.onmouseleave = () => { row.style.background = ''; };
      row.onclick = () => onPick(it);
      _panel.appendChild(row);
    }
  };
  simpleGroup('Invoices', r.invoices, i => `#${i.number || i.id} · ${i.clientName || ''}`, i => goView('invoices', i.id));
  simpleGroup('Vendors', r.vendors, v => v.name, v => goView('vendors', v.id));
  simpleGroup('Accounts', r.accounts, a => a.name, a => goView('accounts', a.id));

  if (!(passTxns.length || passStaged.length || r.invoices.length || r.vendors.length || r.accounts.length)) {
    _panel.appendChild(Object.assign(document.createElement('div'), { textContent: (filt.acct || filt.cat || filt.date) ? 'No matches for these filters' : 'No matches',
      style: 'padding:9px 11px;color:var(--mut);font-size:13px' }));
  }
  _panel.hidden = false;
}

export function mountGlobalSearch() {
  _wrap = document.getElementById('gsearch');
  _input = document.getElementById('gsearch-input');
  _panel = document.getElementById('gsearch-results');
  if (!_input || !_panel) return;
  _panel.style.cssText = 'position:absolute;top:100%;left:0;right:auto;min-width:480px;max-width:min(640px,92vw);background:#fff;border:1px solid #dcdcdc;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);max-height:60vh;overflow:auto;z-index:50;margin-top:4px';
  _panel.hidden = true;
  let t;
  _input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => render(_input.value.trim()), 140); });
  _input.addEventListener('focus', () => { if (_input.value.trim().length >= 2) render(_input.value.trim()); });
  _input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { _panel.hidden = true; _input.blur(); } });
  document.addEventListener('click', (e) => { if (_wrap && !_wrap.contains(e.target)) _panel.hidden = true; });
  document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); _input.focus(); _input.select(); } });
}
