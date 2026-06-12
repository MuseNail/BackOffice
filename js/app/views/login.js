// ── view: login ────────────────
// M0 bootstrap: paste the shared AUTH_TOKEN. M2 replaces this screen with
// identifier + PIN + device enrollment (kickoff 3b).
import { el } from '../ui.js';
import { setToken } from '../session.js';
import { api } from '../sync.js';

export function render(root) {
  const input = el('input', { type: 'password', placeholder: 'Paste access token', class: 'login-input' });
  const err = el('div', { class: 'login-err' });
  const form = el('form', { class: 'login-card', onsubmit: async (e) => {
    e.preventDefault();
    setToken(input.value.trim());
    try {
      const res = await api('/registry/businesses');
      if (!res.ok) throw new Error();
      location.hash = '#/businesses';
    } catch {
      setToken('');
      err.textContent = 'That token didn’t work.';
    }
  } },
    el('div', { class: 'login-logo' }, 'Back Office'),
    el('p', { class: 'login-sub' }, 'Multi-business books — sign in to continue.'),
    input, err,
    el('button', { class: 'btn', type: 'submit' }, 'Sign in'),
  );
  root.append(el('div', { class: 'login-wrap' }, form));
  input.focus();
}

export function unmount() {}
