// ── suggest — native <datalist> autocomplete for Payee / Memo fields ───────────
// Two shared datalists (payees, memos) filled from the distinct values already on
// the business's transactions and kept fresh on every store change. Any <input>
// opts in via bindSuggest(input, 'payee'|'memo') — the browser shows the dropdown.
import { el } from './ui.js';
import { entities, subscribe } from './store.js';

let payeeDL = null, memoDL = null, started = false;

function distinct(field) {
  const seen = new Set(), out = [];
  for (const t of entities('txn')) {
    const v = (t[field] || '').trim();
    const k = v.toLowerCase();
    if (v && !seen.has(k)) { seen.add(k); out.push(v); }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out.slice(0, 500);   // datalists stay snappy; the rest is reachable by typing
}

function ensure() {
  if (started) return;
  started = true;
  payeeDL = el('datalist', { id: 'sugg-payee' });
  memoDL = el('datalist', { id: 'sugg-memo' });
  document.body.append(payeeDL, memoDL);
  const fill = () => {
    payeeDL.replaceChildren(...distinct('payee').map(v => el('option', { value: v })));
    memoDL.replaceChildren(...distinct('memo').map(v => el('option', { value: v })));
  };
  fill();
  subscribe(fill);
}

export function bindSuggest(input, kind) {
  ensure();
  input.setAttribute('list', kind === 'payee' ? 'sugg-payee' : 'sugg-memo');
  input.setAttribute('autocomplete', 'off');
  return input;
}
