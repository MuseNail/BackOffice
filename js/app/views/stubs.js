// ── view factory: placeholder screens until their milestone lands ────────────────
import { el } from '../ui.js';

export function stub(title, note) {
  return {
    render(root) {
      root.append(
        el('h2', {}, title),
        el('div', { class: 'card' },
          el('div', { class: 'cardtitle' }, 'Coming soon'),
          el('p', { class: 'sub' }, note)),
      );
    },
    unmount() {},
  };
}
