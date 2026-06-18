// ── windows — QuickBooks-style MDI workspace ───────────────────────────────────
// Each business tab opens as a draggable / resizable floating window inside a
// workspace area, with minimize / maximize-restore / close (like OS windows) and
// a taskbar of open windows. Views are SINGLETONS (one module-level subscription
// each), so the model is one window per view — re-opening a tab focuses its window.
import { el } from './ui.js';

let host = null;        // the #view element
let workspace = null;   // the floating-window area
let taskbar = null;     // strip listing open windows
let resolver = null;    // (name) -> { view, title, icon }
let onFocusCb = null;
let z = 10;
let cascade = 0;
const wins = new Map(); // name -> window state

export function setResolver(fn) { resolver = fn; }
export function setOnFocus(fn) { onFocusCb = fn; }
export function isActive() { return !!(workspace && workspace.isConnected); }

// Build the workspace + taskbar inside `root` (idempotent).
export function create(root) {
  host = root;
  if (workspace && workspace.isConnected) return;
  workspace = el('div', { class: 'mdi-workspace' }, el('div', { class: 'mdi-empty' }, 'Pick a tab from the menu to open a window.'));
  taskbar = el('div', { class: 'mdi-taskbar' }, el('span', { class: 'mdi-taskbar-lbl' }, 'Open windows:'));
  host.append(workspace, taskbar);
}

// Tear the whole workspace down (used when leaving business context / logout).
export function destroy() {
  closeAll();
  workspace?.remove(); taskbar?.remove();
  workspace = taskbar = host = null;
  cascade = 0;
}

export function closeAll() {
  for (const w of wins.values()) { try { w.view?.unmount?.(); } catch { /* ignore */ } w.el.remove(); }
  wins.clear();
  renderTaskbar(); updateEmpty();
}

// Open (or focus) the window for a view. `detail` = a drill-down/new-modal token
// the view reads on render; a changed detail re-renders the already-open window.
export function openView(name, detail) {
  let w = wins.get(name);
  if (w) {
    if (w.min) restore(w);
    focus(w);
    if (detail != null && detail !== w.detail) renderBody(w, detail);
    return;
  }
  const meta = resolver?.(name);
  if (!meta || !meta.view) return;
  w = makeWindow(name, detail, meta);
  wins.set(name, w);
  renderBody(w, detail);
  focus(w);
  renderTaskbar(); updateEmpty();
}

function makeWindow(name, detail, meta) {
  const W = workspace.clientWidth || 900, H = workspace.clientHeight || 560;
  const w = Math.min(980, Math.max(360, W - 40));
  const h = Math.min(600, Math.max(260, H - 56));
  const off = (cascade++ % 6) * 28;
  let x = Math.min(16 + off, Math.max(0, W - w));
  let y = Math.min(12 + off, Math.max(0, H - h));

  const body = el('div', { class: 'mdi-body' });
  const ticon = el('span', { class: 'ms mdi-ticon' }, meta.icon || 'tab');
  const title = el('span', { class: 'mdi-title' }, meta.title || name);
  const bMin = winBtn('remove', 'Minimize');
  const bMax = winBtn('crop_square', 'Maximize');
  const bClose = winBtn('close', 'Close');
  const bar = el('div', { class: 'mdi-bar' }, ticon, title, el('span', { class: 'mdi-spacer' }), bMin, bMax, bClose);
  const grip = el('div', { class: 'mdi-resize', title: 'Resize' });
  const node = el('div', { class: 'mdi-win', style: `left:${x}px;top:${y}px;width:${w}px;height:${h}px` }, bar, body, grip);

  const state = { name, detail, el: node, body, bar, bMax, view: meta.view, title: meta.title || name, icon: meta.icon || 'tab', max: false, min: false, prev: null };
  node.addEventListener('pointerdown', () => focus(state), true);
  bMin.addEventListener('click', (e) => { e.stopPropagation(); minimize(state); });
  bMax.addEventListener('click', (e) => { e.stopPropagation(); toggleMax(state); });
  bClose.addEventListener('click', (e) => { e.stopPropagation(); closeWin(state); });
  bar.addEventListener('dblclick', (e) => { if (!e.target.closest('.mdi-btn')) toggleMax(state); });
  makeDrag(state, bar);
  makeResize(state, grip);
  workspace.append(node);
  return state;
}

function renderBody(w, detail) {
  if (w.detail !== undefined && w.detail !== detail) { try { w.view?.unmount?.(); } catch { /* ignore */ } }
  w.detail = detail;
  w.body.replaceChildren();
  try {
    w.view.render(w.body, detail);
  } catch (e) {
    console.error('[window] render error', w.name, e);
    const pre = el('pre', { style: 'white-space:pre-wrap;font-size:12px;margin:8px 0 0' }, e?.stack || e?.message || String(e));
    w.body.append(el('div', { style: 'margin:20px;padding:16px;background:#fbe9e9;border:2px solid #c43a3a;border-radius:12px;font-family:monospace' },
      el('b', { style: 'color:#c43a3a' }, 'View render error'), pre));
  }
}

function focus(w) {
  if (w.min) return;
  w.el.style.zIndex = ++z;
  for (const o of wins.values()) o.el.classList.toggle('focused', o === w);
  onFocusCb?.(w.name);
}
function focusTop() {
  let top = null;
  for (const o of wins.values()) if (!o.min && (!top || +o.el.style.zIndex > +top.el.style.zIndex)) top = o;
  if (top) focus(top);
}
function minimize(w) { w.min = true; w.el.style.display = 'none'; renderTaskbar(); focusTop(); }
function restore(w) { w.min = false; w.el.style.display = ''; renderTaskbar(); }
function closeWin(w) { try { w.view?.unmount?.(); } catch { /* ignore */ } w.el.remove(); wins.delete(w.name); renderTaskbar(); updateEmpty(); focusTop(); }

function toggleMax(w) {
  if (w.max) {
    const p = w.prev;
    if (p) { w.el.style.left = p.x + 'px'; w.el.style.top = p.y + 'px'; w.el.style.width = p.w + 'px'; w.el.style.height = p.h + 'px'; }
    w.el.classList.remove('maxd'); w.max = false; setMaxIcon(w, 'crop_square');
  } else {
    w.prev = { x: w.el.offsetLeft, y: w.el.offsetTop, w: w.el.offsetWidth, h: w.el.offsetHeight };
    w.el.style.left = '0'; w.el.style.top = '0'; w.el.style.width = '100%'; w.el.style.height = '100%';
    w.el.classList.add('maxd'); w.max = true; setMaxIcon(w, 'filter_none');
  }
  focus(w);
}
function setMaxIcon(w, icon) { const ms = w.bMax.querySelector('.ms'); if (ms) ms.textContent = icon; }

function makeDrag(w, handle) {
  let sx, sy, ox, oy, on = false;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.mdi-btn')) return;
    on = true;
    if (w.max) {
      // un-maximize and keep dragging under the cursor (OS behavior)
      const ratio = w.el.offsetWidth ? (e.clientX - w.el.getBoundingClientRect().left) / w.el.offsetWidth : 0.5;
      toggleMax(w);
      const nw = w.el.offsetWidth;
      w.el.style.left = Math.max(0, e.clientX - workspace.getBoundingClientRect().left - nw * ratio) + 'px';
      w.el.style.top = '0px';
    }
    sx = e.clientX; sy = e.clientY; ox = w.el.offsetLeft; oy = w.el.offsetTop;
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!on) return;
    const W = workspace.clientWidth, H = workspace.clientHeight;
    const nx = Math.max(0, Math.min(W - 60, ox + e.clientX - sx));
    const ny = Math.max(0, Math.min(H - 32, oy + e.clientY - sy));
    w.el.style.left = nx + 'px'; w.el.style.top = ny + 'px';
  });
  const end = (e) => { if (on) { on = false; try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ } } };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function makeResize(w, grip) {
  let sx, sy, ow, oh, on = false;
  grip.addEventListener('pointerdown', (e) => {
    if (w.max) return;
    on = true; sx = e.clientX; sy = e.clientY; ow = w.el.offsetWidth; oh = w.el.offsetHeight;
    try { grip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault(); e.stopPropagation();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!on) return;
    const W = workspace.clientWidth, H = workspace.clientHeight;
    const nw = Math.max(300, Math.min(W - w.el.offsetLeft, ow + e.clientX - sx));
    const nh = Math.max(200, Math.min(H - w.el.offsetTop, oh + e.clientY - sy));
    w.el.style.width = nw + 'px'; w.el.style.height = nh + 'px';
  });
  const end = (e) => { if (on) { on = false; try { grip.releasePointerCapture(e.pointerId); } catch { /* ignore */ } } };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}

function renderTaskbar() {
  if (!taskbar) return;
  [...taskbar.querySelectorAll('.mdi-chip')].forEach((c) => c.remove());
  for (const w of wins.values()) {
    const chip = el('button', { class: 'mdi-chip' + (w.min ? ' min' : ''), type: 'button', title: w.title },
      el('span', { class: 'ms' }, w.icon), el('span', {}, w.title));
    chip.addEventListener('click', () => { if (w.min) restore(w); focus(w); });
    taskbar.append(chip);
  }
}
function updateEmpty() {
  const hint = workspace?.querySelector('.mdi-empty');
  if (hint) hint.style.display = wins.size ? 'none' : '';
}
function winBtn(icon, label) {
  return el('button', { class: 'mdi-btn', type: 'button', 'aria-label': label, title: label }, el('span', { class: 'ms' }, icon));
}
