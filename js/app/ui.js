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

export function modal(title) {
  const body = el('div');
  const overlay = el('div', { class: 'overlay on' },
    el('div', { class: 'modal' },
      el('div', { class: 'mhead' },
        el('b', {}, title),
        el('span', { class: 'ms mclose' }, 'close')),
      body));
  const close = () => overlay.remove();
  // Backdrop-click-to-close, but ONLY when the press also STARTED on the backdrop.
  // Otherwise selecting text inside a field and releasing the mouse over the backdrop
  // (a fast drag) registers as a backdrop click and wrongly dismisses the modal.
  let downOnOverlay = false;
  overlay.addEventListener('pointerdown', (e) => { downOnOverlay = e.target === overlay; });
  overlay.addEventListener('click', (e) => { if (e.target === overlay && downOnOverlay) close(); });
  overlay.querySelector('.mclose').addEventListener('click', close);
  document.body.append(overlay);
  return { body, close };
}

// Money is integer cents everywhere in stored data; format only at the edge.
export function fmtMoney(cents, { sign = false } = {}) {
  const n = Math.abs(cents) / 100;
  const s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (cents < 0) return `−$${s}`;
  return (sign ? '+' : '') + `$${s}`;
}
