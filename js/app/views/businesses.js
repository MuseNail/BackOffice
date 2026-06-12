// ── view: businesses — selector + create ────────────────
// From M2 the server only returns businesses the signed-in user belongs to
// (kickoff 3b) — this view renders whatever the session is allowed to see.
import { el, clear, toast } from '../ui.js';
import { api } from '../sync.js';

export function render(root) {
  const list = el('div');
  root.append(
    el('h2', {}, 'Your businesses'),
    el('p', { class: 'sub' }, 'Each business keeps its own books, users, and settings — completely separate.'),
    list,
    createForm(list),
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
          el('div', { class: 'sub' }, b.industry)),
      ));
    }
  } catch {
    clear(list).append(el('p', { class: 'sub' }, 'Could not load businesses — check the connection.'));
  }
}

function createForm(list) {
  const name = el('input', { placeholder: 'Business name', class: 'field-input' });
  const industry = el('select', { class: 'field-input' },
    ...['salon-spa', 'retail', 'restaurant', 'rental', 'services', 'general'].map(i => el('option', { value: i }, i)));
  return el('form', { class: 'card createform', onsubmit: async (e) => {
    e.preventDefault();
    const id = name.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!id) return;
    const res = await api('/registry/businesses', {
      method: 'POST',
      body: JSON.stringify({ id, name: name.value.trim(), industry: industry.value, createdAt: Date.now() }),
    });
    if (res.ok) { toast('Business created'); name.value = ''; load(list); }
    else toast((await res.json()).error || 'Could not create', 'err');
  } },
    el('div', { class: 'cardtitle' }, 'New business'),
    name, industry,
    el('button', { class: 'btn', type: 'submit' }, 'Create'),
  );
}

export function unmount() {}
