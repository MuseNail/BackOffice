// ── route: /b/:biz/plaid/* — Plaid bank-feed connect + sync ───────────────────
// The Plaid client_id/secret stay server-side (PLAID_CLIENT_ID var + PLAID_SECRET
// secret). A Link token is minted here; the public_token Link returns is exchanged
// for a long-lived access_token that is stored ONLY in the BusinessDO under a
// server-only key (never in the client snapshot). /transactions/sync then pulls
// settled rows that land STAGED in the same Review flow as CSV imports. PLAID_ENV
// selects sandbox vs production. The owner connects a feed onto a bank account they
// already created (with its ledger link), so we never auto-create orphan accounts.

import { shapePlaidBatch } from '../../../js/app/lib/plaid-map.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

const PLAID_HOSTS = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' };
const plaidHost = (env) => PLAID_HOSTS[env.PLAID_ENV === 'production' ? 'production' : 'sandbox'];
const configured = (env) => !!(env.PLAID_CLIENT_ID && env.PLAID_SECRET);

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
  const body = {
    client_name: 'Muse Back Office',
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: bizId },
    products: ['transactions'],
    account_filters: { depository: { account_subtypes: ['checking', 'savings'] } },
  };
  if (env.PLAID_REDIRECT_URI) body.redirect_uri = env.PLAID_REDIRECT_URI;
  if (env.PLAID_WEBHOOK_URL) body.webhook = env.PLAID_WEBHOOK_URL;
  const r = await plaid(env, '/link/token/create', body);
  if (!r.ok) return json({ error: 'link_token_failed', detail: r.data.error_message || '' }, 502);
  return json({ link_token: r.data.link_token, expiration: r.data.expiration });
}

// POST /b/:biz/plaid/exchange { public_token, institution } → { itemId, accounts }
// Exchanges for the access token, stores it server-side, and returns the bank's
// depository accounts so the client can map one to the bank account being connected.
export async function handlePlaidExchange(req, env, bizId) {
  if (!configured(env)) return json({ error: 'plaid_not_configured' }, 501);
  let b = {}; try { b = await req.json(); } catch {}
  const publicToken = String(b.public_token || '');
  if (!publicToken) return json({ error: 'public_token required' }, 400);
  const institution = String(b.institution || 'Bank').slice(0, 80);

  const ex = await plaid(env, '/item/public_token/exchange', { public_token: publicToken });
  if (!ex.ok) return json({ error: 'exchange_failed', detail: ex.data.error_message || '' }, 502);
  const accessToken = ex.data.access_token, itemId = ex.data.item_id;

  const acc = await plaid(env, '/accounts/get', { access_token: accessToken });
  if (!acc.ok) return json({ error: 'accounts_failed', detail: acc.data.error_message || '' }, 502);
  const accounts = (acc.data.accounts || [])
    .filter(a => a.type === 'depository')
    .map(a => ({ plaidAccountId: a.account_id, name: a.name || a.official_name || 'Account', mask: a.mask || '', subtype: a.subtype || '' }));

  const res = await toDO(env, bizId, '/_plaid/save-item', { accessToken, itemId, institution, accounts });
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

// POST /b/:biz/plaid/sync → { synced, items } — pull new settled rows into Review.
export async function handlePlaidSync(req, env, bizId) {
  if (!configured(env)) return json({ error: 'plaid_not_configured' }, 501);
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
    const byAcct = new Map();
    for (const t of added) {
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
