// ── view: vendors — vendors, their auto-categorize rules, and per-vendor register ─
import { el, clear, toast, modal } from '../ui.js';
import { entities, subscribe } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { accountLabel } from '../lib/coa-templates.js';
import { normalizeDesc } from '../lib/match.js';
import { renderRegister } from '../register.js';

let unsub = null;
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// A transaction belongs to a vendor if it was stamped at approval (exact, going
// forward) OR — for older/unstamped ones — its description matches the vendor's rule.
export function vendorMatches(vendor, desc) {
  const d = normalizeDesc(desc);
  if (!d) return false;
  for (const m of vendor.matchers?.exact || []) if (d === normalizeDesc(m)) return true;
  for (const k of vendor.matchers?.keywords || []) { const kk = normalizeDesc(k); if (kk && d.includes(kk)) return true; }
  return false;
}
export const txnsForVendor = (vendor) => entities('txn').filter(t =>
  t.status === 'posted' && (t.vendorId === vendor.id || (!t.vendorId && vendorMatches(vendor, t.payee))));

export function render(root, detail) {
  if (detail) { renderVendorRegister(root, detail); return; }
  const editable = canEdit(getActiveBiz());
  const body = el('div');
  root.append(
    el('h2', {}, 'Vendors'),
    el('p', { class: 'sub' }, 'Each vendor categorizes its imports automatically (exact matches win, then keywords, then your history) — you still approve every row. Click a vendor to see all its transactions.'),
    editable ? el('div', { style: 'margin-bottom:14px' },
      el('button', { class: 'btn sm', onclick: () => ruleModal(null) }, 'New vendor / rule')) : el('span'),
    body,
  );
  const draw = () => drawTable(body, editable);
  unsub = subscribe(draw);
  draw();
}

export function unmount() { unsub?.(); unsub = null; }

// Vendor register (drill-down): every posted transaction from this vendor, total
// spent + export. Reached via #/b/<biz>/vendors/<vendorId>.
function renderVendorRegister(root, vendorId) {
  const biz = getActiveBiz();
  const vendor = entities('vendor').find(v => v.id === vendorId);
  if (!vendor) {
    root.append(el('p', { class: 'sub' }, 'That vendor no longer exists.'),
      el('a', { class: 'btn sm ghost', href: `#/b/${biz}/vendors` }, '← Back to vendors'));
    return;
  }
  unsub = renderRegister({
    root,
    title: vendor.name,
    subtitle: 'Vendor transactions',
    backHash: `/b/${biz}/vendors`,
    backLabel: 'Vendors',
    filename: `${biz}-${slug(vendor.name)}-transactions.csv`,
    getTxns: () => txnsForVendor(vendor),
  });
}

function drawTable(body, editable) {
  const vendors = entities('vendor').sort((a, b) => (b.used || 0) - (a.used || 0) || a.name.localeCompare(b.name));
  if (!vendors.length) {
    clear(body).append(el('p', { class: 'sub' }, 'No rules yet — tap ⚡ on any row in Review, or add one here.'));
    return;
  }
  const byId = new Map(entities('account').map(a => [a.id, a]));
  const acctName = (id) => { const a = byId.get(id); return a ? accountLabel(a, byId) : '—'; };
  const rows = vendors.map(v => {
    const targetAcct = byId.get(v.defaultAccountId);
    const isBroken = !targetAcct || targetAcct.active === false;
    return el('tr', { style: isBroken ? 'background:var(--amber-soft,#fff8f0)' : '' },
      el('td', {}, el('a', { class: 'linklike', style: 'font-weight:700', href: `#/b/${getActiveBiz()}/vendors/${v.id}`, title: 'View this vendor’s transactions' }, v.name), isBroken ? el('span', { class: 'pill amber', style: 'margin-left:6px' }, 'Category archived') : ''),
      el('td', {},
        ...(v.matchers?.exact || []).map(x => el('span', { class: 'pill blue', style: 'margin-right:4px' }, `exact: ${x}`)),
        ...(v.matchers?.keywords || []).map(k => el('span', { class: 'pill gray', style: 'margin-right:4px' }, `contains: ${k}`))),
      el('td', {}, acctName(v.defaultAccountId)),
      el('td', { class: 'num' }, `${v.used || 0}×`),
      el('td', {}, editable ? el('div', { style: 'display:flex;gap:6px' },
        el('button', { class: 'linklike', onclick: () => ruleModal(v) }, 'Edit'),
        el('button', { class: 'linklike', style: 'color:var(--red)', onclick: () => confirmDeleteRule(v) }, 'Delete')) : ''),
    );
  });
  clear(body).append(el('div', { class: 'card', style: 'padding:0;overflow:hidden;max-width:880px' },
    el('table', { class: 'data' },
      el('tr', {}, el('th', {}, 'Vendor'), el('th', {}, 'Matches when'), el('th', {}, 'Category'), el('th', { class: 'num' }, 'Used'), el('th', {}, '')),
      ...rows)));
}

function confirmDeleteRule(v) {
  const m = modal('Delete this rule?');
  m.body.append(
    el('p', {}, `"${v.name}" — the rule will stop suggesting this category on new imports. Already-posted transactions are not affected.`),
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Keep it'),
      el('button', { class: 'btn', style: 'background:var(--red)', onclick: () => {
        dispatch({ op: 'entity.delete', kind: 'vendor', id: v.id });
        toast('Rule deleted');
        m.close();
      } }, 'Delete')),
  );
}

function ruleModal(existing) {
  const m = modal(existing ? 'Edit rule' : 'New rule');
  const byId = new Map(entities('account').map(a => [a.id, a]));
  const isBankish = (a) => a.qbType === 'BANK' || a.qbType === 'CCARD';
  const active = entities('account').filter(a => a.active !== false);
  // Bank/card accounts are offered as transfer destinations (a rule can auto-categorize
  // a recurring transfer to another account), then the income/expense/etc. categories.
  const transferTargets = active.filter(isBankish).sort((a, b) => accountLabel(a, byId).localeCompare(accountLabel(b, byId)));
  const categories = active.filter(a => !isBankish(a)).sort((a, b) => accountLabel(a, byId).localeCompare(accountLabel(b, byId)));
  const name = el('input', { class: 'field-input', value: existing?.name || '', placeholder: 'Vendor name' });
  const mode = el('select', { class: 'field-input' },
    el('option', { value: 'keyword', selected: !existing || !!existing.matchers?.keywords?.length }, 'Description contains…'),
    el('option', { value: 'exact', selected: !!existing?.matchers?.exact?.length }, 'Description is exactly…'));
  const text = el('input', { class: 'field-input', value: existing?.matchers?.keywords?.[0] || existing?.matchers?.exact?.[0] || '', placeholder: 'e.g. SALLY BEAUTY' });
  const cat = el('select', { class: 'field-input' },
    el('option', { value: '' }, '— category —'),
    transferTargets.length ? el('optgroup', { label: '↔ Transfer to / from' },
      ...transferTargets.map(a => el('option', { value: a.id, selected: a.id === existing?.defaultAccountId }, accountLabel(a, byId)))) : null,
    el('optgroup', { label: 'Categories' },
      ...categories.map(a => el('option', { value: a.id, selected: a.id === existing?.defaultAccountId }, accountLabel(a, byId)))));
  m.body.append(
    el('label', { class: 'field-label' }, 'Vendor'), name,
    el('label', { class: 'field-label' }, 'Match type'), mode,
    el('label', { class: 'field-label' }, 'Match text'), text,
    el('label', { class: 'field-label' }, 'Category'), cat,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: () => {
        if (!name.value.trim() || !text.value.trim() || !cat.value) { toast('Fill all the fields', 'err'); return; }
        dispatch({ op: 'entity.upsert', kind: 'vendor', value: {
          ...(existing || { used: 0 }),
          id: existing?.id || 'v-' + name.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30),
          name: name.value.trim(),
          matchers: mode.value === 'exact'
            ? { exact: [text.value.trim()], keywords: [] }
            : { exact: [], keywords: [text.value.trim()] },
          defaultAccountId: cat.value,
        } });
        toast('Rule saved');
        m.close();
      } }, 'Save')),
  );
  setTimeout(() => name.focus(), 0);
}
