// ── ui — tiny DOM helpers (no framework, no window glue) ────────────────

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

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
  // move it aside and see what's behind it.
  makeDraggable(panel, panel.querySelector('.mhead'));
  document.body.append(overlay);
  return { body, close };
}

// Make `panel` draggable by `handle` (its title bar). Uses a CSS transform offset
// relative to the panel's centered position, clamped so the title bar can never be
// dragged fully off-screen (you can always grab it again or reach the close button).
function makeDraggable(panel, handle) {
  let tx = 0, ty = 0, lastX = 0, lastY = 0, baseTop = 0, baseLeft = 0, pw = 0, dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.mclose')) return; // let the close button work
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    const r = panel.getBoundingClientRect();
    baseTop = r.top - ty; baseLeft = r.left - tx; pw = r.width;
    try { handle.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    tx += e.clientX - lastX; ty += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    ty = Math.max(-baseTop, Math.min(window.innerHeight - 44 - baseTop, ty));
    tx = Math.max(60 - baseLeft - pw, Math.min(window.innerWidth - 60 - baseLeft, tx));
    panel.style.transform = `translate(${tx}px, ${ty}px)`;
  });
  const end = (e) => { if (dragging) { dragging = false; try { handle.releasePointerCapture(e.pointerId); } catch {} } };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// Money is integer cents everywhere in stored data; format only at the edge.
export function fmtMoney(cents, { sign = false } = {}) {
  const n = Math.abs(cents) / 100;
  const s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (cents < 0) return `−$${s}`;
  return (sign ? '+' : '') + `$${s}`;
}
