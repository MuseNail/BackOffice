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
import { reportError } from './reporter.js';
import { suggestedCutoff, farBackCutoff, todayLocal, lastImportedDate, syncMessage } from './lib/plaid-feed.js';

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
// the chosen Plaid account to the bank account being connected. startDate is the
// cutoff — only transactions on/after it are staged, so history already imported by
// CSV isn't re-pulled as duplicates.
async function onConnected(biz, bankacct, startDate, publicToken, metadata) {
  const institution = metadata?.institution?.name || bankacct.institution || 'Bank';
  const ex = await api(`/b/${biz}/plaid/exchange`, { method: 'POST', body: JSON.stringify({ public_token: publicToken, institution, startDate }) });
  if (!ex.ok) {
    const why = await ex.json().catch(() => ({}));
    toast(why.error === 'plaid_env_invalid' ? 'Bank feeds are misconfigured — nothing was connected.'
      : why.error ? `Couldn’t finish connecting — ${why.error}` : 'Couldn’t finish connecting', 'err');
    return;
  }
  const { itemId, accounts } = await ex.json();
  if (!accounts || !accounts.length) { toast('That bank didn’t return a checking, savings, or credit card account we can use.', 'err'); return; }
  // Always confirm, even for a single account. Link's own account-select means "one
  // returned" is the COMMON case, not an edge, and binding it silently is the one
  // mistake here with no visible moment to catch it — a wrong bind feeds this register
  // from the wrong account, and every approval after posts real money to the wrong place.
  // With one account the picker is simply a one-button confirm showing name and mask.
  pickAccountModal(accounts, bankacct, (plaidAccountId) => mapPlaid(biz, bankacct, itemId, plaidAccountId));
}

async function mapPlaid(biz, bankacct, itemId, plaidAccountId) {
  const r = await api(`/b/${biz}/plaid/map`, { method: 'POST', body: JSON.stringify({ itemId, plaidAccountId, bankacctId: bankacct.id }) });
  if (!r.ok) { toast('Could not link the account', 'err'); return; }
  const { errors } = await syncPlaid(biz);
  // A sync covers EVERY feed, so `synced` is the fleet total and `errors` may belong to
  // someone else's feed entirely. Count this account's own rows, and only mention trouble
  // that is actually this account's — otherwise an unrelated broken feed would swallow
  // the very message this release exists to show.
  const mine = errors.some(e => (e.bankacctIds || []).includes(bankacct.id));
  const rows = entities('staged').filter(s => s.bankacctId === bankacct.id).length;
  connectedModal(biz, bankacct, rows, mine);
}

// Banks send the newest transactions immediately and backfill older history over the
// following minutes, and nothing tells us when that lands (PLAID_WEBHOOK_URL is unset).
// Without saying so, a first sync looks like the whole story — the owner got 13 rows,
// assumed the feed was broken, and only found the other 27 by pressing Sync again.
function connectedModal(biz, bankacct, rows, hadError) {
  const m = modal(`${bankacct.name} is connected`);
  m.body.append(
    el('p', {}, rows
      ? `${rows} transaction${rows === 1 ? '' : 's'} ${rows === 1 ? 'is' : 'are'} in Review so far.`
      : 'No transactions have arrived yet.'),
    hadError ? el('p', { class: 'sub', style: 'color:var(--amber)' },
      'Your bank didn’t send everything this time — the message above says why. Pressing Sync now again usually finishes it.') : null,
    el('p', {}, 'Your bank sends the newest transactions right away and fills in older history afterwards — usually within the hour, sometimes longer. Press Sync now any time to pull whatever has arrived.'),
    // Scoped to SYNCING on purpose: a re-sync is deduped by Plaid's stable transaction
    // id, but a Plaid row and a hand-imported CSV row for the same transaction are NOT
    // collapsed — so "never added twice" would be a promise this can't keep.
    el('p', { class: 'sub' }, 'It’s safe to press it more than once — syncing again never adds the same transaction twice.'),
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end' },
      el('button', { class: 'btn ghost', onclick: () => { m.close(); syncPlaid(biz); } }, 'Sync now'),
      el('button', { class: 'btn', onclick: m.close }, 'Done')),
  );
}

// Name the ACCOUNT, not the institution — "Chase" doesn't tell you whether it's
// Honey - 8002 or Parents - 8005. The Worker sends ids; the names are already here.
function feedName(err) {
  const names = (err.bankacctIds || [])
    .map(id => entities('bankacct').find(b => b.id === id))
    .filter(Boolean).map(b => b.name);
  return names.join(' and ') || err.institution || 'a bank feed';
}

// Returns { synced, errors } so callers can react; ALWAYS speaks. There is no `quiet`
// mode: the old one gated the error paths while leaving the success toast unconditional,
// so it silenced exactly the failures worth hearing and announced "No new transactions"
// regardless. A feed that broke must never pass for a feed with nothing to say.
export async function syncPlaid(biz) {
  try {
    const r = await api(`/b/${biz}/plaid/sync`, { method: 'POST' });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const text = body.error === 'plaid_env_invalid' ? 'Bank feeds are misconfigured — nothing was synced.'
        : body.error === 'plaid_not_configured' ? 'Bank feeds aren’t set up yet.'
        : 'Couldn’t sync — nothing was pulled. Try again in a minute.';
      toast(text, 'err');
      try { reportError('plaid.sync', `${r.status} ${body.error || ''}`.trim(), { serious: true }); } catch { /* never block a sync on telemetry */ }
      return { synced: 0, errors: [{ code: body.error || `HTTP_${r.status}` }] };
    }
    const { synced = 0, items = 0, errors = [] } = await r.json();
    const named = errors.map(e => ({ ...e, name: feedName(e) }));
    const m = syncMessage({ synced, items, errors: named });
    toast(m.text, m.kind === 'err' ? 'err' : 'ok');
    if (named.length) {
      try { reportError('plaid.sync', named.map(e => `${e.name}: ${e.code}`).join('; '), { serious: true }); } catch { /* ignore */ }
    }
    return { synced, errors: named };
  } catch {
    toast('Couldn’t reach the server — nothing was synced.', 'err');
    return { synced: 0, errors: [{ code: 'NETWORK' }] };
  }
}

function pickAccountModal(accounts, bankacct, choose) {
  const m = modal(`Which account at this bank should feed “${bankacct.name}”?`);
  m.body.append(
    el('p', { class: 'sub' }, 'Match the last four digits to the account name — picking the wrong one feeds this register from the wrong account.'),
    ...accounts.map(a => el('button', { class: 'btn sm', style: 'display:block;width:100%;text-align:left;margin-bottom:6px',
      onclick: () => { m.close(); choose(a.plaidAccountId); } }, `${a.name}${a.mask ? ' ••' + a.mask : ''} · ${a.subtype || 'account'}`)),
  );
}

// Remove the bank feed from an account. Also the ONLY way to change a feed's cutoff or
// widen its history: those bind when the feed is created, so reconnecting is a rebuild.
// Transactions already in Review stay; you can reconnect anytime.
export function disconnectPlaid(bankacct) {
  const m = modal('Disconnect bank feed?');
  m.body.append(
    el('p', {}, `Stop syncing from “${bankacct.name}”. Transactions already in Review stay — you can reconnect anytime.`),
    el('p', { class: 'sub' }, 'Reconnecting starts over from your bank and lets you pick a new start date — that’s the way to fix a feed whose date was wrong.'),
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: async () => {
        m.close();
        const r = await api(`/b/${getActiveBiz()}/plaid/disconnect`, { method: 'POST', body: JSON.stringify({ bankacctId: bankacct.id }) });
        toast(r.ok ? 'Bank feed disconnected' : 'Could not disconnect', r.ok ? 'ok' : 'err');
      } }, 'Disconnect')),
  );
}

// Connect a feed onto an existing bank account. The cutoff is asked for FIRST because
// it's the one thing here that can't be undone: everything dated before it is skipped
// AND consumed from the feed, so a wrong date can only be fixed by disconnecting and
// connecting again. It used to pre-fill today — the most destructive possible value —
// which silently emptied Honey - 8002 (0 rows, history gone) in 2026-07.
export function startPlaidConnect(bankacct) {
  const today = todayLocal();                       // the OWNER's day: after ~5pm Pacific, UTC is already tomorrow
  // Only an imported STATEMENT row proves we hold a period. A posted transaction does
  // not: a transfer from another account, or an opening balance, puts a line on this
  // account without its statement ever being imported — which is exactly Honey's shape.
  const lastImport = lastImportedDate(entities('staged'), bankacct.id);
  const hasHistory = lastImport !== null;
  const suggested = hasHistory ? suggestedCutoff(lastImport) : farBackCutoff();

  const m = modal(`Connect bank feed — ${bankacct.name}`);
  const dateIn = el('input', { class: 'field-input', type: 'date', value: suggested, max: today, style: 'max-width:175px' });
  const pretty = (d) => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

  m.body.append(
    hasHistory
      ? el('p', {}, `Your books already have imported transactions for this account through ${pretty(lastImport)}. To avoid duplicates, only pull bank transactions dated on or after:`)
      : el('p', {}, 'This account has no imported statements in your books, so there’s nothing to duplicate. We’ll pull as much history as your bank will give us, starting from:'),
    el('div', { style: 'margin:8px 0' }, dateIn),
    hasHistory
      ? el('p', { class: 'sub' }, 'That’s the day after your last import — no gap, no overlap. Older transactions stay in your books from the import.')
      : el('p', { class: 'sub' }, 'Banks usually go back about two years, but some give much less. Whatever arrives lands in Review — nothing posts to your books until you approve it.'),
    el('p', { class: 'sub', style: 'color:var(--red)' },
      '⚠️ Transactions dated before this are skipped, and this feed won’t offer them again. If the date turns out wrong, press Disconnect and connect the feed again — that starts fresh from your bank.'),
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: () => {
        const sd = dateIn.value || suggested;
        if (!sd) { toast('Pick a date to pull transactions from', 'err'); return; }
        m.close(); openPlaidLink(bankacct, sd);
      } }, 'Continue')),
  );
}

async function openPlaidLink(bankacct, startDate) {
  const biz = getActiveBiz();
  try {
    await loadPlaid();
    const r = await api(`/b/${biz}/plaid/link-token`, { method: 'POST' });
    if (r.status === 501) {
      const why = await r.json().catch(() => ({}));
      toast(why.error === 'plaid_env_invalid' ? 'Bank feeds are misconfigured — nothing was connected.' : 'Bank feeds aren’t set up yet.', 'err');
      return;
    }
    if (!r.ok) { toast('Could not start the bank connection', 'err'); return; }
    const { link_token } = await r.json();
    // Persist for the OAuth round-trip (a big bank redirects the whole tab away).
    try { sessionStorage.setItem(OAUTH_KEY, JSON.stringify({ linkToken: link_token, bankacctId: bankacct.id, biz, startDate })); } catch { /* private mode */ }
    const handler = window.Plaid.create({
      token: link_token,
      onSuccess: (pt, md) => { clearOAuth(); onConnected(biz, bankacct, startDate, pt, md); },
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
      onSuccess: (pt, md) => { clearOAuth(); history.replaceState(null, '', clean); onConnected(saved.biz, bankacct, saved.startDate, pt, md); },
      onExit: () => { clearOAuth(); history.replaceState(null, '', clean); },
    });
    handler.open();
  } catch { clearOAuth(); history.replaceState(null, '', clean); }
}
