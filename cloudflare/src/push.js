// ── push.js — Web Push (VAPID ES256 + RFC 8291 aes128gcm), WebCrypto only ────────
// Ported from the Muse worker's proven implementation. Subscriptions are stored by the
// caller under 'push:<id>:<hash>' in the system Durable Object; sendPush() reads them,
// signs a VAPID JWT per endpoint, encrypts the {title,body,tag} payload, and POSTs it.
// A payload-less push falls back to the service worker's generic text.

export function b64urlFromBytes(bytes) {
  const b = new Uint8Array(bytes); let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlFromStr(str) { return b64urlFromBytes(new TextEncoder().encode(str)); }
function b64urlToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
function vapidJwtUnsigned(aud, sub, expSec) {
  return b64urlFromStr(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.' +
         b64urlFromStr(JSON.stringify({ aud, exp: expSec, sub }));
}
async function vapidJwt(privJwkStr, aud, sub) {
  const key = await crypto.subtle.importKey('jwk', JSON.parse(privJwkStr), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const unsigned = vapidJwtUnsigned(aud, sub, Math.floor(Date.now() / 1000) + 12 * 3600);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return unsigned + '.' + b64urlFromBytes(sig);   // WebCrypto ECDSA = raw r‖s, exactly what ES256 wants
}
export async function pushKeyHash(endpoint) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}
// RFC 8291 Web Push payload encryption (aes128gcm). `sub` is the stored PushSubscription
// JSON (endpoint + keys.p256dh/auth); returns header‖ciphertext for Content-Encoding: aes128gcm.
export async function encryptPushPayload(sub, payloadStr) {
  const enc = new TextEncoder();
  const uaPub = b64urlToBytes(sub.keys.p256dh);
  const authSecret = b64urlToBytes(sub.keys.auth);
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));
  const hkdf = async (salt, ikmBytes, info, len) => {
    const key = await crypto.subtle.importKey('raw', ikmBytes, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
  };
  const keyInfo = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPub, ...asPub]);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = new Uint8Array([...enc.encode(payloadStr), 2]);   // 0x02 = final-record delimiter
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plain));
  const header = new Uint8Array(16 + 4 + 1 + 65);                 // salt ‖ rs ‖ idlen ‖ as_public
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(asPub, 21);
  const body = new Uint8Array(header.length + cipher.length);
  body.set(header, 0);
  body.set(cipher, header.length);
  return body;
}

// Push to every device subscribed under `id` (e.g. 'errors'); prune dead subs.
// `storage` = the system DO's state.storage; `env` holds the VAPID keys.
export async function sendPush(storage, env, id, payload) {
  if (!env.VAPID_PRIVATE_KEY) return;
  const subs = await storage.list({ prefix: 'push:' + id + ':' });
  if (subs.size === 0) return;
  const subject = env.VAPID_SUBJECT || 'mailto:info@musenailandspa.com';
  const pub = env.VAPID_PUBLIC_KEY || '';
  const payloadStr = payload ? JSON.stringify(payload) : null;
  await Promise.all([...subs.entries()].map(async ([key, sub]) => {
    try {
      if (!sub || !sub.endpoint) { await storage.delete(key); return; }
      const jwt = await vapidJwt(env.VAPID_PRIVATE_KEY, new URL(sub.endpoint).origin, subject);
      const headers = { Authorization: `vapid t=${jwt}, k=${pub}`, TTL: '2592000' };
      let body;
      if (payloadStr && sub.keys && sub.keys.p256dh && sub.keys.auth) {
        try {
          body = await encryptPushPayload(sub, payloadStr);
          headers['Content-Encoding'] = 'aes128gcm';
          headers['Content-Type'] = 'application/octet-stream';
        } catch { body = undefined; }
      }
      const res = await fetch(sub.endpoint, { method: 'POST', headers, body });
      if (res.status === 404 || res.status === 410) await storage.delete(key);
      else if (!res.ok) console.warn('[push]', res.status, id);
    } catch (e) { console.error('[push] send failed:', (e && e.message) || String(e)); }
  }));
}
