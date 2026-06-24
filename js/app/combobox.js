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
//   freeText:    keep whatever the user typed even when it matches no option (so a
//                caller can read `.inputText` as a proposed new name); never reverts.
//   emptyText:   the "no matches" line (default 'No matches')
import { el } from './ui.js';

export function combobox({ groups = [], value = '', text = '', placeholder = '— pick —', onAdd = null, onAddText = null, addLabel = 'Add…', minWidth = 190, freeText = false, emptyText = 'No matches' } = {}) {
  const flat = [];
  for (const g of groups) for (const it of g.items) flat.push(it);
  const labelFor = (v) => flat.find(x => x.value === v)?.label || '';
  const existsLabel = (t) => flat.some(x => (x.label || '').toLowerCase() === t.toLowerCase());

  let current = value || '';
  let pendingText = (!current && text) ? text : '';   // shown until the user picks/types (e.g. an AI-suggested name)
  let open = false;
  let suppressOpen = false;   // focusNoOpen(): focus the field once WITHOUT opening the panel
  let hl = -1;          // highlighted index into the currently-visible option list
  let visible = [];     // flat list of {value,label} currently shown (post-filter)

  const input = el('input', { class: 'field-input cbx-input', placeholder, autocomplete: 'off', spellcheck: 'false' });
  // The panel is portaled to <body> (position:fixed) while open, so it floats above the
  // scrolling list and any modal — opening it can never scroll/shift the page behind it.
  const panel = el('div', { class: 'cbx-panel', hidden: true });
  const wrap = el('div', { class: 'cbx', style: `min-width:${minWidth}px` }, input);
  let panelW = 0, panelH = 0;   // cached panel size (re-measured whenever the option list changes)
  let raf = 0;                  // requestAnimationFrame handle for the follow-the-field loop

  // Show the full chosen label on hover (title) and scroll the field to its END when
  // unfocused, so a long "Parent › Child" account reveals the CHILD you actually picked
  // (the meaningful part) instead of clipping it off the right edge.
  const setDisplay = () => {
    input.value = current ? labelFor(current) : pendingText;
    input.title = input.value;
    if (input.value) setTimeout(() => { if (document.activeElement !== input) input.scrollLeft = input.scrollWidth; }, 0);
  };
  setDisplay();

  // The live text in the box — lets a caller read a typed/prefilled name that isn't a
  // saved option yet (e.g. to find-or-create a vendor on approve).
  Object.defineProperty(wrap, 'inputText', { get: () => input.value.trim(), configurable: true });

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
    if (!visible.length && !onAdd) panel.append(el('div', { class: 'cbx-empty' }, emptyText));
    if (onAdd) {
      const add = el('div', { class: 'cbx-add' }, '＋ ' + addLabel);
      add.addEventListener('mousedown', (e) => { e.preventDefault(); closePanel(); onAdd(); });
      panel.append(add);
    }
    hl = visible.findIndex(it => it.value === current);
    if (open) { panelW = panel.offsetWidth; panelH = panel.offsetHeight; }   // re-measure for positioning
    paintHl();
  }

  function paintHl() {
    panel.querySelectorAll('.cbx-opt').forEach((o) => o.classList.toggle('hl', Number(o.dataset.i) === hl));
    const node = panel.querySelector(`.cbx-opt[data-i="${hl}"]`);
    // Keep the highlighted option visible by scrolling WITHIN the panel only — never
    // scrollIntoView (which would scroll the page behind and make the row jump).
    if (node) {
      if (node.offsetTop < panel.scrollTop) panel.scrollTop = node.offsetTop - 4;
      else if (node.offsetTop + node.offsetHeight > panel.scrollTop + panel.clientHeight) panel.scrollTop = node.offsetTop + node.offsetHeight - panel.clientHeight + 4;
    }
  }
  function setHl(i) { hl = i; paintHl(); }

  // Pin the floating panel to the input: below it when there's room, flipped above when
  // near the bottom, clamped into the viewport. Runs every frame while open so it follows
  // the field as the list scrolls, and closes itself if the field is re-rendered away.
  function position() {
    const r = input.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    let left = Math.min(r.left, Math.max(8, vw - 8 - panelW));
    if (left < 8) left = 8;
    const below = vh - r.bottom;
    const top = (below >= panelH + 6 || below >= r.top) ? r.bottom + 3 : Math.max(8, r.top - panelH - 3);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }
  function track() {
    if (!open) return;
    if (!input.isConnected) { closePanel(); return; }   // host re-rendered the row → close
    position();
    raf = requestAnimationFrame(track);
  }

  // While the panel is open, stop the PAGE from scrolling under it (touches inside the
  // panel still scroll its own list). `overscroll-behavior` alone isn't honored on older
  // iOS Safari — there the page would scroll together with the floating panel — so we
  // also block touch-scroll outside the panel directly.
  function blockBgScroll(e) {
    // A drag OUTSIDE the menu dismisses it and lets the sheet scroll. (The panel is
    // position:fixed and can't track the field during iOS momentum scroll — it would drift
    // past the input — so closing is cleaner than trying to follow.)
    if (!panel.contains(e.target)) { closePanel(); return; }
    // Inside a scrollable list, let it scroll itself; inside a SHORT list there's nothing to
    // scroll, so swallow it rather than letting the gesture drag the page out from under it.
    if (panel.scrollHeight > panel.clientHeight) return;
    e.preventDefault();
  }

  function openPanel() {
    if (open) return;
    open = true;
    document.body.appendChild(panel);
    panel.hidden = false;
    panel.style.minWidth = wrap.getBoundingClientRect().width + 'px';
    buildPanel('');
    position();
    input.select();
    document.addEventListener('touchmove', blockBgScroll, { passive: false });
    raf = requestAnimationFrame(track);
  }
  function closePanel() {
    open = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    document.removeEventListener('touchmove', blockBgScroll, { passive: false });
    panel.hidden = true;
    panel.remove();   // un-portal from <body>
    // freeText: whatever is typed at close time IS the value. If it differs from the
    // current selection it's a CHANGE — to an existing option if it matches one exactly,
    // otherwise a proposed NEW entry (drop the old pick so it isn't snapped back, and keep
    // the typed text — read via .inputText). Empty / unchanged falls through to setDisplay.
    if (freeText) {
      const t = input.value.trim();
      if (t && t.toLowerCase() !== (labelFor(current) || '').toLowerCase()) {
        const exact = flat.find(x => (x.label || '').toLowerCase() === t.toLowerCase());
        if (exact) { current = exact.value; fireChange(); setDisplay(); return; }
        if (current) { current = ''; fireChange(); }
        input.title = input.value;   // proposed new — leave the typed text in place
        return;
      }
    }
    setDisplay();
  }
  function pick(v) {
    const changed = v !== current;
    current = v;
    pendingText = '';
    closePanel();
    if (changed) fireChange();
  }

  input.addEventListener('focus', () => { if (suppressOpen) { suppressOpen = false; return; } openPanel(); });
  input.addEventListener('click', openPanel);
  input.addEventListener('input', () => { pendingText = ''; if (!open) openPanel(); buildPanel(input.value); });
  // The typed text doesn't match any option AND isn't the current selection → it's a
  // candidate to create. Returns the trimmed text, or '' when there's nothing to add.
  const newTyped = () => {
    const t = input.value.trim();
    return (t && onAddText && !existsLabel(t) && t.toLowerCase() !== (labelFor(current) || '').toLowerCase()) ? t : '';
  };
  // Emptying the box and committing (blur / Enter / Tab) clears the selection back to
  // blank — the natural way to "erase" a pick. Only when the input is actually empty,
  // so opening a field (which selects its text) can't clear it by accident.
  const isEmpty = () => !input.value.trim();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) return openPanel(); setHl(Math.min(hl + 1, visible.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHl(Math.max(hl - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (isEmpty() && current) pick('');
      else if (open && hl >= 0 && visible[hl]) pick(visible[hl].value);
      else { const t = newTyped(); if (t) { closePanel(); onAddText(t); } else closePanel(); }
    }
    else if (e.key === 'Escape') { if (open) { e.stopPropagation(); closePanel(); input.blur(); } }
    else if (e.key === 'Tab') {
      // Tab on a highlighted option SELECTS it and moves to the next field (no
      // preventDefault). Tab on a typed-but-unknown name offers to add it.
      if (isEmpty() && current) pick('');
      else if (open && hl >= 0 && visible[hl]) { pick(visible[hl].value); }
      else { const t = newTyped(); if (t) { e.preventDefault(); closePanel(); onAddText(t); } else closePanel(); }
    }
  });
  input.addEventListener('blur', () => { setTimeout(() => {
    if (!open) return;
    if (isEmpty() && current) pick('');   // emptied the box and clicked away → clear the selection
    else closePanel();
  }, 120); });

  // Replace the option set in place (e.g. after a "＋ Add…" creates a new option,
  // when the host view isn't going to re-render the control for us).
  wrap.setGroups = (g) => {
    groups = g || [];
    flat.length = 0;
    for (const gr of groups) for (const it of gr.items) flat.push(it);
    setDisplay();
    if (open) buildPanel(input.value);
  };

  // Focus the field WITHOUT opening the panel — used right after an inline "＋ Add…"
  // so the freshly-picked value lands and the user can Tab straight to the next field
  // (hands stay on the keyboard) instead of the panel popping open again. The timeout
  // clears the one-shot flag so it can never leak into a later focus if (in a background
  // tab) the focus event didn't fire synchronously to consume it.
  wrap.focusNoOpen = () => { suppressOpen = true; input.focus(); setTimeout(() => { suppressOpen = false; }, 0); };

  return wrap;
}
