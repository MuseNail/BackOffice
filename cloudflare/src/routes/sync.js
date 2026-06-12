// ── route: POST /sync/inbound — Muse → Back Office one-way sync (kickoff §5) ────
// Machine route: authenticated by the SYNC_TOKEN Worker secret (a bearer Muse's
// push hook holds), NOT a user session — it runs before the session middleware.
// Rows land STAGED in the target business's DO, keyed on sourceApp+sourceId so a
// re-push is a no-op; nothing posts to the ledger without owner approval there.
// There is no outbound counterpart anywhere — "no destructive sync back" stays
// structural.

import { shapeSyncBatch } from '../../../js/app/lib/musesync.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

function timingSafeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function handleSyncInbound(req, env) {
  if (!env.SYNC_TOKEN) return json({ error: 'sync not configured' }, 503);
  const presented = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!presented || !timingSafeEq(presented, env.SYNC_TOKEN)) return json({ error: 'unauthorized' }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const { sourceApp, businessId, rows } = body || {};
  if (!/^[a-z0-9-]{1,40}$/.test(businessId || '')) return json({ error: 'bad businessId' }, 400);

  const shaped = shapeSyncBatch(sourceApp, rows);
  if (shaped.error) return json({ error: shaped.error }, 400);

  // A typo'd businessId would silently stage rows into an orphan DO the owner
  // never sees — fail loudly instead. (Behind SYNC_TOKEN, so no enumeration
  // concern; browsers never reach this check.)
  const reg = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName('global'));
  const ex = await (await reg.fetch(new Request('https://do/registry/_exists', {
    method: 'POST',
    body: JSON.stringify({ businessId }),
    headers: { 'Content-Type': 'application/json' },
  }))).json();
  if (!ex.exists) return json({ error: 'unknown businessId' }, 404);

  const stub = env.BUSINESS_DO.get(env.BUSINESS_DO.idFromName(businessId));
  const res = await stub.fetch(new Request('https://do/b/x/_sync/inbound', {
    method: 'POST',
    body: JSON.stringify({ rows: shaped.rows }),
    headers: { 'Content-Type': 'application/json' },
  }));
  return json(await res.json(), res.status);
}
