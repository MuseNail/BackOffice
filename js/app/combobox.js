// ── combobox — type-to-search replacement for a <select> ───────────────────────
// Returns a wrapper ELEMENT that quacks like a <select>: it has a `.value`
// property (get/set) and fires a 'change' Event when the selection changes, so
// existing call sites that read `el.value` or `el.addEventListener('change', …)`
// keep working. Adds an editable text box that filters the options as you type,
// arrow-key navigation, Enter to pick, Escape to revert.
//
// opts:
//   groups:      [{ label, items: [{ value, label }] }]   (label '' = no header)
//   value:       initial selected value
//   placeholder: shown when nothing is selected
//   onAdd:       optional () => void — renders a pinned "＋ <addLabel>" action
//   onAddText:   optional (typedText) => void — when you Tab/Enter on a name that
//                isn't in the list, this fires with what you typed (e.g. to confirm
//                creating it) instead of silently reverting.
//   addLabel:    text for that action (default 'Add…')
//   minWidth:    px for the control
import { el } from './ui.js';

export function combobox({ groups = [], value = '', placeholder = '— pick —', onAdd = null, onAddText = null, addLabel = 'Add…', minWidth = 190 } = {}) {
  const flat = [];
  for (const g of groups) for (const it of g.items) flat.push(it);
  const labelFor = (v) => flat.find(x => x.value === v)?.label || '';
  const existsLabel = (t) => flat.some(x => (x.label || '').toLowerCase() === t.toLowerCase());

  let current = value || '';
  let open = false;
  let hl = -1;          // highlighted index into the currently-visible option list
  let visible = [];     // flat list of {value,label} currently shown (post-filter)

  const input = el('input', { class: 'field-input cbx-input', placeholder, autocomplete: 'off', spellcheck: 'false' });
  const panel = el('div', { class: 'cbx-panel', hidden: true });
  const wrap = el('div', { class: 'cbx', style: `min-width:${minWidth}px` }, input, panel);

  const setDisplay = () => { input.value = current ? labelFor(current) : ''; };
  setDisplay();

  const fireChange = () => wrap.dispatchEvent(new Event('change'));

  // `.value` is the public contract — reads/writes the selection like a <select>.
  Object.defineProperty(wrap, 'value', {
    get: () => current,
    set: (v) => { current = v || ''; setDisplay(); },
    configurable: true,
  });

  function buildPanel(filter) {
    panel.replaceChildren();
    visible = [];
    const q = (filter || '').trim().toLowerCase();
    for (const g of groups) {
      const matches = g.items.filter(it => !q || it.label.toLowerCase().includes(q));
      if (!matches.length) continue;
      if (g.label) panel.append(el('div', { class: 'cbx-group' }, g.label));
      for (const it of matches) {
        const idx = visible.length;
        visible.push(it);
        const opt = el('div', { class: 'cbx-opt' + (it.value === current ? ' sel' : ''), 'data-i': String(idx) }, it.label);
        opt.addEventListener('mousedown', (e) => { e.preventDefault(); pick(it.value); });
        opt.addEventListener('mousemove', () => setHl(idx));
        panel.append(opt);
      }
    }
    if (!visible.length && !onAdd) panel.append(el('div', { class: 'cbx-empty' }, 'No matches'));
    if (onAdd) {
      const add = el('div', { class: 'cbx-add' }, '＋ ' + addLabel);
      add.addEventListener('mousedown', (e) => { e.preventDefault(); closePanel(); onAdd(); });
      panel.append(add);
    }
    hl = visible.findIndex(it => it.value === current);
    paintHl();
  }

  function paintHl() {
    panel.querySelectorAll('.cbx-opt').forEach((o) => o.classList.toggle('hl', Number(o.dataset.i) === hl));
    const node = panel.querySelector(`.cbx-opt[data-i="${hl}"]`);
    if (node) node.scrollIntoView({ block: 'nearest' });
  }
  function setHl(i) { hl = i; paintHl(); }

  function openPanel() {
    if (open) return;
    open = true;
    buildPanel('');
    panel.hidden = false;
    input.select();
  }
  function closePanel() {
    open = false;
    panel.hidden = true;
    setDisplay();   // revert any half-typed filter text to the real selection
  }
  function pick(v) {
    const changed = v !== current;
    current = v;
    closePanel();
    if (changed) fireChange();
  }

  input.addEventListener('focus', openPanel);
  input.addEventListener('click', openPanel);
  input.addEventListener('input', () => { if (!open) openPanel(); buildPanel(input.value); });
  // The typed text doesn't match any option AND isn't the current selection → it's a
  // candidate to create. Returns the trimmed text, or '' when there's nothing to add.
  const newTyped = () => {
    const t = input.value.trim();
    return (t && onAddText && !existsLabel(t) && t.toLowerCase() !== (labelFor(current) || '').toLowerCase()) ? t : '';
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) return openPanel(); setHl(Math.min(hl + 1, visible.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHl(Math.max(hl - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && hl >= 0 && visible[hl]) pick(visible[hl].value);
      else { const t = newTyped(); if (t) { closePanel(); onAddText(t); } else closePanel(); }
    }
    else if (e.key === 'Escape') { if (open) { e.stopPropagation(); closePanel(); input.blur(); } }
    else if (e.key === 'Tab') {
      // Tab on a highlighted option SELECTS it and moves to the next field (no
      // preventDefault). Tab on a typed-but-unknown name offers to add it.
      if (open && hl >= 0 && visible[hl]) { pick(visible[hl].value); }
      else { const t = newTyped(); if (t) { e.preventDefault(); closePanel(); onAddText(t); } else closePanel(); }
    }
  });
  input.addEventListener('blur', () => { setTimeout(() => { if (open) closePanel(); }, 120); });

  // Replace the option set in place (e.g. after a "＋ Add…" creates a new option,
  // when the host view isn't going to re-render the control for us).
  wrap.setGroups = (g) => {
    groups = g || [];
    flat.length = 0;
    for (const gr of groups) for (const it of gr.items) flat.push(it);
    setDisplay();
    if (open) buildPanel(input.value);
  };

  return wrap;
}
