// ── Back Office Worker — router + auth gate ────────────────
import { BusinessDO } from './do/business.js';
import { RegistryDO } from './do/registry.js';
export { BusinessDO, RegistryDO };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

// M0 bootstrap auth: one shared bearer secret. M2 replaces this with per-user
// sessions + RegistryDO membership resolution (kickoff 3b) — same gate position,
// richer check. No route is ever served without passing through here.
function authed(req, env, url) {
  if (!env.AUTH_TOKEN) return false;
  if ((req.headers.get('Authorization') || '') === `Bearer ${env.AUTH_TOKEN}`) return true;
  // WS upgrades can't carry an Authorization header from the browser — accept
  // the token as a query param on the websocket route only.
  return url.pathname.endsWith('/ws') && url.searchParams.get('token') === env.AUTH_TOKEN;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/health') return json({ ok: true, service: 'backoffice' });

    if (!authed(req, env, url)) return json({ error: 'unauthorized' }, 401);

    if (url.pathname === '/registry' || url.pathname.startsWith('/registry/')) {
      const stub = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName('global'));
      return stub.fetch(req);
    }

    const m = url.pathname.match(/^\/b\/([a-z0-9-]{1,40})(\/.*)$/);
    if (m) {
      // 3b: per-user membership check lands HERE in M2 — before the DO is touched.
      // Non-members must get the same 403 whether the business exists or not.
      const stub = env.BUSINESS_DO.get(env.BUSINESS_DO.idFromName(m[1]));
      return stub.fetch(req);
    }

    return json({ error: 'not found' }, 404);
  },
};
