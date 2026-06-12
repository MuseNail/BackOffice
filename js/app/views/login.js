// ── view: login — PIN sign-in + first-run owner bootstrap ────────────────
// GET /auth/status decides which form renders. Device enrollment and rate
// limiting live server-side (registry); this view just explains the errors.
import { el, clear } from '../ui.js';
import { ORIGIN } from '../config.js';
import { setToken, setUser, setBusinesses, deviceId } from '../session.js';

export function render(root) {
  const wrap = el('div', { class: 'login-wrap' }, el('div', { class: 'login-card' }, el('p', { class: 'login-sub' }, 'Checking…')));
  root.append(wrap);
  fetch(ORIGIN + '/auth/status')
    .then(r => r.json())
    .then(({ bootstrapped }) => { clear(wrap).append(bootstrapped ? loginForm() : bootstrapForm()); })
    .catch(() => { clear(wrap).append(el('div', { class: 'login-card' }, el('p', { class: 'login-err' }, 'Can’t reach the server — check the connection and reload.'))); });
}

export function unmount() {}

function loginForm() {
  const ident = el('input', { class: 'login-input', placeholder: 'Login name', autocomplete: 'username' });
  const pin = el('input', { class: 'login-input', type: 'password', placeholder: 'PIN', inputmode: 'numeric', autocomplete: 'current-password' });
  const err = el('div', { class: 'login-err' });
  const form = el('form', { class: 'login-card', onsubmit: (e) => { e.preventDefault(); submit('/auth/login', { identifier: ident.value, pin: pin.value }, err); } },
    el('div', { class: 'login-logo' }, 'Back Office'),
    el('p', { class: 'login-sub' }, 'Sign in with your login name and PIN.'),
    ident, pin, err,
    el('button', { class: 'btn', type: 'submit' }, 'Sign in'),
  );
  setTimeout(() => ident.focus(), 0);
  return form;
}

function bootstrapForm() {
  const name = el('input', { class: 'login-input', placeholder: 'Your name' });
  const ident = el('input', { class: 'login-input', placeholder: 'Login name (e.g. tina)' });
  const pin = el('input', { class: 'login-input', type: 'password', placeholder: 'Choose a PIN (4–8 digits)', inputmode: 'numeric' });
  const pin2 = el('input', { class: 'login-input', type: 'password', placeholder: 'PIN again', inputmode: 'numeric' });
  const err = el('div', { class: 'login-err' });
  return el('form', { class: 'login-card', onsubmit: (e) => {
    e.preventDefault();
    if (pin.value !== pin2.value) { err.textContent = 'PINs don’t match.'; return; }
    submit('/auth/bootstrap', { name: name.value.trim(), identifier: ident.value, pin: pin.value }, err);
  } },
    el('div', { class: 'login-logo' }, 'Back Office'),
    el('p', { class: 'login-sub' }, 'First run — create the owner account. This account sees every business.'),
    name, ident, pin, pin2, err,
    el('button', { class: 'btn', type: 'submit' }, 'Create owner account'),
  );
}

async function submit(path, body, err) {
  err.textContent = '';
  try {
    const res = await fetch(ORIGIN + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, deviceId: deviceId(), deviceName: navigator.platform || 'device' }),
    });
    const data = await res.json();
    if (!res.ok) {
      err.textContent =
        data.error === 'locked' ? `Too many tries — locked for ${data.retryInMin} min.` :
        data.error === 'device_pending' ? 'This device needs approval — ask the owner, then sign in again.' :
        data.error === 'invalid login' ? 'Wrong login name or PIN.' :
        data.error === 'bad request' ? 'Check the fields — login name is letters/numbers, PIN is 4–8 digits.' :
        'Sign-in failed.';
      return;
    }
    setToken(data.token);
    setUser(data.user);
    setBusinesses(data.businesses);
    // 3b UI shaping: one business → straight in, no selector.
    location.hash = data.businesses.length === 1 ? `#/b/${data.businesses[0].id}/dashboard` : '#/businesses';
  } catch {
    err.textContent = 'Can’t reach the server.';
  }
}
