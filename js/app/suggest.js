// ── suggest — native <datalist> autocomplete for the Payee field ──────────────
// One shared datalist (payees) filled from the distinct payee values already on the
// business's transactions and kept fresh on every store change. A Payee <input> opts
// in via bindSuggest(input, 'payee') — the browser shows the dropdown.
// Notes/memos are deliberately free-text with NO dropdown (kind === 'memo' is a no-op).
import { el } from './ui.js';
import { entities, subscribe } from './store.js';

let payeeDL = null, started = false;

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
  document.body.append(payeeDL);
  const fill = () => payeeDL.replaceChildren(...distinct('payee').map(v => el('option', { value: v })));
  fill();
  subscribe(fill);
}

export function bindSuggest(input, kind) {
  // Notes/memos get no autocomplete dropdown — only the Payee field offers suggestions.
  if (kind === 'memo') { input.setAttribute('autocomplete', 'off'); return input; }
  ensure();
  input.setAttribute('list', 'sugg-payee');
  input.setAttribute('autocomplete', 'off');
  return input;
}
