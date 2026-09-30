// ── Inline transaction editing — shared by the Ledger and the register ─────────
// One save path + field factories so editing a transaction's category, vendor,
// memo, and linked invoice behaves identically inline (desktop) and in the
// tap-to-expand editor (phone), matching the Ledger's edit modal exactly.
//
// Option lists (categories / vendors / invoices) are LAZY: each <select> renders
// showing only its current value, then populates the full list on first focus.
// A ledger page can show 200 rows × 3 selects — eager option lists would be
// thousands of <option> nodes; lazy keeps it instant while still "immediately
// visible" (the field shows its value with a chevron, no extra click to see it).

import { el, toast } from './ui.js';
import { entities, usesInvoices } from './store.js';
import { dispatch } from './sync.js';
import { validateTxn } from './lib/posting.js';
import { accountLabel } from './lib/coa-templates.js';
import { accountCombo, vendorCombo, invoiceCombo } from './pickers.js';
import { bindSuggest } from './suggest.js';

const bankish = (a) => a.qbType === 'BANK' || a.qbType === 'CCARD';
const ctx = () => ({ accountsById: new Map(entities('account').map(a => [a.id, a])), locks: new Set(entities('lock').map(l => l.id)) });

// A simple txn (2 lines: one bank/card + one category) is the only shape whose
// category can be edited inline — journal/split entries have no single category.
export function isSimpleTxn(t) {
  if (!t || (t.lines || []).length !== 2) return false;
  const byId = new Map(entities('account').map(a => [a.id, a]));
  const bank = t.lines.find(l => { const a = byId.get(l.accountId); return a && bankish(a); });
  return !!(bank && t.lines.find(l => l !== bank));
}
function categoryLine(t) {
  const byId = new Map(entities('account').map(a => [a.id, a]));
  const bank = t.lines.find(l => { const a = byId.get(l.accountId); return a && bankish(a); });
  return bank ? t.lines.find(l => l !== bank) : null;
}
export function categoryName(t) {
  const line = isSimpleTxn(t) ? categoryLine(t) : null;
  if (!line) return null;
  const byId = new Map(entities('account').map(a => [a.id, a]));
  const a = byId.get(line.accountId);
  return a ? accountLabel(a, byId) : line.accountId;
}

// The single income category line of a SIMPLE deposit, if that's what this is. Income → vendor is
// attributed PER LINE (never via the txn-level fallback), so a simple deposit's vendor must live on
// this line, not on the transaction, or it wouldn't count in the vendor's net.
function incomeCatLine(t) {
  if (!isSimpleTxn(t)) return null;
  const line = categoryLine(t);
  const a = line && entities('account').find(x => x.id === line.accountId);
  return (a && a.type === 'income') ? line : null;
}
// A read-only summary of a split's per-line vendors / invoices (shown where an inline txn-level field
// can't represent multiple per-line tags — the owner edits those in the full transaction editor).
function vendorSummary(t) {
  const byId = new Map(entities('vendor').map(v => [v.id, v]));
  const names = [...new Set((t.lines || []).map(l => l.vendorId).filter(Boolean).map(id => byId.get(id)?.name).filter(Boolean))];
  if (names.length) return names.length === 1 ? names[0] : `Split — ${names.length} vendors`;
  return t.vendorId ? (byId.get(t.vendorId)?.name || '') : '';
}
function invoiceSummary(t) {
  const byId = new Map(entities('invoice').map(i => [i.id, i]));
  const lab = (id) => { const iv = byId.get(id); return iv ? `#${iv.number || iv.id}` : ''; };
  const ids = [...new Set((t.lines || []).map(l => l.invoiceId).filter(Boolean))];
  if (ids.length) return ids.length === 1 ? lab(ids[0]) : `Split — ${ids.length} invoices`;
  return t.invoiceId ? lab(t.invoiceId) : '';
}

// Apply a single-field change and persist. `reconciled` txns keep their date /
// accounts / amounts locked (same rule as the edit modal) — category edits on
// them are rejected; vendor / memo / invoice are metadata and always allowed.
function commit(t, patch) {
  let updated = { ...t };
  if ('categoryId' in patch) {
    const line = categoryLine(t);
    if (!line || !patch.categoryId) return false;
    // Reconciled: the category (non-bank) line is still editable; only a transfer's
    // bank-to-bank line is locked (changing it would move the other account's balance).
    if (t.reconciledIn) { const acct = entities('account').find(a => a.id === line.accountId); if (acct && bankish(acct)) { toast('Reconciled transfer — account is locked.', 'err'); return false; } }
    updated.lines = t.lines.map(l => l === line ? { ...l, accountId: patch.categoryId } : l);
  }
  if ('vendorId' in patch) {
    const incLine = incomeCatLine(t);
    if (incLine) {
      updated.lines = (updated.lines || t.lines).map(l => l === incLine ? { ...l, vendorId: patch.vendorId || undefined } : l);
      updated.vendorId = undefined;   // income nets via the line only — never leave a stale txn-level vendor (double-tag)
    } else updated.vendorId = patch.vendorId || undefined;
  }
  if ('invoiceId' in patch) updated.invoiceId = patch.invoiceId || undefined;
  if ('memo' in patch) updated.memo = patch.memo.trim();
  const v = validateTxn(updated, ctx());
  if (!v.ok) { toast(v.error, 'err'); return false; }
  dispatch({ op: 'entity.upsert', kind: 'txn', value: updated });
  return true;
}

// A light "face" showing the field's current value; clicking it upgrades the cell to
// a real type-to-search combobox (and opens it). Lazy on purpose — a ledger renders up
// to 200 rows × 3 of these, so only the cell you actually touch builds a combobox.
//
// Save model: a combobox pick is deliberate, so it commits immediately on `change`
// (including the inline "＋ Add…" flow, which sets the value then fires change). A
// failed validation rolls the value back; the row re-renders to the face on save.
function lazyCombo(t, { faceText, build, patch }) {
  const wrap = el('span', { class: 'txi-lazy' });
  const face = el('button', { type: 'button', class: 'txi txi-face', title: faceText }, faceText);
  let upgraded = false;
  const upgrade = () => {
    if (upgraded) return;
    upgraded = true;
    const cb = build();
    cb.classList.add('txi-cb');
    let last = cb.value;
    cb.addEventListener('change', () => {
      if (cb.value === last) return;
      const ok = commit(t, patch(cb.value));
      if (ok) { last = cb.value; toast('Saved'); } else { cb.value = last; }
    });
    wrap.replaceChildren(cb);
    cb.querySelector('input').focus();   // opens the search panel right away
  };
  face.addEventListener('focus', upgrade);
  face.addEventListener('mousedown', (e) => { e.preventDefault(); upgrade(); });
  wrap.append(face);
  return wrap;
}

export function categoryField(t) {
  const line = isSimpleTxn(t) ? categoryLine(t) : null;
  const byId = new Map(entities('account').map(a => [a.id, a]));
  const catIsBank = line && bankish(byId.get(line.accountId));
  // Reconciled simple txns stay editable on the category (non-bank) line — reconciliation
  // tracks the bank line only. Only a transfer's bank-to-bank line is locked when reconciled.
  if (!line || (t.reconciledIn && catIsBank)) {
    return el('span', { class: 'txi-static', title: t.reconciledIn ? 'Reconciled — locked' : 'Journal / split — edit the lines' }, categoryName(t) || describeFallback(t));
  }
  return lazyCombo(t, {
    faceText: categoryName(t) || 'Account',
    build: () => accountCombo({ filter: (a) => !bankish(a), selected: line.accountId, minWidth: 0 }),
    patch: (v) => ({ categoryId: v }),
  });
}

export function vendorField(t) {
  // A split carries per-line vendors an inline txn-level field can't represent — show a read-only
  // summary and send the owner to the full editor (which edits each line).
  if (!isSimpleTxn(t)) return el('span', { class: 'txi-static', title: 'Split — edit the lines' }, vendorSummary(t) || '— vendor —');
  const incLine = incomeCatLine(t);            // simple deposit → the vendor lives on the income line
  const curId = incLine ? (incLine.vendorId || t.vendorId) : t.vendorId;   // still show a legacy txn-level income vendor
  const cur = curId ? entities('vendor').find(v => v.id === curId) : null;
  return lazyCombo(t, {
    faceText: cur ? cur.name : '— vendor —',
    build: () => vendorCombo({ selected: curId || '', minWidth: 0 }),
    patch: (v) => ({ vendorId: v }),
  });
}

export function invoiceField(t) {
  if (!usesInvoices()) return null;
  if (!isSimpleTxn(t)) return el('span', { class: 'txi-static', title: 'Split — edit the lines' }, invoiceSummary(t) || '— invoice —');
  const cur = t.invoiceId ? entities('invoice').find(i => i.id === t.invoiceId) : null;
  const label = (i) => `#${i.number || i.id} · ${(i.clientName || '').slice(0, 24)}`;
  return lazyCombo(t, {
    faceText: cur ? label(cur) : '— invoice —',
    build: () => invoiceCombo({ selected: t.invoiceId || '', minWidth: 0 }),
    patch: (v) => ({ invoiceId: v }),
  });
}

// Memo: persists on blur and Enter, plus a debounced autosave while typing so a
// note isn't lost if the user navigates away without blurring.
export function memoField(t) {
  const inp = el('input', { class: 'txi', placeholder: 'Add a note…', value: t.memo || '' });
  bindSuggest(inp, 'memo');
  let timer = null;
  const save = () => { if ((inp.value.trim()) !== (t.memo || '').trim()) commit(t, { memo: inp.value }); };
  inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(save, 700); });
  inp.addEventListener('blur', () => { clearTimeout(timer); save(); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); save(); inp.blur(); } });
  return inp;
}

function describeFallback(t) {
  const byId = new Map(entities('account').map(a => [a.id, a]));
  return 'Journal — ' + (t.lines || []).map(l => byId.get(l.accountId)?.name || l.accountId).join(', ');
}

// The stacked editor for the phone tap-to-expand row: the same four fields,
// labelled, one per line.
export function stackedEditor(t) {
  const field = (label, node) => node ? el('div', { style: 'margin-bottom:8px' }, el('label', { class: 'field-label', style: 'margin:0 0 2px' }, label), node) : null;
  return el('div', {},
    field('Account', categoryField(t)),
    field('Vendor', vendorField(t)),
    field('Memo', memoField(t)),
    field('Invoice', invoiceField(t)));
}
