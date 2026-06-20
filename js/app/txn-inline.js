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

// Apply a single-field change and persist. `reconciled` txns keep their date /
// accounts / amounts locked (same rule as the edit modal) — category edits on
// them are rejected; vendor / memo / invoice are metadata and always allowed.
function commit(t, patch) {
  let updated = { ...t };
  if ('categoryId' in patch) {
    if (t.reconciledIn) { toast('Reconciled — account is locked. Use a journal entry.', 'err'); return false; }
    const line = categoryLine(t);
    if (!line || !patch.categoryId) return false;
    updated.lines = t.lines.map(l => l === line ? { ...l, accountId: patch.categoryId } : l);
  }
  if ('vendorId' in patch) updated.vendorId = patch.vendorId || undefined;
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
  if (!isSimpleTxn(t) || t.reconciledIn) {
    return el('span', { class: 'txi-static', title: t.reconciledIn ? 'Reconciled — locked' : 'Journal / split — edit the lines' }, categoryName(t) || describeFallback(t));
  }
  const line = categoryLine(t);
  return lazyCombo(t, {
    faceText: categoryName(t) || 'Account',
    build: () => accountCombo({ filter: (a) => !bankish(a), selected: line.accountId, minWidth: 0 }),
    patch: (v) => ({ categoryId: v }),
  });
}

export function vendorField(t) {
  const cur = t.vendorId ? entities('vendor').find(v => v.id === t.vendorId) : null;
  return lazyCombo(t, {
    faceText: cur ? cur.name : '— vendor —',
    build: () => vendorCombo({ selected: t.vendorId || '', minWidth: 0 }),
    patch: (v) => ({ vendorId: v }),
  });
}

export function invoiceField(t) {
  if (!usesInvoices()) return null;
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
