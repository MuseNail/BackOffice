// ── Back Office Worker — router + session auth (kickoff 3b) ────────────────
import { BusinessDO } from './do/business.js';
import { RegistryDO } from './do/registry.js';
import { handleCategorize } from './routes/ai.js';
import { handleSyncInbound } from './routes/sync.js';
import { handleHelcimTransactions, handleHelcimBatches } from './routes/processors.js';
import { handlePlaidLinkToken, handlePlaidExchange, handlePlaidMap, handlePlaidSync, handlePlaidDisconnect } from './routes/plaid.js';
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

    // Everything else requires a session. WS upgrades can't set headers from
    // the browser, so the websocket route may carry the token as ?token=.
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer /, '') ||
      (p.endsWith('/ws') ? url.searchParams.get('token') : null);
    const sess = await resolveSession(token, env);
    if (!sess) return json({ error: 'unauthorized' }, 401);

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
      if (m[2] === '/processor/helcim/transactions' && req.method === 'GET') return withCors(await handleHelcimTransactions(req, env));
      if (m[2] === '/processor/helcim/batches' && req.method === 'GET') return withCors(await handleHelcimBatches(req, env));
      // Plaid bank feed — connecting/syncing changes state, so owner/manager only.
      if (m[2].startsWith('/plaid/') && req.method === 'POST') {
        if (role !== 'owner' && role !== 'manager') return json({ error: 'forbidden' }, 403);
        if (m[2] === '/plaid/link-token') return withCors(await handlePlaidLinkToken(req, env, bizId));
        if (m[2] === '/plaid/exchange')   return withCors(await handlePlaidExchange(req, env, bizId));
        if (m[2] === '/plaid/map')        return withCors(await handlePlaidMap(req, env, bizId));
        if (m[2] === '/plaid/sync')       return withCors(await handlePlaidSync(req, env, bizId));
        if (m[2] === '/plaid/disconnect') return withCors(await handlePlaidDisconnect(req, env, bizId));
      }
      if (role === 'viewer' && req.method !== 'GET' && !m[2].endsWith('/ws')) return json({ error: 'read only' }, 403);
      const fwd = new Request(req);
      fwd.headers.set('X-Bo-Role', role);
      fwd.headers.set('X-Bo-User', sess.userId);
      return withCors(await env.BUSINESS_DO.get(env.BUSINESS_DO.idFromName(bizId)).fetch(fwd));
    }

    return json({ error: 'not found' }, 404);
  },
};
