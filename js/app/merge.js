// ── merge — combine two vendors / customers / accounts into one ────────────────
// Reassigns everything pointing at the source onto the target, then removes the
// source. Vendor/customer merges only move a tag (vendorId/customerId). Account
// merges rewrite transaction LINES (financial) — guarded against locked periods and
// the source is archived (accounts keep history, never hard-deleted).
import { el, modal, toast } from './ui.js';
import { entities } from './store.js';
import { dispatch } from './sync.js';
import { combobox } from './combobox.js';
import { txnHasVendor, remapVendor } from './lib/vendor-attribution.js';

const now = () => Date.now();

export function mergeVendor(fromId, toId) {
  // Catch txns that reference the source vendor at the top level OR on a split line, and
  // rewrite BOTH — a line-only tag left behind would dangle at the deleted vendor.
  const txns = entities('txn').filter(t => txnHasVendor(t, fromId));
  if (txns.length) dispatch({ op: 'entity.bulkUpsert', kind: 'txn', values: txns.map(t => ({ ...remapVendor(t, fromId, toId), updatedAt: now() })) });
  dispatch({ op: 'entity.delete', kind: 'vendor', id: fromId });
  return txns.length;
}

export function mergeCustomer(fromId, toId) {
  const txns = entities('txn').filter(t => t.customerId === fromId);
  if (txns.length) dispatch({ op: 'entity.bulkUpsert', kind: 'txn', values: txns.map(t => ({ ...t, customerId: toId, updatedAt: now() })) });
  dispatch({ op: 'entity.delete', kind: 'customer', id: fromId });
  return txns.length;
}

// What an account merge would touch, and which months are locked (those would be
// rejected server-side — a material change to posted txns in a closed period).
export function accountMergeBlockers(fromId) {
  const locks = new Set(entities('lock').map(l => l.id));
  const affected = entities('txn').filter(t => t.status !== 'void' && (t.lines || []).some(l => l.accountId === fromId));
  const lockedMonths = [...new Set(affected.filter(t => locks.has((t.date || '').slice(0, 7))).map(t => (t.date || '').slice(0, 7)))].sort();
  return { count: affected.length, lockedMonths };
}

export function mergeAccount(fromId, toId) {
  const affected = entities('txn').filter(t => (t.lines || []).some(l => l.accountId === fromId));
  const updated = affected.map(t => {
    // Re-point lines, coalescing any that now share an account (keeps entries balanced).
    const byAcct = new Map();
    for (const l of (t.lines || [])) {
      const aid = l.accountId === fromId ? toId : l.accountId;
      if (byAcct.has(aid)) byAcct.get(aid).amountCents += l.amountCents;
      else byAcct.set(aid, { ...l, accountId: aid });
    }
    return { ...t, lines: [...byAcct.values()], updatedAt: now() };
  });
  if (updated.length) dispatch({ op: 'entity.bulkUpsert', kind: 'txn', values: updated });
  const vends = entities('vendor').filter(v => v.defaultAccountId === fromId);
  if (vends.length) dispatch({ op: 'entity.bulkUpsert', kind: 'vendor', values: vends.map(v => ({ ...v, defaultAccountId: toId, updatedAt: now() })) });
  const banks = entities('bankacct').filter(b => b.accountId === fromId);
  if (banks.length) dispatch({ op: 'entity.bulkUpsert', kind: 'bankacct', values: banks.map(b => ({ ...b, accountId: toId, updatedAt: now() })) });
  const acct = entities('account').find(a => a.id === fromId);
  if (acct) dispatch({ op: 'entity.upsert', kind: 'account', value: { ...acct, active: false, mergedInto: toId, updatedAt: now() } });
  return affected.length;
}

// Generic merge dialog: pick a target to merge `source` INTO, confirm, run `run`.
export function openMergeModal({ title, source, candidates, labelOf, run, note = '', onDone }) {
  const m = modal('Merge ' + title);
  const others = candidates.filter(c => c.id !== source.id).sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  if (!others.length) {
    m.body.append(el('p', { class: 'sub' }, `No other ${title} to merge into.`),
      el('div', { style: 'display:flex;justify-content:flex-end;margin-top:12px' }, el('button', { class: 'btn ghost', onclick: m.close }, 'Close')));
    return;
  }
  const sel = combobox({ groups: [{ label: '', items: others.map(c => ({ value: c.id, label: labelOf(c) })) }], placeholder: 'Search…', minWidth: 300 });
  sel.style.cssText = 'display:block;width:100%;max-width:360px';
  m.body.append(
    el('p', {}, `Move everything from “${labelOf(source)}” onto another ${title}, then remove “${labelOf(source)}”. `,
      el('b', {}, 'No transactions are deleted'), ` — they’re re-pointed to the ${title} you pick. This can’t be undone.`),
    note ? el('p', { class: 'sub' }, note) : null,
    el('label', { class: 'field-label' }, `Merge into which ${title}?`), sel,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', style: 'background:var(--red)', onclick: () => {
        if (!sel.value) { toast('Pick a target', 'err'); return; }
        const moved = run(source.id, sel.value);
        toast(`Merged — ${moved} transaction${moved === 1 ? '' : 's'} moved`);
        m.close(); onDone?.();
      } }, 'Merge')));
}
