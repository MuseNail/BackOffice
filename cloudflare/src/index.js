// ── Back Office Worker — router + session auth (kickoff 3b) ────────────────
import { BusinessDO } from './do/business.js';
import { RegistryDO } from './do/registry.js';
import { handleCategorize, handleMatchInvoices } from './routes/ai.js';
import { handleSyncInbound } from './routes/sync.js';
import { handleHelcimTransactions, handleHelcimBatches } from './routes/processors.js';
import { handlePlaidLinkToken, handlePlaidExchange, handlePlaidMap, handlePlaidSync, handlePlaidDisconnect, handlePlaidAccounts } from './routes/plaid.js';
export { BusinessDO, RegistryDO };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const withCors = (res) => {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h, webSocket: res.webSocket });
};

const registry = (env) => env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName('global'));

// Per-isolate session cache so every request doesn't round-trip to the
// RegistryDO. Short TTL keeps revocations near-immediate.
const sessCache = new Map();
const SESS_TTL = 60_000;

async function resolveSession(token, env) {
  if (!token) return null;
  const hit = sessCache.get(token);
  if (hit && hit.exp > Date.now()) return hit.sess;
  const res = await registry(env).fetch(new Request('https://do/registry/_resolve', {
    method: 'POST',
    body: JSON.stringify({ token }),
    headers: { 'Content-Type': 'application/json' },
  }));
  if (!res.ok) { sessCache.delete(token); return null; }
  const sess = await res.json();
  sessCache.set(token, { sess, exp: Date.now() + SESS_TTL });
  // Evict oldest 20% instead of clearing everything — keeps most sessions warm.
  if (sessCache.size > 1000) {
    const evict = [...sessCache.keys()].slice(0, 200);
    for (const k of evict) sessCache.delete(k);
  }
  return sess;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (p === '/health') return json({ ok: true });

    // Auth endpoints are the only other open routes — the registry rate-limits
    // and validates them itself.
    if (p === '/auth/status' || p === '/auth/login' || p === '/auth/bootstrap' || p === '/auth/logout') {
      return withCors(await registry(env).fetch(req));
    }

    // Muse → Back Office sync (machine route, SYNC_TOKEN bearer — not a session).
    if (p === '/sync/inbound' && req.method === 'POST') {
      return withCors(await handleSyncInbound(req, env));
    }

    // Automatic error reports — POST is auth-EXEMPT so a broken auth path can still be
    // reported. Stored in a system DO instance ('__system__'), isolated from every real
    // business + the registry. (GET /report + /report/clear require a session, below.)
    if (p === '/report' && req.method === 'POST') {
      return withCors(await env.BUSINESS_DO.get(env.BUSINESS_DO.idFromName('__system__')).fetch(req));
    }

    // Everything else requires a session. WS upgrades can't set headers from
    // the browser, so the websocket route may carry the token as ?token=.
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer /, '') ||
      (p.endsWith('/ws') ? url.searchParams.get('token') : null);
    const sess = await resolveSession(token, env);
    if (!sess) return json({ error: 'unauthorized' }, 401);

    // Diagnostics read (GET /report, /report/clear) + Web Push opt-in (/push/subscribe,
    // /push/unsubscribe) — session required; forwarded to the same system DO instance.
    if (p === '/report' || p === '/report/clear' || p.startsWith('/push/')) {
      return withCors(await env.BUSINESS_DO.get(env.BUSINESS_DO.idFromName('__system__')).fetch(req));
    }

    if (p.startsWith('/registry/')) {
      if (p.startsWith('/registry/_')) return json({ error: 'not found' }, 404); // internal only
      return withCors(await registry(env).fetch(req));
    }

    const m = p.match(/^\/b\/([a-z0-9-]{1,40})(\/.*)$/);
    if (m) {
      const bizId = m[1];
      // 3b: non-members get the SAME 403 whether the business exists or not —
      // no enumeration, no existence leak.
      const role = sess.isOwner ? 'owner' : sess.memberships[bizId];
      if (!role) return json({ error: 'forbidden' }, 403);
      // suggestions are read-only — any member may ask; nothing is written
      if (m[2] === '/ai/categorize' && req.method === 'POST') return withCors(await handleCategorize(req, env, bizId));
      if (m[2] === '/ai/match-invoices' && req.method === 'POST') return withCors(await handleMatchInvoices(req, env, bizId));
      // A client's category/vendor/invoice/note SUGGESTION — a NARROW write any member
      // may make (the DO merges ONLY the suggestion fields onto the staged row). This is
      // the one write a `client`/`viewer` is allowed; it runs before the read-only gate.
      if (m[2] === '/suggest' && req.method === 'POST') {
        const payload = await req.json().catch(() => ({}));
        return withCors(await env.BUSINESS_DO.get(env.BUSINESS_DO.idFromName(bizId)).fetch(
          new Request('https://do/_suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, userId: sess.userId }) })));
      }
      if (m[2] === '/processor/helcim/transactions' && req.method === 'GET') return withCors(await handleHelcimTransactions(req, env));
      if (m[2] === '/processor/helcim/batches' && req.method === 'GET') return withCors(await handleHelcimBatches(req, env));
      // Read-only, but gated the same as the rest of /plaid/*: it names the accounts a
      // bank holds. The generic read-only gate below only blocks NON-GET, so a client
      // would otherwise reach this — it needs its own check.
      if (m[2] === '/plaid/accounts' && req.method === 'GET') {
        if (role !== 'owner' && role !== 'manager') return json({ error: 'forbidden' }, 403);
        return withCors(await handlePlaidAccounts(req, env, bizId));
      }
      // Plaid bank feed — connecting/syncing changes state, so owner/manager only.
      if (m[2].startsWith('/plaid/') && req.method === 'POST') {
        if (role !== 'owner' && role !== 'manager') return json({ error: 'forbidden' }, 403);
        if (m[2] === '/plaid/link-token') return withCors(await handlePlaidLinkToken(req, env, bizId));
        if (m[2] === '/plaid/exchange')   return withCors(await handlePlaidExchange(req, env, bizId));
        if (m[2] === '/plaid/map')        return withCors(await handlePlaidMap(req, env, bizId));
        if (m[2] === '/plaid/sync')       return withCors(await handlePlaidSync(req, env, bizId));
        if (m[2] === '/plaid/disconnect') return withCors(await handlePlaidDisconnect(req, env, bizId));
      }
      // The DO strips the /b/<biz> prefix, so an underscore path forwarded from here
      // lands on its INTERNAL handlers — which assume a DO-only caller and hold secrets
      // (/_plaid/items returns Plaid access_tokens; /_sync/inbound bypasses SYNC_TOKEN).
      // Default-deny the namespace, like /registry/_* already does above. /_audit is the
      // one internal read the app itself makes (settings.js Activity card), so it stays —
      // scoped to the roles that can actually open Settings (settings.js:52/:79), since it
      // lists every txn's payee/amount/actor.
      if (m[2].startsWith('/_') && m[2] !== '/_audit') return json({ error: 'not found' }, 404);
      if (m[2] === '/_audit' && role !== 'owner' && role !== 'manager') return json({ error: 'forbidden' }, 403);
      // `viewer` and `client` are read-only on the books (the /suggest narrow write
      // above is their only exception); everything else here is GET or the WebSocket.
      if ((role === 'viewer' || role === 'client') && req.method !== 'GET' && !m[2].endsWith('/ws')) return json({ error: 'read only' }, 403);
      const fwd = new Request(req);
      fwd.headers.set('X-Bo-Role', role);
      fwd.headers.set('X-Bo-User', sess.userId);
      return withCors(await env.BUSINESS_DO.get(env.BUSINESS_DO.idFromName(bizId)).fetch(fwd));
    }

    return json({ error: 'not found' }, 404);
  },
};
