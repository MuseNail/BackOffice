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

import { el, clear, toast } from './ui.js';
import { entities, usesInvoices } from './store.js';
import { dispatch } from './sync.js';
import { validateTxn } from './lib/posting.js';
import { accountLabel } from './lib/coa-templates.js';
import { attachAddCategory, attachAddVendor, NEW_CATEGORY, NEW_VENDOR } from './pickers.js';

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
    if (t.reconciledIn) { toast('Reconciled — category is locked. Use a journal entry.', 'err'); return false; }
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

// A <select> that shows only its current value until focused, then fills in the
// full list once. onPick(value) fires on a real selection (the "＋ Add…" sentinels
// are handled by the pickers and skipped here).
function lazySelect(t, { value, text, populate, addKind }) {
  const sel = el('select', { class: 'txi' }, el('option', { value: value || '' }, text));
  let loaded = false;
  let last = value || '';
  const load = () => { if (loaded) return; loaded = true; clear(sel); populate(sel); sel.value = value || ''; };
  sel.addEventListener('focus', load);
  sel.addEventListener('mousedown', load);
  if (addKind === 'category') attachAddCategory(sel, value);
  if (addKind === 'vendor') attachAddVendor(sel, value);
  sel.addEventListener('change', () => {
    if (sel.value === NEW_CATEGORY || sel.value === NEW_VENDOR) return; // picker resets the value + opens its modal
    if (sel.value === last) return;                                      // no real change (or a reset after cancelling Add…)
    const ok = commit(t, addKind === 'category' ? { categoryId: sel.value }
      : addKind === 'vendor' ? { vendorId: sel.value }
      : { invoiceId: sel.value });
    if (ok) { last = sel.value; toast('Saved'); }
    else sel.value = last;                                               // validation failed — roll the field back
  });
  return sel;
}

const sortAccts = (list, byId) => list.sort((a, b) => (a.type + accountLabel(a, byId)).localeCompare(b.type + accountLabel(b, byId)));

export function categoryField(t) {
  if (!isSimpleTxn(t) || t.reconciledIn) {
    return el('span', { class: 'txi-static', title: t.reconciledIn ? 'Reconciled — locked' : 'Journal / split — edit the lines' }, categoryName(t) || describeFallback(t));
  }
  const line = categoryLine(t);
  return lazySelect(t, {
    value: line.accountId, text: categoryName(t) || 'Category', addKind: 'category',
    populate: (sel) => {
      const byId = new Map(entities('account').map(a => [a.id, a]));
      const cats = sortAccts(entities('account').filter(a => a.active !== false && !bankish(a)), byId);
      if (!cats.some(a => a.id === line.accountId) && byId.get(line.accountId)) cats.unshift(byId.get(line.accountId));
      for (const a of cats) sel.append(el('option', { value: a.id, selected: a.id === line.accountId }, accountLabel(a, byId)));
      sel.append(el('option', { value: NEW_CATEGORY }, '＋ Add category…'));
    },
  });
}

export function vendorField(t) {
  const cur = t.vendorId ? entities('vendor').find(v => v.id === t.vendorId) : null;
  return lazySelect(t, {
    value: t.vendorId || '', text: cur ? cur.name : '— vendor —', addKind: 'vendor',
    populate: (sel) => {
      sel.append(el('option', { value: '' }, '— none —'));
      for (const v of entities('vendor').slice().sort((a, b) => a.name.localeCompare(b.name)))
        sel.append(el('option', { value: v.id, selected: v.id === t.vendorId }, v.name));
      sel.append(el('option', { value: NEW_VENDOR }, '＋ Add vendor…'));
    },
  });
}

export function invoiceField(t) {
  if (!usesInvoices()) return null;
  const cur = t.invoiceId ? entities('invoice').find(i => i.id === t.invoiceId) : null;
  const label = (i) => `#${i.number || i.id} · ${(i.clientName || '').slice(0, 24)}`;
  return lazySelect(t, {
    value: t.invoiceId || '', text: cur ? label(cur) : '— invoice —',
    populate: (sel) => {
      sel.append(el('option', { value: '' }, '— none —'));
      for (const i of entities('invoice').slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')))
        sel.append(el('option', { value: i.id, selected: i.id === t.invoiceId }, label(i)));
    },
  });
}

// Memo: persists on blur and Enter, plus a debounced autosave while typing so a
// note isn't lost if the user navigates away without blurring.
export function memoField(t) {
  const inp = el('input', { class: 'txi', placeholder: 'Add a note…', value: t.memo || '' });
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
    field('Category', categoryField(t)),
    field('Vendor', vendorField(t)),
    field('Memo', memoField(t)),
    field('Invoice', invoiceField(t)));
}
