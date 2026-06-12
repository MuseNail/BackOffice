// ── RegistryDO — global business directory + memberships ──
// Keys: `business:<id>` = {id, name, industry, createdAt}
//       `membership:<userId>:<businessId>` = {role}   (used from M2)
// The Worker consults this BEFORE routing to a BusinessDO — visibility rule 3b:
// a user's responses only ever contain businesses they belong to.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

export class RegistryDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/registry/businesses' && req.method === 'GET') {
      const list = [...(await this.state.storage.list({ prefix: 'business:' })).values()];
      return json({ businesses: list });
    }

    if (url.pathname === '/registry/businesses' && req.method === 'POST') {
      const b = await req.json();
      const id = String(b.id || '').toLowerCase();
      if (!/^[a-z0-9-]{2,40}$/.test(id) || !b.name) return json({ error: 'bad business' }, 400);
      const key = `business:${id}`;
      if (await this.state.storage.get(key)) return json({ error: 'exists' }, 409);
      const record = { id, name: b.name, industry: b.industry || 'general', createdAt: b.createdAt || 0 };
      await this.state.storage.put(key, record);
      return json({ ok: true, business: record });
    }

    return json({ error: 'not found' }, 404);
  }
}
