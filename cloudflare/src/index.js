// ── Back Office Worker — router + session auth (kickoff 3b) ────────────────
import { BusinessDO } from './do/business.js';
import { RegistryDO } from './do/registry.js';
import { handleCategorize } from './routes/ai.js';
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
  if (sessCache.size > 2000) sessCache.clear();
  return sess;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (p === '/health') return json({ ok: true, service: 'backoffice' });

    // Auth endpoints are the only other open routes — the registry rate-limits
    // and validates them itself.
    if (p === '/auth/status' || p === '/auth/login' || p === '/auth/bootstrap' || p === '/auth/logout') {
      return withCors(await registry(env).fetch(req));
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
      if (role === 'viewer' && req.method !== 'GET' && !m[2].endsWith('/ws')) return json({ error: 'read only' }, 403);
      const fwd = new Request(req);
      fwd.headers.set('X-Bo-Role', role);
      fwd.headers.set('X-Bo-User', sess.userId);
      return withCors(await env.BUSINESS_DO.get(env.BUSINESS_DO.idFromName(bizId)).fetch(fwd));
    }

    return json({ error: 'not found' }, 404);
  },
};
