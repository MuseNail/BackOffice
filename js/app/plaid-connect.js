// ── Plaid bank-feed client: connect (incl. OAuth redirect) + sync ──────────────
// Big national banks use OAuth: on the web, Link redirects the whole tab to the
// bank, the bank authenticates the user, then redirects back to our registered URL
// with ?oauth_state_id=… We persist the link_token + which bank account is being
// connected in sessionStorage across that redirect; resumePlaidOAuth() (called once
// on boot) re-opens Link with receivedRedirectUri to finish. The bank login never
// touches our app — we only ever receive a public_token, which the Worker swaps for
// a server-side access token.

import { el, modal, toast } from './ui.js';
import { api } from './sync.js';
import { getActiveBiz } from './session.js';
import { entities } from './store.js';

const OAUTH_KEY = 'plaid_oauth';   // sessionStorage: { linkToken, bankacctId, biz }

let _plaidScript = null;
function loadPlaid() {
  if (window.Plaid) return Promise.resolve();
  if (_plaidScript) return _plaidScript;
  _plaidScript = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    s.onload = resolve;
    s.onerror = () => { _plaidScript = null; reject(new Error('Could not load Plaid')); };
    document.head.appendChild(s);
  });
  return _plaidScript;
}

const clearOAuth = () => { try { sessionStorage.removeItem(OAUTH_KEY); } catch { /* private mode */ } };

// Shared success path: swap the public_token for a stored access token, then map
// the chosen Plaid account to the bank account being connected.
async function onConnected(biz, bankacct, publicToken, metadata) {
  const institution = metadata?.institution?.name || bankacct.institution || 'Bank';
  const ex = await api(`/b/${biz}/plaid/exchange`, { method: 'POST', body: JSON.stringify({ public_token: publicToken, institution }) });
  if (!ex.ok) { toast('Could not finish connecting', 'err'); return; }
  const { itemId, accounts } = await ex.json();
  if (!accounts || !accounts.length) { toast('No checking/savings account found at that bank', 'err'); return; }
  const choose = (plaidAccountId) => mapPlaid(biz, itemId, plaidAccountId, bankacct.id);
  if (accounts.length === 1) choose(accounts[0].plaidAccountId);
  else pickAccountModal(accounts, bankacct, choose);
}

async function mapPlaid(biz, itemId, plaidAccountId, bankacctId) {
  const r = await api(`/b/${biz}/plaid/map`, { method: 'POST', body: JSON.stringify({ itemId, plaidAccountId, bankacctId }) });
  if (!r.ok) { toast('Could not link the account', 'err'); return; }
  toast('Bank connected ✓ — pulling transactions…');
  await syncPlaid(biz, true);
}

export async function syncPlaid(biz, quiet) {
  try {
    const r = await api(`/b/${biz}/plaid/sync`, { method: 'POST' });
    if (r.status === 501) { if (!quiet) toast('Bank feed not configured', 'err'); return; }
    if (!r.ok) { if (!quiet) toast('Sync failed', 'err'); return; }
    const { synced } = await r.json();
    toast(synced ? `${synced} new transaction${synced === 1 ? '' : 's'} in Review` : 'No new transactions');
  } catch { if (!quiet) toast('Sync failed', 'err'); }
}

function pickAccountModal(accounts, bankacct, choose) {
  const m = modal(`Which account is “${bankacct.name}”?`);
  m.body.append(
    el('p', { class: 'sub' }, 'Pick the bank account whose transactions should feed this one.'),
    ...accounts.map(a => el('button', { class: 'btn sm', style: 'display:block;width:100%;text-align:left;margin-bottom:6px',
      onclick: () => { m.close(); choose(a.plaidAccountId); } }, `${a.name}${a.mask ? ' ••' + a.mask : ''} · ${a.subtype || 'account'}`)),
  );
}

// Open Plaid Link to connect a feed onto an existing bank account.
export async function startPlaidConnect(bankacct) {
  const biz = getActiveBiz();
  try {
    await loadPlaid();
    const r = await api(`/b/${biz}/plaid/link-token`, { method: 'POST' });
    if (r.status === 501) { toast('Bank feed isn’t set up yet — the owner adds the Plaid secret to the Worker.', 'err'); return; }
    if (!r.ok) { toast('Could not start the bank connection', 'err'); return; }
    const { link_token } = await r.json();
    // Persist for the OAuth round-trip (a big bank redirects the whole tab away).
    try { sessionStorage.setItem(OAUTH_KEY, JSON.stringify({ linkToken: link_token, bankacctId: bankacct.id, biz })); } catch { /* private mode */ }
    const handler = window.Plaid.create({
      token: link_token,
      onSuccess: (pt, md) => { clearOAuth(); onConnected(biz, bankacct, pt, md); },
      onExit: (err) => { clearOAuth(); if (err) toast('Bank connection cancelled', 'err'); },
    });
    handler.open();
  } catch (e) { toast(e.message || 'Bank connection failed', 'err'); }
}

// Called once on boot. If we're returning from a bank's OAuth redirect
// (?oauth_state_id=…), re-open Link with receivedRedirectUri to finish connecting.
export async function resumePlaidOAuth() {
  if (!new URLSearchParams(location.search).get('oauth_state_id')) return;
  const clean = location.pathname + (location.hash || '');   // strip the param so a refresh can't re-trigger
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(OAUTH_KEY) || 'null'); } catch { /* ignore */ }
  if (!saved) { history.replaceState(null, '', clean); return; }
  const bankacct = entities('bankacct').find(b => b.id === saved.bankacctId) || { id: saved.bankacctId, name: 'your account' };
  try {
    await loadPlaid();
    const handler = window.Plaid.create({
      token: saved.linkToken,
      receivedRedirectUri: window.location.href,
      onSuccess: (pt, md) => { clearOAuth(); history.replaceState(null, '', clean); onConnected(saved.biz, bankacct, pt, md); },
      onExit: () => { clearOAuth(); history.replaceState(null, '', clean); },
    });
    handler.open();
  } catch { clearOAuth(); history.replaceState(null, '', clean); }
}
