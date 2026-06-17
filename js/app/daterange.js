// ── daterange — Muse-style date picker (button → popover: presets rail + calendar) ─
// One control used everywhere a date is chosen. The trigger is a single pill button
// showing the current selection; clicking it opens a popover with smart-range
// presets down the left and a month calendar on the right (click a day for that day,
// or a start then an end for a range). Mirrors the Muse Reports picker.
//
//   dateRangeControl({ initial, onChange }) -> { el, getRange, reset, setRange }
//   dateControl({ value, onPick })          -> { el, getValue, setValue }   (single day)
import { el } from './ui.js';

const pad = (n) => String(n).padStart(2, '0');
const fmt = (y, m0, d) => `${y}-${pad(m0 + 1)}-${pad(d)}`;          // m0 = 0-based month
const fmtD = (dt) => fmt(dt.getFullYear(), dt.getMonth(), dt.getDate());
const dim = (y, m0) => new Date(y, m0 + 1, 0).getDate();           // days in month
const parseIso = (s) => new Date(s + 'T00:00:00');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const shortDate = (iso) => { const d = parseIso(iso); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
const longDay = (iso) => { const d = parseIso(iso); return `${DOW[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`; };

export function presetRange(key) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  switch (key) {
    case 'today': return { from: fmt(y, m, d), to: fmt(y, m, d) };
    // Weeks run Sunday→Saturday (US convention); getDay() 0 = Sunday.
    case 'thisweek': { const dow = now.getDay(); return { from: fmtD(new Date(y, m, d - dow)), to: fmtD(new Date(y, m, d - dow + 6)) }; }
    case 'lastweek': { const dow = now.getDay(); return { from: fmtD(new Date(y, m, d - dow - 7)), to: fmtD(new Date(y, m, d - dow - 1)) }; }
    case 'year': return { from: fmt(y, 0, 1), to: fmt(y, 11, 31) };
    case 'ytd': return { from: fmt(y, 0, 1), to: fmt(y, m, d) };
    case 'quarter': { const q = Math.floor(m / 3) * 3; return { from: fmt(y, q, 1), to: fmt(y, q + 2, dim(y, q + 2)) }; }
    case 'lastquarter': { const q = Math.floor(m / 3) * 3, sm = (q + 9) % 12, sy = q === 0 ? y - 1 : y; return { from: fmt(sy, sm, 1), to: fmt(sy, sm + 2, dim(sy, sm + 2)) }; }
    case 'month': return { from: fmt(y, m, 1), to: fmt(y, m, dim(y, m)) };
    case 'lastmonth': { const lm = m === 0 ? 11 : m - 1, ly = m === 0 ? y - 1 : y; return { from: fmt(ly, lm, 1), to: fmt(ly, lm, dim(ly, lm)) }; }
    case 'lastyear': return { from: fmt(y - 1, 0, 1), to: fmt(y - 1, 11, 31) };
    case 'all': return { from: null, to: null };
    default: return null; // custom — caller picks on the calendar
  }
}

// Order shown in the presets rail.
const PRESETS = [
  ['today', 'Today'], ['thisweek', 'This week'], ['month', 'This month'],
  ['quarter', 'This quarter'], ['ytd', 'Year to date'], ['year', 'This year'],
  ['lastweek', 'Last week'], ['lastmonth', 'Last month'], ['lastquarter', 'Last quarter'],
  ['lastyear', 'Last year'], ['all', 'All time'],
];

export function inRange(date, range) {
  if (!date) return false;
  if (range.from && date < range.from) return false;
  if (range.to && date > range.to) return false;
  return true;
}

// Human label for a {from,to} range — matches a preset where possible, else the dates.
export function rangeLabel(range) {
  if (!range || (!range.from && !range.to)) return 'All time';
  for (const [key, label] of PRESETS) {
    if (key === 'all') continue;
    const r = presetRange(key);
    if (r && r.from === range.from && r.to === range.to) {
      if (key === 'today') return longDay(range.from);
      return `${label} · ${shortDate(range.from)} – ${shortDate(range.to)}`;
    }
  }
  if (range.from && range.from === range.to) return longDay(range.from);
  return `${range.from ? shortDate(range.from) : '…'} – ${range.to ? shortDate(range.to) : '…'}`;
}

// Shift a bounded range by its own length (the ‹ › steppers).
function shiftRange(range, dir) {
  if (!range.from || !range.to) return range;
  const f = parseIso(range.from), t = parseIso(range.to);
  const days = Math.round((t - f) / 86400000) + 1;
  const nf = new Date(f); nf.setDate(nf.getDate() + dir * days);
  const nt = new Date(t); nt.setDate(nt.getDate() + dir * days);
  return { from: fmtD(nf), to: fmtD(nt) };
}

// ── Shared popover plumbing ────────────────────────────────────────────────
// `wrap` scopes the outside-click test (clicks inside it never close the popover);
// `panel` is the floating calendar, positioned by CSS under the trigger and flipped
// to right-align when it would overflow the right edge of the viewport.
function makePopover(wrap, panel) {
  let open = false;
  // Clicks inside the popover are handled by its own controls (day/preset pick, month
  // nav). Stop them reaching the document handler — otherwise a click that rebuilds the
  // grid (the ‹ › month arrows) detaches its own node, the outside-click test sees it as
  // "outside," and the popover wrongly closes.
  panel.addEventListener('click', (e) => e.stopPropagation());
  const onDocClick = (e) => { if (!wrap.contains(e.target)) hide(); };
  // Escape closes the popover and stops there, so a picker living inside a modal
  // doesn't also close the modal.
  const onKey = (e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); hide(); } };
  function show() {
    if (open) return;
    open = true;
    panel.hidden = false;
    panel.style.left = ''; panel.style.right = '';
    const r = panel.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) { panel.style.left = 'auto'; panel.style.right = '0'; }
    setTimeout(() => { document.addEventListener('click', onDocClick); document.addEventListener('keydown', onKey, true); }, 0);
  }
  function hide() { if (!open) return; open = false; panel.hidden = true; document.removeEventListener('click', onDocClick); document.removeEventListener('keydown', onKey, true); }
  return { show, hide, toggle: () => (open ? hide() : show()), isOpen: () => open };
}

// Build a month calendar grid into `host`, highlighting [from,to] (single = one day).
// onDay(ds) fires on a day click; onHover(ds) previews while picking a range.
function renderMonth(host, viewDate, { from, to, pendingStart, onDay, onHover }) {
  const y = viewDate.getFullYear(), m = viewDate.getMonth();
  const startDow = new Date(y, m, 1).getDay(), daysIn = dim(y, m);
  const today = fmtD(new Date());
  let lo = pendingStart || from, hi = pendingStart || to;
  if (lo && hi && lo > hi) { const t = lo; lo = hi; hi = t; }
  const single = lo && lo === hi;
  const cells = [];
  for (const d of DOW) cells.push(el('div', { class: 'dpk-dow' }, d.slice(0, 2)));
  for (let i = 0; i < startDow; i++) cells.push(el('div', {}));
  for (let d = 1; d <= daysIn; d++) {
    const ds = fmt(y, m, d);
    const c = el('button', { type: 'button', class: 'dpk-day', 'data-date': ds }, String(d));
    if (ds === today) c.classList.add('today');
    if (single && ds === lo) c.classList.add('sel');
    else if (lo && hi && !single && ds >= lo && ds <= hi) { c.classList.add('dpk-range'); if (ds === lo) c.classList.add('dpk-rstart'); if (ds === hi) c.classList.add('dpk-rend'); }
    c.addEventListener('click', () => onDay(ds));
    if (onHover) c.addEventListener('mouseenter', () => onHover(ds));
    cells.push(c);
  }
  host.replaceChildren(el('div', { class: 'dpk-grid' }, ...cells));
}

// Calendar header (‹ Month YYYY ›) wired to step the view month.
function calHead(viewDate, nav) {
  return el('div', { class: 'dpk-cal-head' },
    el('button', { type: 'button', class: 'dpk-nav', onclick: () => nav(-1) }, '‹'),
    el('div', { class: 'dpk-month' }, `${MONTHS[viewDate.getMonth()]} ${viewDate.getFullYear()}`),
    el('button', { type: 'button', class: 'dpk-nav', onclick: () => nav(1) }, '›'));
}

// ── Range control (the default everywhere) ─────────────────────────────────
// onChange(range) fires whenever the selection changes. initial = a preset key.
export function dateRangeControl({ initial = 'year', onChange } = {}) {
  let range = presetRange(initial) || { from: null, to: null };
  let view = parseIso(range.to || range.from || fmtD(new Date()));
  let pendingStart = null;

  const label = el('span', { class: 'dpk-lbl' }, rangeLabel(range));
  const trigger = el('button', { type: 'button', class: 'dpk-btn' },
    el('span', { class: 'ms', style: 'font-size:16px' }, 'calendar_today'), label, el('span', { class: 'dpk-caret' }, '▾'));
  const prev = el('button', { type: 'button', class: 'dpk-step', title: 'Previous period' }, '‹');
  const next = el('button', { type: 'button', class: 'dpk-step', title: 'Next period' }, '›');
  const cal = el('div', { class: 'dpk-cal' });
  const rail = el('div', { class: 'dpk-rail' });
  const panel = el('div', { class: 'dpk-pop', hidden: true }, rail, cal);
  // The popover anchors to the trigger (inside dpk-anchor), NOT the whole control —
  // so the ‹ › steppers don't push the calendar sideways.
  const anchor = el('span', { class: 'dpk-anchor' }, trigger, panel);
  const wrap = el('span', { class: 'dpk' }, prev, anchor, next);
  const pop = makePopover(wrap, panel);

  const fire = () => { if (onChange) onChange({ ...range }); };
  const syncLabel = () => { label.textContent = rangeLabel(range); const bounded = !!(range.from && range.to); prev.disabled = !bounded; next.disabled = !bounded; };

  const drawCal = () => {
    cal.replaceChildren(calHead(view, (d) => { view = new Date(view.getFullYear(), view.getMonth() + d, 1); drawCal(); }),
      el('div', { class: 'dpk-grid-host' }));
    renderMonth(cal.querySelector('.dpk-grid-host'), view, {
      from: range.from, to: range.to, pendingStart,
      onDay: pickDay,
      onHover: pendingStart ? (ds) => renderMonth(cal.querySelector('.dpk-grid-host'), view, { from: pendingStart, to: ds, pendingStart: null, onDay: pickDay, onHover: null }) : null,
    });
  };
  const drawRail = () => {
    rail.replaceChildren(...PRESETS.map(([key, lbl]) => {
      const r = presetRange(key);
      const active = (r && r.from === range.from && r.to === range.to);
      return el('button', { type: 'button', class: 'dpk-preset' + (active ? ' active' : ''), onclick: () => { range = presetRange(key); pendingStart = null; view = parseIso(range.to || range.from || fmtD(new Date())); syncLabel(); pop.hide(); fire(); } }, lbl);
    }));
  };
  function pickDay(ds) {
    if (pendingStart == null) { pendingStart = ds; drawCal(); return; }
    const a = pendingStart; pendingStart = null;
    range = a <= ds ? { from: a, to: ds } : { from: ds, to: a };
    syncLabel(); pop.hide(); fire();
  }

  trigger.addEventListener('click', () => { if (!pop.isOpen()) { pendingStart = null; view = parseIso(range.to || range.from || fmtD(new Date())); drawRail(); drawCal(); } pop.toggle(); });
  prev.addEventListener('click', () => { range = shiftRange(range, -1); view = parseIso(range.to || fmtD(new Date())); syncLabel(); fire(); });
  next.addEventListener('click', () => { range = shiftRange(range, 1); view = parseIso(range.to || fmtD(new Date())); syncLabel(); fire(); });
  syncLabel();

  return {
    el: wrap,
    getRange: () => ({ ...range }),
    setRange: (r) => { range = { from: r.from || null, to: r.to || null }; view = parseIso(range.to || range.from || fmtD(new Date())); syncLabel(); },
    reset: () => { range = presetRange(initial) || { from: null, to: null }; pendingStart = null; view = parseIso(range.to || range.from || fmtD(new Date())); syncLabel(); fire(); },
  };
}

// ── Single-day control (as-of dates, statement end dates, etc.) ────────────
// onPick(iso) fires when a day is chosen. value = 'YYYY-MM-DD'.
const DAY_PRESETS = [['today', 'Today'], ['yesterday', 'Yesterday']];
function dayPresetDate(key) { const n = new Date(); if (key === 'yesterday') n.setDate(n.getDate() - 1); return fmtD(n); }

// opts.presets (optional): [{ label, date }] — overrides the default Today/Yesterday rail.
export function dateControl({ value = '', onPick, presets } = {}) {
  let val = value || fmtD(new Date());
  let view = parseIso(val);
  const railItems = Array.isArray(presets) && presets.length ? presets : DAY_PRESETS.map(([k, l]) => ({ label: l, date: dayPresetDate(k) }));

  const label = el('span', { class: 'dpk-lbl' }, longDay(val));
  const trigger = el('button', { type: 'button', class: 'dpk-btn' },
    el('span', { class: 'ms', style: 'font-size:16px' }, 'calendar_today'), label, el('span', { class: 'dpk-caret' }, '▾'));
  const cal = el('div', { class: 'dpk-cal' });
  const rail = el('div', { class: 'dpk-rail' });
  const panel = el('div', { class: 'dpk-pop', hidden: true }, rail, cal);
  const anchor = el('span', { class: 'dpk-anchor' }, trigger, panel);
  const wrap = el('span', { class: 'dpk' }, anchor);
  const pop = makePopover(wrap, panel);

  const syncLabel = () => { label.textContent = longDay(val); };
  const choose = (ds) => { val = ds; view = parseIso(ds); syncLabel(); pop.hide(); if (onPick) onPick(ds); };
  const drawCal = () => {
    cal.replaceChildren(calHead(view, (d) => { view = new Date(view.getFullYear(), view.getMonth() + d, 1); drawCal(); }),
      el('div', { class: 'dpk-grid-host' }));
    renderMonth(cal.querySelector('.dpk-grid-host'), view, { from: val, to: val, pendingStart: null, onDay: choose, onHover: null });
  };
  const drawRail = () => rail.replaceChildren(...railItems.map((p) =>
    el('button', { type: 'button', class: 'dpk-preset' + (p.date === val ? ' active' : ''), onclick: () => choose(p.date) }, p.label)));

  trigger.addEventListener('click', () => { if (!pop.isOpen()) { view = parseIso(val); drawRail(); drawCal(); } pop.toggle(); });

  return {
    el: wrap,
    getValue: () => val,
    setValue: (v) => { if (v) { val = v; view = parseIso(v); syncLabel(); } },
  };
}
