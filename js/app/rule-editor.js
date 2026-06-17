// ── rule-editor — shared "match conditions" builder for vendor auto-rules ──────
// Used by Review's ⚡ make-a-rule modal and the Vendors-tab rule editor so the two
// stay identical. Produces a matchers object that lib/match.js understands:
//   { exact:[], keywords:[], conditions:[{type,text}], direction, amountMin, amountMax }
// `exact`/`keywords` are kept populated for UNRESTRICTED plain rules so older code
// (and not-yet-updated devices) still match — see buildMatchers.
import { el } from './ui.js';
import { parseMoney } from './lib/money.js';

const TYPES = [['contains', 'contains'], ['starts', 'starts with'], ['exact', 'is exactly'], ['regex', 'matches pattern']];

// Normalize any matchers (new or legacy) into a conditions array for seeding the editor.
export function matchersToConditions(matchers = {}) {
  if (Array.isArray(matchers.conditions) && matchers.conditions.length) {
    return matchers.conditions.map(c => ({ type: c.type || 'contains', text: c.text || '' }));
  }
  const seeded = [
    ...(matchers.exact || []).map(t => ({ type: 'exact', text: t })),
    ...(matchers.keywords || []).map(t => ({ type: 'contains', text: t })),
  ];
  return seeded.length ? seeded : [];
}

// A live "matches N transactions" preview line. Pass a recompute() that returns
// { n, samples:[..] }; call update() whenever the rule changes.
export function rulePreview() {
  const node = el('div', { class: 'rule-preview' });
  const set = ({ n, samples = [] }) => {
    node.className = 'rule-preview' + (n ? '' : ' zero');
    node.replaceChildren(
      el('b', {}, n ? `Matches ${n} of your imported transactions` : 'No transactions match yet'),
      samples.length ? el('div', { class: 'rule-samp' }, 'e.g. ' + samples.slice(0, 2).join(' · ') + (n > 2 ? ' …' : '')) : null);
  };
  return { el: node, set };
}

// The conditions + direction/amount editor. opts.seed = a matchers object to prefill;
// opts.onChange fires on any edit (for a live preview).
export function ruleConditionsEditor({ seed = {}, onChange } = {}) {
  let conds = matchersToConditions(seed);
  if (!conds.length) conds = [{ type: 'contains', text: '' }];
  const fire = () => onChange?.();

  const list = el('div');
  const draw = () => {
    list.replaceChildren(...conds.map((c, i) => {
      const typeSel = el('select', { class: 'field-input', style: 'flex:none;width:132px;margin:0',
        onchange: (e) => { c.type = e.target.value; fire(); } }, ...TYPES.map(([v, l]) => el('option', { value: v, selected: v === c.type }, l)));
      const txt = el('input', { class: 'field-input', style: 'flex:1;margin:0', value: c.text, placeholder: 'e.g. SALLY BEAUTY',
        oninput: (e) => { c.text = e.target.value; fire(); } });
      const x = conds.length > 1 ? el('button', { class: 'iconbtn', type: 'button', title: 'Remove', onclick: () => { conds.splice(i, 1); draw(); fire(); } }, '×') : null;
      return el('div', { style: 'display:flex;gap:7px;align-items:center;margin-bottom:6px' }, typeSel, txt, x);
    }));
  };
  draw();
  const add = el('button', { class: 'addcond', type: 'button', onclick: () => { conds.push({ type: 'contains', text: '' }); draw(); } }, '＋ Add another condition');

  const seedDir = (seed.amountMin != null || seed.amountMax != null) ? 'range' : (seed.direction || 'any');
  const dirSel = el('select', { class: 'field-input', onchange: () => { syncRange(); fire(); } },
    el('option', { value: 'any', selected: seedDir === 'any' }, 'Any amount'),
    el('option', { value: 'in', selected: seedDir === 'in' }, 'Deposits only (money in)'),
    el('option', { value: 'out', selected: seedDir === 'out' }, 'Withdrawals only (money out)'),
    el('option', { value: 'range', selected: seedDir === 'range' }, 'Amount between…'));
  const minIn = el('input', { class: 'field-input', inputmode: 'decimal', placeholder: 'min $', style: 'flex:1;margin:0', value: seed.amountMin != null ? (seed.amountMin / 100).toFixed(2) : '', oninput: fire });
  const maxIn = el('input', { class: 'field-input', inputmode: 'decimal', placeholder: 'max $', style: 'flex:1;margin:0', value: seed.amountMax != null ? (seed.amountMax / 100).toFixed(2) : '', oninput: fire });
  const rangeRow = el('div', { style: 'display:flex;gap:7px;margin-top:6px' }, minIn, maxIn);
  const syncRange = () => { rangeRow.style.display = dirSel.value === 'range' ? 'flex' : 'none'; };
  syncRange();

  const node = el('div', {},
    el('label', { class: 'field-label' }, 'Match when the description…'),
    list, add,
    el('label', { class: 'field-label' }, 'Only for'), dirSel, rangeRow);

  const get = () => {
    const conditions = conds.map(c => ({ type: c.type, text: (c.text || '').trim() })).filter(c => c.text);
    const isRange = dirSel.value === 'range';
    const amountMin = isRange ? (parseMoney(minIn.value) ?? null) : null;
    const amountMax = isRange ? (parseMoney(maxIn.value) ?? null) : null;
    return { conditions, direction: isRange ? 'any' : dirSel.value, amountMin, amountMax };
  };
  return { el: node, get };
}

// Build a matchers object from the editor's spec. For an UNRESTRICTED rule (any
// amount, no range) we also write the plain text into legacy exact[]/keywords[] so
// older code keeps matching; restricted/advanced rules rely on `conditions` only.
export function buildMatchers(spec) {
  const unrestricted = spec.direction === 'any' && spec.amountMin == null && spec.amountMax == null;
  const keywords = unrestricted ? [...new Set(spec.conditions.filter(c => c.type === 'contains').map(c => c.text))] : [];
  const exact = unrestricted ? [...new Set(spec.conditions.filter(c => c.type === 'exact').map(c => c.text))] : [];
  return { exact, keywords, conditions: spec.conditions, direction: spec.direction, amountMin: spec.amountMin, amountMax: spec.amountMax };
}

// Human summary of a rule for the Vendors-tab manager list.
export function ruleSummary(matchers = {}) {
  const conds = matchersToConditions(matchers);
  if (!conds.length) return 'no rule';
  const verb = { contains: 'contains', starts: 'starts with', exact: 'is', regex: 'matches' };
  let s = conds.map(c => `${verb[c.type] || 'contains'} “${c.text}”`).join(' + ');
  if (matchers.direction === 'in') s += ' · deposits';
  else if (matchers.direction === 'out') s += ' · withdrawals';
  if (matchers.amountMin != null || matchers.amountMax != null) s += ' · amount-limited';
  return s;
}
