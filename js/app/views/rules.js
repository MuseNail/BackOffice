// ── view: rules — vendors and their auto-categorization matchers ────────────────
import { el, clear, toast, modal } from '../ui.js';
import { entities, subscribe } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { accountLabel } from '../lib/coa-templates.js';

let unsub = null;

export function render(root) {
  const editable = canEdit(getActiveBiz());
  const body = el('div');
  root.append(
    el('h2', {}, 'Vendors & rules'),
    el('p', { class: 'sub' }, 'Rules categorize imports automatically: exact matches win, then keywords, then your history. You still approve every row.'),
    editable ? el('div', { style: 'margin-bottom:14px' },
      el('button', { class: 'btn sm', onclick: () => ruleModal(null) }, 'New rule')) : null,
    body,
  );
  const draw = () => drawTable(body, editable);
  unsub = subscribe(draw);
  draw();
}

export function unmount() { unsub?.(); unsub = null; }

function drawTable(body, editable) {
  const vendors = entities('vendor').sort((a, b) => (b.used || 0) - (a.used || 0) || a.name.localeCompare(b.name));
  if (!vendors.length) {
    clear(body).append(el('p', { class: 'sub' }, 'No rules yet — tap ⚡ on any row in Review, or add one here.'));
    return;
  }
  const byId = new Map(entities('account').map(a => [a.id, a]));
  const acctName = (id) => { const a = byId.get(id); return a ? accountLabel(a, byId) : '—'; };
  const rows = vendors.map(v => el('tr', {},
    el('td', {}, el('b', {}, v.name)),
    el('td', {},
      ...(v.matchers?.exact || []).map(x => el('span', { class: 'pill blue', style: 'margin-right:4px' }, `exact: ${x}`)),
      ...(v.matchers?.keywords || []).map(k => el('span', { class: 'pill gray', style: 'margin-right:4px' }, `contains: ${k}`))),
    el('td', {}, acctName(v.defaultAccountId)),
    el('td', { class: 'num' }, `${v.used || 0}×`),
    el('td', {}, editable ? el('div', { style: 'display:flex;gap:6px' },
      el('button', { class: 'linklike', onclick: () => ruleModal(v) }, 'Edit'),
      el('button', { class: 'linklike', style: 'color:var(--red)', onclick: () => {
        dispatch({ op: 'entity.delete', kind: 'vendor', id: v.id });
        toast('Rule deleted');
      } }, 'Delete')) : ''),
  ));
  clear(body).append(el('div', { class: 'card', style: 'padding:0;overflow:hidden;max-width:880px' },
    el('table', { class: 'data' },
      el('tr', {}, el('th', {}, 'Vendor'), el('th', {}, 'Matches when'), el('th', {}, 'Category'), el('th', { class: 'num' }, 'Used'), el('th', {}, '')),
      ...rows)));
}

function ruleModal(existing) {
  const m = modal(existing ? 'Edit rule' : 'New rule');
  const byId = new Map(entities('account').map(a => [a.id, a]));
  const categories = entities('account')
    .filter(a => a.active !== false && a.qbType !== 'BANK' && a.qbType !== 'CCARD')
    .sort((a, b) => accountLabel(a, byId).localeCompare(accountLabel(b, byId)));
  const name = el('input', { class: 'field-input', value: existing?.name || '', placeholder: 'Vendor name' });
  const mode = el('select', { class: 'field-input' },
    el('option', { value: 'keyword', selected: !existing || !!existing.matchers?.keywords?.length }, 'Description contains…'),
    el('option', { value: 'exact', selected: !!existing?.matchers?.exact?.length }, 'Description is exactly…'));
  const text = el('input', { class: 'field-input', value: existing?.matchers?.keywords?.[0] || existing?.matchers?.exact?.[0] || '', placeholder: 'e.g. SALLY BEAUTY' });
  const cat = el('select', { class: 'field-input' },
    el('option', { value: '' }, '— category —'),
    ...categories.map(a => el('option', { value: a.id, selected: a.id === existing?.defaultAccountId }, accountLabel(a, byId))));
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
