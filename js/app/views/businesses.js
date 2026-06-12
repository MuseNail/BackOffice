// ── view: businesses — selector + create ────────────────
// From M2 the server only returns businesses the signed-in user belongs to
// (kickoff 3b) — this view renders whatever the session is allowed to see.
import { el, clear } from '../ui.js';
import { api } from '../sync.js';
import { industryLabel } from '../lib/coa-templates.js';

export function render(root) {
  const list = el('div');
  root.append(
    el('h2', {}, 'Your businesses'),
    el('p', { class: 'sub' }, 'Each business keeps its own books, users, and settings — completely separate.'),
    list,
    el('button', { class: 'btn', onclick: () => { location.hash = '#/setup'; } }, 'New business'),
  );
  load(list);
}

async function load(list) {
  clear(list).append(el('p', { class: 'sub' }, 'Loading…'));
  try {
    const res = await api('/registry/businesses');
    const { businesses } = await res.json();
    clear(list);
    if (!businesses.length) list.append(el('p', { class: 'sub' }, 'No businesses yet — create the first one below.'));
    for (const b of businesses) {
      list.append(el('div', { class: 'bizcard', onclick: () => { location.hash = `#/b/${b.id}/dashboard`; } },
        el('div', { class: 'bizicon' }, '\u{1F3E2}'),
        el('div', { class: 'bizmeta' },
          el('div', { class: 'bizname' }, b.name),
          el('div', { class: 'sub' }, industryLabel(b.industry))),
      ));
    }
  } catch {
    clear(list).append(el('p', { class: 'sub' }, 'Could not load businesses — check the connection.'));
  }
}

export function unmount() {}
