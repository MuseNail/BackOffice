// ── view: dashboard ────────────────
import { el } from '../ui.js';
import { getState, subscribe } from '../store.js';
import { getActiveBiz } from '../session.js';

let unsub = null;

export function render(root) {
  const body = el('div');
  const draw = () => {
    const s = getState();
    body.replaceChildren(
      el('h2', {}, s.meta?.name || getActiveBiz()),
      el('p', { class: 'sub' }, `Live and syncing — mutation #${s.seq}. The real dashboard arrives with the ledger (M4+).`),
      el('div', { class: 'card' },
        el('div', { class: 'cardtitle' }, 'Connected'),
        el('p', {}, `Entities loaded: ${Object.entries(s.entities).map(([k, v]) => `${k} ${v.length}`).join(' · ') || 'none yet'}`)),
    );
  };
  unsub = subscribe(draw);
  draw();
  root.append(body);
}

export function unmount() { unsub?.(); unsub = null; }
