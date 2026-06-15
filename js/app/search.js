// ── Global search — header search across txns / invoices / vendors / accounts ──
// In-memory scan of the active business's store, grouped results, jumps to the item.
// Transactions have no detail route, so they deep-link the Ledger's text filter.
import { entities } from './store.js';
import { getActiveBiz } from './session.js';
import { setLedgerQuery } from './views/ledger.js';

let _input, _panel, _wrap;
const money = (c) => (c < 0 ? '−$' : '$') + (Math.abs(c || 0) / 100).toFixed(2);

function searchAll(ql) {
  const cap = 8;
  return {
    txns: entities('txn').filter(t => t.status !== 'void' && `${t.payee || ''} ${t.memo || ''} ${t.checkNo || ''}`.toLowerCase().includes(ql)).slice(0, cap),
    invoices: entities('invoice').filter(i => `${i.number || ''} ${i.clientName || ''}`.toLowerCase().includes(ql)).slice(0, cap),
    vendors: entities('vendor').filter(v => (v.name || '').toLowerCase().includes(ql)).slice(0, cap),
    accounts: entities('account').filter(a => a.active !== false && (a.name || '').toLowerCase().includes(ql)).slice(0, cap),
  };
}

function go(hash) { _panel.hidden = true; _input.value = ''; location.hash = hash; }

function render(q) {
  const biz = getActiveBiz();
  if (!q || q.length < 2 || !biz) { _panel.hidden = true; return; }
  const r = searchAll(q.toLowerCase());
  _panel.innerHTML = '';
  const addGroup = (title, items, label, onPick) => {
    if (!items.length) return;
    const h = document.createElement('div');
    h.textContent = title;
    h.style.cssText = 'font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);padding:7px 11px 2px';
    _panel.appendChild(h);
    for (const it of items) {
      const row = document.createElement('div');
      row.textContent = label(it);
      row.style.cssText = 'padding:7px 11px;cursor:pointer;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      row.onmouseenter = () => { row.style.background = '#eef0f4'; };
      row.onmouseleave = () => { row.style.background = ''; };
      row.onclick = () => onPick(it);
      _panel.appendChild(row);
    }
  };
  addGroup('Transactions', r.txns, t => `${t.date} · ${t.payee || '—'} · ${money(t.lines?.reduce((s, l) => l.amountCents > 0 ? s + l.amountCents : s, 0) || 0)}`,
    t => { setLedgerQuery(t.payee || t.memo || ''); go(`#/b/${biz}/ledger`); });
  addGroup('Invoices', r.invoices, i => `#${i.number || i.id} · ${i.clientName || ''}`, i => go(`#/b/${biz}/invoices/${i.id}`));
  addGroup('Vendors', r.vendors, v => v.name, v => go(`#/b/${biz}/vendors/${v.id}`));
  addGroup('Accounts', r.accounts, a => a.name, a => go(`#/b/${biz}/accounts/${a.id}`));
  if (!(r.txns.length || r.invoices.length || r.vendors.length || r.accounts.length)) {
    const d = document.createElement('div');
    d.textContent = 'No matches';
    d.style.cssText = 'padding:9px 11px;color:var(--mut);font-size:13px';
    _panel.appendChild(d);
  }
  _panel.hidden = false;
}

export function mountGlobalSearch() {
  _wrap = document.getElementById('gsearch');
  _input = document.getElementById('gsearch-input');
  _panel = document.getElementById('gsearch-results');
  if (!_input || !_panel) return;
  _panel.style.cssText = 'position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #dcdcdc;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);max-height:60vh;overflow:auto;z-index:50;margin-top:4px';
  _panel.hidden = true;
  let t;
  _input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => render(_input.value.trim()), 140); });
  _input.addEventListener('focus', () => { if (_input.value.trim().length >= 2) render(_input.value.trim()); });
  _input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { _panel.hidden = true; _input.blur(); } });
  document.addEventListener('click', (e) => { if (_wrap && !_wrap.contains(e.target)) _panel.hidden = true; });
  document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); _input.focus(); _input.select(); } });
}
