// ── view: setup — new-business wizard ────────────────
// Basics → Industry → Starting accounts → create. Creation seeds the new
// BusinessDO with meta + the industry COA in one bulkUpsert. The owner-PIN
// step from the mockup arrives with M2 (users live per-business).
import { el, clear, toast } from '../ui.js';
import { api } from '../sync.js';
import { deviceId } from '../session.js';
import { INDUSTRIES, coaFor, industryLabel } from '../lib/coa-templates.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const TYPE_LABELS = { income: 'Income', cogs: 'Cost of goods', expense: 'Expenses', asset: 'Assets', liability: 'Liabilities', equity: 'Equity' };

let s = null;
let box = null;

export function render(root) {
  s = { step: 1, name: '', fiscal: 'January', industry: 'salon-spa', busy: false };
  box = el('div', { class: 'card wizard' });
  root.append(
    el('h2', {}, 'New business'),
    el('p', { class: 'sub' }, 'Three steps — you can change all of this later in Settings.'),
    box,
  );
  draw();
}

export function unmount() { s = null; box = null; }

function draw() {
  clear(box).append(stepbar(), ...steps[s.step]());
}

function stepbar() {
  const items = ['Basics', 'Industry', 'Starting accounts'];
  return el('div', { class: 'stepbar' }, items.flatMap((t, i) => {
    const n = i + 1;
    const cls = n === s.step ? 'step on' : n < s.step ? 'step done' : 'step';
    const node = el('div', { class: cls }, el('span', { class: 'n' }, n < s.step ? '✓' : String(n)), ` ${t}`);
    return i < items.length - 1 ? [node, el('div', { class: 'steplink' })] : [node];
  }));
}

const steps = {
  1() {
    const name = el('input', { class: 'field-input', placeholder: 'Business name', value: s.name,
      oninput: (e) => { s.name = e.target.value; } });
    const fiscal = el('select', { class: 'field-input', onchange: (e) => { s.fiscal = e.target.value; } },
      ...MONTHS.map(m => el('option', { value: m, selected: m === s.fiscal }, m)));
    return [
      el('label', { class: 'field-label' }, 'Business name'), name,
      el('label', { class: 'field-label' }, 'Fiscal year starts'), fiscal,
      el('div', { class: 'wizbtns' },
        el('button', { class: 'btn', onclick: () => {
          if (!s.name.trim()) { toast('Give the business a name', 'err'); return; }
          s.step = 2; draw();
        } }, 'Continue')),
    ];
  },
  2() {
    return [
      el('p', { class: 'sub' }, 'Pick the closest match — this builds the starting chart of accounts. Rename, add, or archive accounts anytime.'),
      el('div', { class: 'indgrid' }, INDUSTRIES.map(ind =>
        el('div', { class: 'indopt' + (ind.id === s.industry ? ' on' : ''), onclick: () => { s.industry = ind.id; draw(); } },
          el('span', { class: 'ms' }, ind.icon), ind.label))),
      el('div', { class: 'wizbtns' },
        el('button', { class: 'btn ghost', onclick: () => { s.step = 1; draw(); } }, 'Back'),
        el('button', { class: 'btn', onclick: () => { s.step = 3; draw(); } }, 'Continue')),
    ];
  },
  3() {
    const coa = coaFor(s.industry);
    const groups = [];
    for (const t of ['income', 'cogs', 'liability', 'asset', 'equity', 'expense']) {
      const accts = coa.filter(a => a.type === t);
      if (!accts.length) continue;
      groups.push(el('div', { class: 'coagroup' },
        el('div', { class: 'coatype' }, TYPE_LABELS[t]),
        ...accts.map(a => el('div', { class: 'coaacct' }, a.name))));
    }
    return [
      el('p', { class: 'sub' }, `${s.name.trim()} starts with these ${coa.length} accounts (${industryLabel(s.industry)}):`),
      el('div', { class: 'coapreview' }, groups),
      el('div', { class: 'wizbtns' },
        el('button', { class: 'btn ghost', onclick: () => { s.step = 2; draw(); } }, 'Back'),
        el('button', { class: 'btn green', disabled: s.busy, onclick: create }, s.busy ? 'Creating…' : 'Create business')),
    ];
  },
};

async function create() {
  if (s.busy) return;
  s.busy = true; draw();
  const name = s.name.trim();
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  try {
    const res = await api('/registry/businesses', {
      method: 'POST',
      body: JSON.stringify({ id, name, industry: s.industry, createdAt: Date.now() }),
    });
    if (res.status === 409) { toast('A business with a similar name already exists', 'err'); s.busy = false; draw(); return; }
    if (!res.ok) throw new Error('registry');

    const now = Date.now();
    const metaRes = await api(`/b/${id}/state`, {
      method: 'POST',
      body: JSON.stringify({ op: 'meta.set', value: { name, industry: s.industry, fiscalYearStart: s.fiscal, createdAt: now }, device: deviceId() }),
    });
    if (!metaRes.ok) throw new Error('meta');

    const values = coaFor(s.industry).map(a => ({ ...a, updatedAt: now, updatedBy: deviceId() }));
    const coaRes = await api(`/b/${id}/state`, {
      method: 'POST',
      body: JSON.stringify({ op: 'entity.bulkUpsert', kind: 'account', values, device: deviceId() }),
    });
    if (!coaRes.ok) throw new Error('coa');

    toast(`${name} is ready`);
    location.hash = `#/b/${id}/dashboard`;
  } catch (e) {
    console.error('[setup]', e);
    toast('Could not create the business — check the connection', 'err');
    s.busy = false; draw();
  }
}
