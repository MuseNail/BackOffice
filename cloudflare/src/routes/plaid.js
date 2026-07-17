// ── route: /b/:biz/plaid/* — Plaid bank-feed connect + sync ───────────────────
// The Plaid client_id/secret stay server-side (PLAID_CLIENT_ID var + PLAID_SECRET
// secret). A Link token is minted here; the public_token Link returns is exchanged
// for a long-lived access_token that is stored ONLY in the BusinessDO under a
// server-only key (never in the client snapshot). /transactions/sync then pulls
// settled rows that land STAGED in the same Review flow as CSV imports. These are
// LIVE books, so `production` is the only env this Worker will talk to — see below.
// The owner connects a feed onto a bank account they already created (with its
// ledger link), so we never auto-create orphan accounts.

import { shapePlaidBatch } from '../../../js/app/lib/plaid-map.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

// Sandbox is deliberately ABSENT. In 2026-06 a feed was connected while this Worker
// resolved to sandbox, and Plaid's canned demo fixtures (Uber SF**POOL**, SparkFun,
// United Airlines) landed in the live Muse books as real-looking transactions; five
// were approved into the ledger before anyone noticed. Nothing here should be able to
// pull fabricated money into real books, so there is no fake host to select.
const PLAID_HOSTS = { production: 'https://production.plaid.com' };

// The resolved env, or null if it isn't one we'll talk to. `Object.hasOwn` (not a bare
// index) so inherited keys like 'constructor' can't resolve to a truthy non-host. Only
// whitespace is trimmed: case is NOT folded, so a `PLAID_ENV` that doesn't match the
// toml surfaces as a misconfiguration instead of being quietly absorbed.
export const plaidEnv = (env) => {
  const e = String(env.PLAID_ENV ?? '').trim();
  return Object.hasOwn(PLAID_HOSTS, e) ? e : null;
};

// Throws rather than returning undefined: a bad env must never build a garbage URL.
export function plaidHost(env) {
  const e = plaidEnv(env);
  if (!e) throw new Error(`PLAID_ENV must be one of [${Object.keys(PLAID_HOSTS).join(', ')}]; got ${JSON.stringify(env.PLAID_ENV ?? null)}`);
  return PLAID_HOSTS[e];
}

// Credentials only — NOT the env. This gates handlePlaidDisconnect too, and a
// misconfigured env must still let the owner detach a feed.
export const configured = (env) => !!(env.PLAID_CLIENT_ID && env.PLAID_SECRET);

// What Link offers, and what we accept back. Credit cards ride the same `transactions`
// product and the same sign convention as a bank account (Plaid: positive = money out of
// the account, so a charge is positive and a payment is negative), which plaid-map.js
// already flips — see the card cases in tests/plaid-map.test.mjs. Everything else (loans,
// investments) is refused: the app has no register to post it to.
export const ACCOUNT_FILTERS = {
  depository: { account_subtypes: ['checking', 'savings'] },
  credit: { account_subtypes: ['credit card'] },
};
export const isSupportedAccount = (a) => Object.hasOwn(ACCOUNT_FILTERS, a?.type ?? '');

// 501 for the routes that actually reach Plaid, so a bad env disables the feed loudly
// instead of silently sourcing data from somewhere else. Logs, because the client toast
// buckets every 501 as "not configured" — `wrangler tail` is where the cause is legible.
const envInvalid = (env) => {
  if (plaidEnv(env)) return null;
  const detail = `PLAID_ENV must be one of [${Object.keys(PLAID_HOSTS).join(', ')}]; got ${JSON.stringify(env.PLAID_ENV ?? null)}`;
  console.error('[plaid] refusing to run:', detail);
  return json({ error: 'plaid_env_invalid', detail }, 501);
};

async function plaid(env, path, body) {
  const res = await fetch(plaidHost(env) + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) console.error('[plaid]', path, res.status, (data && data.error_code) || '', (data && data.error_message) || '');
  return { ok: res.ok, status: res.status, data };
}

const stubFor = (env, bizId) => env.BUSINESS_DO.get(env.BUSINESS_DO.idFromName(bizId));
const toDO = (env, bizId, path, body) => stubFor(env, bizId).fetch(new Request('https://do/b/x' + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}));

// POST /b/:biz/plaid/link-token → { link_token } — opens Plaid Link on the client.
export async function handlePlaidLinkToken(req, env, bizId) {
  if (!configured(env)) return json({ error: 'plaid_not_configured' }, 501);
  const bad = envInvalid(env); if (bad) return bad;
  const body = {
    client_name: 'Muse Back Office',
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: bizId },
    products: ['transactions'],
    account_filters: ACCOUNT_FILTERS,
  };
  if (env.PLAID_REDIRECT_URI) body.redirect_uri = env.PLAID_REDIRECT_URI;
  if (env.PLAID_WEBHOOK_URL) body.webhook = env.PLAID_WEBHOOK_URL;
  const r = await plaid(env, '/link/token/create', body);
  if (!r.ok) return json({ error: 'link_token_failed', detail: r.data.error_message || '' }, 502);
  return json({ link_token: r.data.link_token, expiration: r.data.expiration });
}

// POST /b/:biz/plaid/exchange { public_token, institution } → { itemId, accounts }
// Exchanges for the access token, stores it server-side, and returns the bank/card
// accounts so the client can map one to the bank account being connected.
export async function handlePlaidExchange(req, env, bizId) {
  if (!configured(env)) return json({ error: 'plaid_not_configured' }, 501);
  const bad = envInvalid(env); if (bad) return bad;
  let b = {}; try { b = await req.json(); } catch {}
  const publicToken = String(b.public_token || '');
  if (!publicToken) return json({ error: 'public_token required' }, 400);
  const institution = String(b.institution || 'Bank').slice(0, 80);

  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(b.startDate || '') ? b.startDate : null;

  const ex = await plaid(env, '/item/public_token/exchange', { public_token: publicToken });
  if (!ex.ok) return json({ error: 'exchange_failed', detail: ex.data.error_message || '' }, 502);
  const accessToken = ex.data.access_token, itemId = ex.data.item_id;

  const acc = await plaid(env, '/accounts/get', { access_token: accessToken });
  if (!acc.ok) return json({ error: 'accounts_failed', detail: acc.data.error_message || '' }, 502);
  // Link's account_filters are a UI hint — /accounts/get returns the whole item, so
  // re-filter here. By TYPE only, deliberately: some institutions return a null subtype,
  // and enforcing the subtype list would reject working accounts. The picker shows the
  // owner the name/mask/subtype, so they choose the exact account.
  const accounts = (acc.data.accounts || [])
    .filter(isSupportedAccount)
    .map(a => ({ plaidAccountId: a.account_id, name: a.name || a.official_name || 'Account', mask: a.mask || '', subtype: a.subtype || '' }));

  const res = await toDO(env, bizId, '/_plaid/save-item', { accessToken, itemId, institution, accounts, startDate });
  if (!res.ok) return json({ error: 'store_failed' }, 502);
  return json({ itemId, accounts });
}

// POST /b/:biz/plaid/map { itemId, plaidAccountId, bankacctId } → ok
// Links one Plaid account to a Back Office bank account the owner already set up.
export async function handlePlaidMap(req, env, bizId) {
  if (!configured(env)) return json({ error: 'plaid_not_configured' }, 501);
  let b = {}; try { b = await req.json(); } catch {}
  if (!b.itemId || !b.plaidAccountId || !b.bankacctId) return json({ error: 'itemId, plaidAccountId, bankacctId required' }, 400);
  const res = await toDO(env, bizId, '/_plaid/map', { itemId: b.itemId, plaidAccountId: b.plaidAccountId, bankacctId: b.bankacctId });
  return json(await res.json(), res.status);
}

// POST /b/:biz/plaid/disconnect { bankacctId } → drop the feed from that account.
export async function handlePlaidDisconnect(req, env, bizId) {
  if (!configured(env)) return json({ error: 'plaid_not_configured' }, 501);
  let b = {}; try { b = await req.json(); } catch {}
  if (!b.bankacctId) return json({ error: 'bankacctId required' }, 400);
  const res = await toDO(env, bizId, '/_plaid/disconnect', { bankacctId: b.bankacctId });
  const out = await res.json().catch(() => ({}));
  // Best-effort: tell Plaid to drop the item too (stops refresh/billing). A leftover
  // sandbox token under production env just errors here — fine, the local feed is gone.
  if (out.accessToken) { try { await plaid(env, '/item/remove', { access_token: out.accessToken }); } catch { /* best-effort */ } }
  return json({ ok: true });
}

// POST /b/:biz/plaid/sync → { synced, items } — pull new settled rows into Review.
export async function handlePlaidSync(req, env, bizId) {
  if (!configured(env)) return json({ error: 'plaid_not_configured' }, 501);
  const bad = envInvalid(env); if (bad) return bad;
  const itemsRes = await toDO(env, bizId, '/_plaid/items');
  const { items } = await itemsRes.json();
  if (!items || !items.length) return json({ synced: 0, items: 0 });

  let total = 0;
  for (const item of items) {
    // Walk every page from the stored cursor (added/modified only return what's new).
    let cursor = item.cursor || null, hasMore = true, guard = 0;
    const added = [];
    while (hasMore && guard++ < 50) {
      const r = await plaid(env, '/transactions/sync', { access_token: item.accessToken, ...(cursor ? { cursor } : {}), count: 500 });
      if (!r.ok) { hasMore = false; break; }
      added.push(...(r.data.added || []), ...(r.data.modified || []));
      cursor = r.data.next_cursor;
      hasMore = !!r.data.has_more;
    }
    // Group new rows by their Plaid account, map each to its bank account, shape.
    // The cursor still advanced past ALL history above; we just don't STAGE anything
    // before the cutoff, so transactions already imported by CSV aren't duplicated.
    const since = item.startDate || '0000-00-00';
    const byAcct = new Map();
    for (const t of added) {
      if (t.date && t.date < since) continue;          // history already in the books
      const bankacctId = item.bankacctByPlaidAcct && item.bankacctByPlaidAcct[t.account_id];
      if (!bankacctId) continue;                       // account the owner didn't map
      if (!byAcct.has(t.account_id)) byAcct.set(t.account_id, { bankacctId, txns: [] });
      byAcct.get(t.account_id).txns.push(t);
    }
    const values = [];
    for (const { bankacctId, txns } of byAcct.values()) values.push(...shapePlaidBatch(txns, bankacctId));

    const writeRes = await toDO(env, bizId, '/_plaid/apply-sync', { itemId: item.itemId, values, cursor });
    const w = await writeRes.json().catch(() => ({}));
    total += w.created || 0;
  }
  return json({ synced: total, items: items.length });
}
