// ── daterange — shared smart date-range control (quick presets + custom) ───────
// Returns { el, getRange } where getRange() → { from, to } as 'YYYY-MM-DD' strings
// (null/null = all time). Mirrors the Muse reports picker: pick a quick range or a
// custom from/to. Defaults to the current calendar year.
import { el } from './ui.js';

const pad = (n) => String(n).padStart(2, '0');
const fmt = (y, m0, d) => `${y}-${pad(m0 + 1)}-${pad(d)}`;          // m0 = 0-based month
const dim = (y, m0) => new Date(y, m0 + 1, 0).getDate();            // days in month

export function presetRange(key) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  switch (key) {
    case 'year': return { from: fmt(y, 0, 1), to: fmt(y, 11, 31) };
    case 'ytd': return { from: fmt(y, 0, 1), to: fmt(y, m, d) };
    case 'quarter': { const q = Math.floor(m / 3) * 3; return { from: fmt(y, q, 1), to: fmt(y, q + 2, dim(y, q + 2)) }; }
    case 'month': return { from: fmt(y, m, 1), to: fmt(y, m, dim(y, m)) };
    case 'lastmonth': { const lm = m === 0 ? 11 : m - 1, ly = m === 0 ? y - 1 : y; return { from: fmt(ly, lm, 1), to: fmt(ly, lm, dim(ly, lm)) }; }
    case 'lastyear': return { from: fmt(y - 1, 0, 1), to: fmt(y - 1, 11, 31) };
    case 'all': return { from: null, to: null };
    default: return null; // custom — caller reads the date inputs
  }
}

const PRESETS = [
  ['year', 'This year'], ['ytd', 'Year to date'], ['quarter', 'This quarter'],
  ['month', 'This month'], ['lastmonth', 'Last month'], ['lastyear', 'Last year'],
  ['all', 'All time'], ['custom', 'Custom…'],
];

export function inRange(date, range) {
  if (!date) return false;
  if (range.from && date < range.from) return false;
  if (range.to && date > range.to) return false;
  return true;
}

// onChange(range) fires whenever the selection changes. initial = a preset key.
export function dateRangeControl({ initial = 'year', onChange } = {}) {
  let preset = initial;
  let range = presetRange(preset) || { from: null, to: null };
  const sel = el('select', { class: 'field-input', style: 'width:auto;min-width:130px;margin:0' },
    ...PRESETS.map(([v, l]) => el('option', { value: v, selected: v === preset }, l)));
  const fromIn = el('input', { type: 'date', class: 'field-input', style: 'max-width:150px;margin:0', value: range.from || '' });
  const toIn = el('input', { type: 'date', class: 'field-input', style: 'max-width:150px;margin:0', value: range.to || '' });
  const custom = el('span', { style: 'gap:6px;align-items:center' }, fromIn, el('span', { class: 'sub', style: 'margin:0' }, '→'), toIn);
  const showCustom = () => { custom.style.display = preset === 'custom' ? 'inline-flex' : 'none'; };
  const fire = () => { if (onChange) onChange(range); };
  sel.addEventListener('change', () => {
    preset = sel.value;
    if (preset !== 'custom') { range = presetRange(preset); fromIn.value = range.from || ''; toIn.value = range.to || ''; }
    else range = { from: fromIn.value || null, to: toIn.value || null };
    showCustom(); fire();
  });
  const onCustom = () => { preset = 'custom'; sel.value = 'custom'; range = { from: fromIn.value || null, to: toIn.value || null }; showCustom(); fire(); };
  fromIn.addEventListener('change', onCustom);
  toIn.addEventListener('change', onCustom);
  showCustom();
  const reset = () => { preset = initial; sel.value = initial; range = presetRange(initial) || { from: null, to: null }; fromIn.value = range.from || ''; toIn.value = range.to || ''; showCustom(); fire(); };
  return { el: el('span', { style: 'display:inline-flex;gap:8px;align-items:center' }, sel, custom), getRange: () => range, reset };
}
