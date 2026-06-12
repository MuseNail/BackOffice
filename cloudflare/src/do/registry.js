// ── RegistryDO — users, sessions, memberships, devices, business directory ──
// Keys:
//   business:<id>                 {id, name, industry, createdAt}
//   user:<id>                     {id, name, identifier, pinHash, pinSalt, isOwner, createdAt}
//   ident:<identifier>            userId  (login lookup)
//   membership:<userId>:<bizId>   {userId, businessId, role}
//   session:<token>               {userId, deviceId, createdAt, expiresAt}
//   device:<userId>:<deviceId>    {status:'approved'|'pending', name, createdAt}
//   rl:<identifier>               {fails, until}  (login rate limit)
//
// Visibility rule (kickoff 3b): every response is filtered to the caller's
// memberships — a client's session NEVER carries another business's name or id.
// The app owner (isOwner) implicitly belongs to every business as 'owner'.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

const ROLES = ['owner', 'manager', 'bookkeeper', 'viewer'];
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const LOCKOUT_FAILS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const bufToHex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randHex = (n) => bufToHex(crypto.getRandomValues(new Uint8Array(n)).buffer);

async function hashPin(pin, saltHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return bufToHex(bits);
}

export class RegistryDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === '/auth/status' && req.method === 'GET') return this.status();
      if (p === '/auth/bootstrap' && req.method === 'POST') return this.bootstrap(await req.json());
      if (p === '/auth/login' && req.method === 'POST') return this.login(await req.json());
      if (p === '/auth/logout' && req.method === 'POST') return this.logout(req);
      if (p === '/registry/_resolve' && req.method === 'POST') return this.resolveRoute(await req.json());
      // Internal (sync route only — the Worker 404s /registry/_* for browsers):
      // lets /sync/inbound fail loudly on a typo'd businessId instead of staging
      // rows into an orphan DO nobody ever looks at.
      if (p === '/registry/_exists' && req.method === 'POST') {
        const { businessId } = await req.json();
        return json({ exists: !!(businessId && await this.state.storage.get(`business:${businessId}`)) });
      }

      // everything below requires a session
      const sess = await this.resolve(bearer(req));
      if (!sess) return json({ error: 'unauthorized' }, 401);

      if (p === '/registry/businesses' && req.method === 'GET') return this.listBusinesses(sess);
      if (p === '/registry/businesses' && req.method === 'POST') return this.createBusiness(sess, await req.json());
      if (p === '/registry/users' && req.method === 'GET') return this.listUsers(sess, url.searchParams.get('businessId'));
      if (p === '/registry/users' && req.method === 'POST') return this.createUser(sess, await req.json());
      if (p === '/registry/devices' && req.method === 'GET') return this.listDevices(sess, url.searchParams.get('businessId'));
      if (p === '/registry/devices/approve' && req.method === 'POST') return this.setDevice(sess, await req.json(), 'approved');
      if (p === '/registry/devices/revoke' && req.method === 'POST') return this.setDevice(sess, await req.json(), 'revoked');

      return json({ error: 'not found' }, 404);
    } catch (e) {
      console.error('[registry]', e);
      return json({ error: 'server error' }, 500);
    }
  }

  // ── auth ──
  async status() {
    const users = await this.state.storage.list({ prefix: 'user:', limit: 1 });
    return json({ bootstrapped: users.size > 0 });
  }

  // First account ever = the app owner. Only possible while no users exist.
  async bootstrap(body) {
    const users = await this.state.storage.list({ prefix: 'user:', limit: 1 });
    if (users.size > 0) return json({ error: 'already bootstrapped' }, 409);
    const { name, identifier, pin, deviceId, deviceName } = body;
    if (!name || !valIdent(identifier) || !valPin(pin) || !deviceId) return json({ error: 'bad request' }, 400);
    const user = await this.makeUser({ name, identifier, pin, isOwner: true });
    await this.state.storage.put(`device:${user.id}:${deviceId}`, { status: 'approved', name: deviceName || '', createdAt: Date.now() });
    return this.issueSession(user, deviceId);
  }

  async login(body) {
    const { identifier, pin, deviceId, deviceName } = body;
    const ident = String(identifier || '').toLowerCase().trim();
    if (!ident || !pin || !deviceId) return json({ error: 'bad request' }, 400);

    const rl = (await this.state.storage.get(`rl:${ident}`)) || { fails: 0, until: 0 };
    if (rl.until > Date.now()) return json({ error: 'locked', retryInMin: Math.ceil((rl.until - Date.now()) / 60000) }, 423);

    const userId = await this.state.storage.get(`ident:${ident}`);
    const user = userId ? await this.state.storage.get(`user:${userId}`) : null;
    const ok = user && (await hashPin(String(pin), user.pinSalt)) === user.pinHash;
    if (!ok) {
      rl.fails++;
      if (rl.fails >= LOCKOUT_FAILS) { rl.until = Date.now() + LOCKOUT_MS; rl.fails = 0; }
      await this.state.storage.put(`rl:${ident}`, rl);
      return json({ error: 'invalid login' }, 401);
    }
    await this.state.storage.delete(`rl:${ident}`);

    // Device enrollment: a user's first device self-enrolls; later devices wait
    // for an owner/manager to approve them (kickoff 3b client-login hardening).
    const devKey = `device:${user.id}:${deviceId}`;
    const dev = await this.state.storage.get(devKey);
    if (!dev) {
      const existing = await this.state.storage.list({ prefix: `device:${user.id}:` });
      const hasApproved = [...existing.values()].some(d => d.status === 'approved');
      await this.state.storage.put(devKey, { status: hasApproved ? 'pending' : 'approved', name: deviceName || '', createdAt: Date.now() });
      if (hasApproved) return json({ error: 'device_pending' }, 403);
    } else if (dev.status !== 'approved') {
      return json({ error: 'device_pending' }, 403);
    }

    return this.issueSession(user, deviceId);
  }

  async logout(req) {
    const token = bearer(req);
    if (token) await this.state.storage.delete(`session:${token}`);
    return json({ ok: true });
  }

  async issueSession(user, deviceId) {
    const token = randHex(32);
    await this.state.storage.put(`session:${token}`, { userId: user.id, deviceId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL });
    const businesses = await this.businessesFor(user);
    return json({
      token,
      user: { id: user.id, name: user.name, identifier: user.identifier, isOwner: !!user.isOwner },
      businesses,
    });
  }

  async resolve(token) {
    if (!token) return null;
    const sess = await this.state.storage.get(`session:${token}`);
    if (!sess) return null;
    if (sess.expiresAt < Date.now()) { await this.state.storage.delete(`session:${token}`); return null; }
    const user = await this.state.storage.get(`user:${sess.userId}`);
    if (!user) return null;
    const memberships = {};
    for (const m of (await this.state.storage.list({ prefix: `membership:${user.id}:` })).values()) {
      memberships[m.businessId] = m.role;
    }
    return { userId: user.id, name: user.name, isOwner: !!user.isOwner, memberships };
  }

  // Internal route for the Worker's middleware — index.js never exposes it.
  async resolveRoute(body) {
    const sess = await this.resolve(body.token);
    return sess ? json({ ok: true, ...sess }) : json({ ok: false }, 401);
  }

  // ── businesses ──
  async businessesFor(user) {
    const all = [...(await this.state.storage.list({ prefix: 'business:' })).values()];
    if (user.isOwner) return all.map(b => ({ ...b, role: 'owner' }));
    const out = [];
    for (const b of all) {
      const m = await this.state.storage.get(`membership:${user.id}:${b.id}`);
      if (m) out.push({ ...b, role: m.role });
    }
    return out;
  }

  async listBusinesses(sess) {
    const user = await this.state.storage.get(`user:${sess.userId}`);
    return json({ businesses: await this.businessesFor(user) });
  }

  async createBusiness(sess, b) {
    if (!sess.isOwner) return json({ error: 'forbidden' }, 403);
    const id = String(b.id || '').toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(id) || !b.name) return json({ error: 'bad business' }, 400);
    if (await this.state.storage.get(`business:${id}`)) return json({ error: 'exists' }, 409);
    const record = { id, name: b.name, industry: b.industry || 'general', createdAt: b.createdAt || Date.now() };
    await this.state.storage.put(`business:${id}`, record);
    return json({ ok: true, business: record });
  }

  // ── users ──
  canManage(sess, businessId) {
    return sess.isOwner || ['owner', 'manager'].includes(sess.memberships[businessId]);
  }

  async makeUser({ name, identifier, pin, isOwner = false }) {
    const ident = String(identifier).toLowerCase().trim();
    const id = 'u-' + randHex(6);
    const pinSalt = randHex(16);
    const user = { id, name, identifier: ident, pinHash: await hashPin(String(pin), pinSalt), pinSalt, isOwner, createdAt: Date.now() };
    await this.state.storage.put(`user:${id}`, user);
    await this.state.storage.put(`ident:${ident}`, id);
    return user;
  }

  async listUsers(sess, businessId) {
    if (!businessId || !this.canManage(sess, businessId)) return json({ error: 'forbidden' }, 403);
    const out = [];
    for (const m of (await this.state.storage.list({ prefix: 'membership:' })).values()) {
      if (m.businessId !== businessId) continue;
      const u = await this.state.storage.get(`user:${m.userId}`);
      if (u) out.push({ id: u.id, name: u.name, identifier: u.identifier, role: m.role });
    }
    return json({ users: out });
  }

  async createUser(sess, body) {
    const { businessId, name, identifier, pin, role } = body;
    if (!businessId || !this.canManage(sess, businessId)) return json({ error: 'forbidden' }, 403);
    if (!name || !valIdent(identifier) || !valPin(pin) || !ROLES.includes(role)) return json({ error: 'bad request' }, 400);
    const ident = String(identifier).toLowerCase().trim();
    if (await this.state.storage.get(`ident:${ident}`)) return json({ error: 'identifier taken' }, 409);
    const user = await this.makeUser({ name, identifier: ident, pin });
    await this.state.storage.put(`membership:${user.id}:${businessId}`, { userId: user.id, businessId, role });
    return json({ ok: true, user: { id: user.id, name: user.name, identifier: ident, role } });
  }

  // ── devices ──
  // App-owner accounts have no membership rows (they belong to everything
  // implicitly), so their devices appear in every business's device list —
  // but ONLY to other owner sessions: a business manager must never be able
  // to approve a device that would carry owner powers.
  async listDevices(sess, businessId) {
    if (!businessId || !this.canManage(sess, businessId)) return json({ error: 'forbidden' }, 403);
    const members = new Map();
    for (const m of (await this.state.storage.list({ prefix: 'membership:' })).values()) {
      if (m.businessId === businessId) members.set(m.userId, m.role);
    }
    const owners = new Set();
    if (sess.isOwner) {
      for (const u of (await this.state.storage.list({ prefix: 'user:' })).values()) {
        if (u.isOwner) owners.add(u.id);
      }
    }
    const out = [];
    for (const [k, d] of await this.state.storage.list({ prefix: 'device:' })) {
      const [, userId, deviceId] = k.split(':');
      if (!members.has(userId) && !owners.has(userId)) continue;
      const u = await this.state.storage.get(`user:${userId}`);
      out.push({ userId, userName: (u?.name || '?') + (u?.isOwner ? ' (owner)' : ''), deviceId, ...d });
    }
    return json({ devices: out });
  }

  async setDevice(sess, body, status) {
    const { businessId, userId, deviceId } = body;
    if (!businessId || !this.canManage(sess, businessId)) return json({ error: 'forbidden' }, 403);
    const target = await this.state.storage.get(`user:${userId}`);
    if (target?.isOwner) {
      if (!sess.isOwner) return json({ error: 'forbidden' }, 403);
    } else {
      const m = await this.state.storage.get(`membership:${userId}:${businessId}`);
      if (!m) return json({ error: 'forbidden' }, 403);
    }
    const key = `device:${userId}:${deviceId}`;
    const dev = await this.state.storage.get(key);
    if (!dev) return json({ error: 'not found' }, 404);
    if (status === 'revoked') await this.state.storage.delete(key);
    else await this.state.storage.put(key, { ...dev, status });
    return json({ ok: true });
  }
}

const bearer = (req) => (req.headers.get('Authorization') || '').replace(/^Bearer /, '') || null;
const valIdent = (s) => /^[a-z0-9._-]{2,30}$/.test(String(s || '').toLowerCase().trim());
const valPin = (p) => /^\d{4,8}$/.test(String(p || ''));
