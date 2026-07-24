// ── ui — tiny DOM helpers (no framework, no window glue) ────────────────

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  return appendKids(node, ...children);   // one source of truth for nullish-child skipping (below)
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

// Append children to a real DOM node, skipping nullish ones — mirrors el()'s child handling.
// Native Node.append(x) coerces a null/undefined argument to the text node "null"/"undefined", so
// `node.append(cond ? child : null)` renders a stray "null". Route such appends through this instead.
export function appendKids(node, ...children) {
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

// ── Sortable tables ────────────────────────────────────────────────────────────
// Shared so every data table sorts the same way: a clickable <th> that toggles
// asc/desc (text columns default A→Z, numeric default high→low), plus sortBy() to
// order the rows. `state` is a plain { key, dir } the caller keeps; onSort re-renders.
//   const st = { key: 'name', dir: 'asc' };
//   sortTh(st, 'name', 'Vendor', redraw)            // text column
//   sortTh(st, 'total', 'Total', redraw, { numeric: true, cls: 'num' })
//   const sorted = sortBy(rows, st, { name: r => r.name, total: r => r.total });
export function sortTh(state, key, label, onSort, { numeric = false, cls = '' } = {}) {
  const active = state.key === key;
  const caret = active ? (state.dir === 'desc' ? ' ▼' : ' ▲') : '';
  return el('th', { class: (cls ? cls + ' ' : '') + 'th-sort' + (active ? ' on' : ''), title: 'Click to sort',
    onclick: () => {
      if (state.key === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
      else { state.key = key; state.dir = numeric ? 'desc' : 'asc'; }
      onSort();
    } }, label + caret);
}

// Order rows by the current sort state. `getters` maps each sort key to a value
// function; numbers sort numerically, everything else case-insensitively by text.
export function sortBy(rows, state, getters) {
  const get = getters[state.key];
  if (!get) return rows.slice();
  const d = state.dir === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const va = get(a), vb = get(b);
    const c = (typeof va === 'number' && typeof vb === 'number')
      ? va - vb
      : String(va == null ? '' : va).toLowerCase().localeCompare(String(vb == null ? '' : vb).toLowerCase());
    return d * c;
  });
}

export function toast(msg, kind = 'ok') {
  const t = el('div', { class: `toast ${kind}` }, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add('on'), 10);
  setTimeout(() => { t.classList.remove('on'); setTimeout(() => t.remove(), 300); }, 2600);
}

export function modal(title, onClose) {
  const body = el('div');
  const panel = el('div', { class: 'modal' },
    el('div', { class: 'mhead' },
      el('b', {}, title),
      el('span', { class: 'ms mclose' }, 'close')),
    body);
  const overlay = el('div', { class: 'overlay on' }, panel);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  // Esc closes the TOP-most open modal (so nested dialogs close one at a time).
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    const all = document.querySelectorAll('.overlay');
    if (all.length && all[all.length - 1] === overlay) { e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey);
  // Backdrop-click-to-close, but ONLY when the press also STARTED on the backdrop.
  // Otherwise selecting text inside a field and releasing the mouse over the backdrop
  // (a fast drag) registers as a backdrop click and wrongly dismisses the modal.
  let downOnOverlay = false;
  overlay.addEventListener('pointerdown', (e) => { downOnOverlay = e.target === overlay; });
  overlay.addEventListener('click', (e) => { if (e.target === overlay && downOnOverlay) close(); });
  panel.querySelector('.mclose').addEventListener('click', close);
  // Drag the dialog by its title bar (like a file-explorer window) so the user can
  // move it aside, and drag the right edge to widen a cramped dialog. Both write the
  // same transform offset so moving and resizing stay in sync.
  const offset = { tx: 0, ty: 0 };
  makeDraggable(panel, panel.querySelector('.mhead'), offset);
  makeResizable(panel, offset);
  document.body.append(overlay);
  return { body, close };
}

const applyOffset = (panel, s) => { panel.style.transform = `translate(${s.tx}px, ${s.ty}px)`; };

// Make `panel` draggable by `handle` (its title bar). Uses a CSS transform offset
// relative to the panel's centered position, clamped so the title bar can never be
// dragged fully off-screen (you can always grab it again or reach the close button).
function makeDraggable(panel, handle, s) {
  let lastX = 0, lastY = 0, baseTop = 0, baseLeft = 0, pw = 0, dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.mclose')) return; // let the close button work
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    const r = panel.getBoundingClientRect();
    baseTop = r.top - s.ty; baseLeft = r.left - s.tx; pw = r.width;
    try { handle.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    s.tx += e.clientX - lastX; s.ty += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    s.ty = Math.max(-baseTop, Math.min(window.innerHeight - 44 - baseTop, s.ty));
    s.tx = Math.max(60 - baseLeft - pw, Math.min(window.innerWidth - 60 - baseLeft, s.tx));
    applyOffset(panel, s);
  });
  const end = (e) => { if (dragging) { dragging = false; try { handle.releasePointerCapture(e.pointerId); } catch {} } };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// Drag the right edge to change the dialog's width. The panel is flex-centered, so
// growing it by dW shifts its centered position by −dW/2 — compensate the transform by
// +dW/2 to keep the LEFT edge planted under the cursor's edge. Width is border-box.
function makeResizable(panel, s) {
  const grip = el('div', { class: 'mrz-e', title: 'Drag to make this window wider or narrower' });
  panel.append(grip);
  let resizing = false, lastX = 0;
  grip.addEventListener('pointerdown', (e) => {
    resizing = true; lastX = e.clientX; panel.style.maxWidth = 'none';
    try { grip.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault(); e.stopPropagation();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const cur = panel.getBoundingClientRect().width;
    const w = Math.max(360, Math.min(window.innerWidth - 24, cur + (e.clientX - lastX)));
    lastX = e.clientX;
    panel.style.width = w + 'px';
    s.tx += (w - cur) / 2;
    applyOffset(panel, s);
  });
  const end = (e) => { if (resizing) { resizing = false; try { grip.releasePointerCapture(e.pointerId); } catch {} } };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}

// Money is integer cents everywhere in stored data; format only at the edge.
export function fmtMoney(cents, { sign = false } = {}) {
  const n = Math.abs(cents) / 100;
  const s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (cents < 0) return `−$${s}`;
  return (sign ? '+' : '') + `$${s}`;
}

// Bank descriptions arrive SHOUTING in all-caps. Show them in Title Case for readability
// WITHOUT touching stored data (dedup + auto-categorize rules still match the raw text).
// Guards: leave strings that already have lowercase (manual / already-clean) untouched;
// leave any token containing a digit (ids, dates, phone/trace numbers) as-is; keep short
// tokens (≤2 letters: state codes like CA/NY) and known acronyms uppercase.
const DESC_KEEP = new Set(['ACH', 'ATM', 'POS', 'INC', 'LLC', 'LLP', 'SEC', 'USA', 'EFT', 'DBA', 'PPD', 'CCD', 'WEB', 'IVR', 'PMT', 'ID']);
export function prettyDesc(s) {
  if (!s || /[a-z]/.test(s)) return s || '';
  // Title-case each run of capitals; digits/separators stay put. Short runs (state codes
  // like CA/NY) and known acronyms keep their caps.
  return s.replace(/[A-Z]+/g, (run) => {
    if (run.length <= 2 || DESC_KEEP.has(run)) return run;
    return run.charAt(0) + run.slice(1).toLowerCase();
  });
}

// Accounting-style amount for table columns: the $ sits at the LEFT of the cell and the
// figures align RIGHT (so decimals line up down the column). Negatives use a minus sign.
// `colored` toggles the red/green (per-tab choice); pass false for plain ink.
export function acctAmount(cents, { colored = true, sign = false } = {}) {
  const s = (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = cents < 0 ? `−${s}` : (sign && cents > 0 ? `+${s}` : s);
  const tone = colored ? (cents < 0 ? ' neg' : cents > 0 ? ' pos' : '') : '';
  return el('span', { class: 'acctamt' + tone },
    el('span', { class: 'acctcur' }, '$'),
    el('span', {}, num));
}
