// ── view: login — PIN sign-in + first-run owner bootstrap ────────────────
// GET /auth/status decides which form renders. Device enrollment and rate
// limiting live server-side (registry); this view just explains the errors.
import { el, clear } from '../ui.js';
import { ORIGIN } from '../config.js';
import { setToken, setUser, setBusinesses, deviceId } from '../session.js';
import { markSignedIn } from '../lock.js';

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
  const btn = el('button', { class: 'btn', type: 'submit' }, 'Sign in');
  const form = el('form', { class: 'login-card', onsubmit: (e) => { e.preventDefault(); submit('/auth/login', { identifier: ident.value, pin: pin.value }, err, btn); } },
    el('div', { class: 'login-logo' }, 'Back Office'),
    el('p', { class: 'login-sub' }, 'Sign in with your login name and PIN.'),
    ident, pin, err, btn,
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

async function submit(path, body, err, btn) {
  err.textContent = '';
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
  const reset = () => { if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; } };
  // The network try covers ONLY the fetch + parse, so a LOCAL storage failure below can never be
  // mislabelled "Can't reach the server" (the incident this fixes).
  let data;
  try {
    const res = await fetch(ORIGIN + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, deviceId: deviceId(), deviceName: navigator.platform || 'device' }),
    });
    data = await res.json();
    if (!res.ok) {
      err.textContent =
        data.error === 'locked' ? `Too many tries — locked for ${data.retryInMin} min.` :
        data.error === 'device_revoked' ? 'This device was removed by the owner. Ask them to let you sign in again.' :
        data.error === 'invalid login' ? 'Wrong login name or PIN.' :
        data.error === 'bad request' ? 'Check the fields — login name is letters/numbers, PIN is 4–8 digits.' :
        'Sign-in failed.';
      reset();
      return;
    }
  } catch {
    err.textContent = 'Can’t reach the server.';
    reset();
    return;
  }
  // Auth succeeded server-side — persist the session locally. setToken evicts regenerable caches to make
  // room; if even that fails the tiny token can't be saved and a session can't be sustained (getToken
  // re-reads localStorage every request), so stop with an HONEST storage message, never a network one.
  // Attempt all three (each evicts caches to make room); if any still can't fit, stop with an honest
  // storage message. safeSetItem has already auto-cleared every regenerable cache by this point, so the
  // only recourse left is clearing the site's data — don't suggest closing tabs (that frees memory, not
  // localStorage).
  const okT = setToken(data.token);
  const okU = setUser(data.user);
  const okB = setBusinesses(data.businesses);
  if (!(okT && okU && okB)) {
    err.textContent = 'Signed in, but this device’s storage is full and your session couldn’t be saved. Clear this site’s data in your browser, then sign in again.';
    reset();
    return;
  }
  markSignedIn();   // start a fresh live session for the close/idle auto-lock
  // 3b UI shaping: one business → straight in, no selector.
  const target = data.businesses.length === 1 ? `#/b/${data.businesses[0].id}/dashboard` : '#/businesses';
  // A post-idle-lock login can land on the SAME hash it locked on (a single-business user
  // always does) — an identical assignment fires no hashchange, which would leave this
  // login screen mounted forever. Nudge the router by hand in that case.
  const changed = location.hash !== target;
  location.hash = target;
  if (!changed) window.dispatchEvent(new Event('hashchange'));
}
