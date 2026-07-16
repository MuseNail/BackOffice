// node --test tests/plaid-env.test.mjs
// Regression suite for the 2026-06 incident: a Plaid feed connected while the Worker
// resolved to Plaid's SANDBOX pulled canned demo fixtures (Uber SF**POOL**, SparkFun,
// United Airlines) into the live Muse books as real-looking transactions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { plaidEnv, plaidHost, configured } from '../cloudflare/src/routes/plaid.js';

const env = (PLAID_ENV) => ({ PLAID_CLIENT_ID: 'cid', PLAID_SECRET: 'sec', PLAID_ENV });

test('production is the one accepted env', () => {
  assert.equal(plaidEnv(env('production')), 'production');
  assert.equal(plaidHost(env('production')), 'https://production.plaid.com');
});

test('surrounding whitespace is invisible, so it is trimmed not rejected', () => {
  assert.equal(plaidEnv(env(' production ')), 'production');
  assert.equal(plaidEnv(env('\tproduction\n')), 'production');
});

// THE incident. 'sandbox' was a VALID setting (140c816) — a fallback-only fix would
// still resolve it and re-inject fabricated transactions into the live books.
test('sandbox is REFUSED — live books can never pull fabricated data', () => {
  assert.equal(plaidEnv(env('sandbox')), null);
  assert.throws(() => plaidHost(env('sandbox')), /PLAID_ENV/);
});

// The silent fallback: anything not exactly 'production' used to mean sandbox.
test('an unrecognized env resolves to null, never to a fallback host', () => {
  for (const v of ['prod', '', 'PRODUCTIN', 'development', 'live', 'Sandbox', undefined, null, 0, false]) {
    assert.equal(plaidEnv(env(v)), null, `PLAID_ENV=${JSON.stringify(v)} must be null`);
  }
});

// Case-folding would let the running value drift from the version-controlled toml.
// A non-canonical config value in a financial system is a signal, not a typo to absorb.
test('a non-canonical case is refused rather than silently corrected', () => {
  assert.equal(plaidEnv(env('Production')), null);
  assert.equal(plaidEnv(env('PRODUCTION')), null);
});

// A bare `PLAID_HOSTS[e]` lookup walks the prototype chain: 'constructor' is truthy
// and would produce fetch("function Object() {…}/link/token/create").
test('inherited Object properties are not valid envs', () => {
  for (const v of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    assert.equal(plaidEnv(env(v)), null, `PLAID_ENV=${v} must not resolve via the prototype chain`);
  }
  assert.throws(() => plaidHost(env('constructor')), /PLAID_ENV/);
});

test('plaidHost throws rather than returning undefined for a bad env', () => {
  assert.throws(() => plaidHost(env('nope')), /PLAID_ENV/);
  assert.throws(() => plaidHost({ PLAID_CLIENT_ID: 'c', PLAID_SECRET: 's' }), /PLAID_ENV/);
});

// configured() gates handlePlaidDisconnect (plaid.js:94). Folding the env check into
// it would 501 the one button needed to detach a feed on a misconfigured Worker.
test('configured() tracks credentials only, so disconnect survives a bad env', () => {
  assert.equal(configured(env('sandbox')), true);
  assert.equal(configured(env('garbage')), true);
  assert.equal(configured({ PLAID_ENV: 'production' }), false);
  assert.equal(configured({ PLAID_CLIENT_ID: 'cid', PLAID_ENV: 'production' }), false);
});
