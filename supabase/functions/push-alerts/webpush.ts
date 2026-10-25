// Web Push sans dépendance (Web Crypto seulement : fonctionne dans Deno et dans Node ≥ 20).
// VAPID (RFC 8292) : jeton ES256 signé par la clé privée du serveur. Chiffrement aes128gcm (RFC 8291 / RFC 8188).

const te = new TextEncoder();
export const b64u = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ''; for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64u = (s: string) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/'), p = t + '='.repeat((4 - t.length % 4) % 4);
  return Uint8Array.from(atob(p), c => c.charCodeAt(0));
};
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

export type VapidKeys = { pub: string; priv: JsonWebKey };
// Nouvelle paire VAPID : clé publique brute (65 octets, base64url, donnée au navigateur) et clé privée en JWK (gardée en base).
export async function vapidGenerate(): Promise<VapidKeys> {
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = await crypto.subtle.exportKey('raw', k.publicKey);
  const priv = await crypto.subtle.exportKey('jwk', k.privateKey);
  return { pub: b64u(raw), priv };
}

async function vapidAuth(endpoint: string, keys: VapidKeys, subject: string) {
  const aud = new URL(endpoint).origin, exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const enc = (o: unknown) => b64u(te.encode(JSON.stringify(o)));
  const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud, exp, sub: subject });
  const key = await crypto.subtle.importKey('jwk', keys.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(unsigned)); // r || s (64 octets)
  return `vapid t=${unsigned}.${b64u(sig)}, k=${keys.pub}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}

// Corps chiffré pour un abonnement (p256dh = clé publique du navigateur, auth = secret de 16 octets).
export async function encrypt(payload: Uint8Array, p256dh: string, auth: string, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const ua = unb64u(p256dh), secret = unb64u(auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(secret, shared, cat(te.encode('WebPush: info\0'), ua, asPub), 32);
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

export type Sub = { endpoint: string; p256dh: string; auth: string };
// Envoi d'une notification. Rend le statut HTTP du service de push (201 = remis ; 404 / 410 = abonnement expiré).
export async function sendPush(sub: Sub, data: unknown, keys: VapidKeys, subject: string, ttl = 12 * 3600): Promise<number> {
  const body = await encrypt(te.encode(JSON.stringify(data)), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST', body,
    headers: { 'Authorization': await vapidAuth(sub.endpoint, keys, subject), 'TTL': String(ttl), 'Urgency': 'normal',
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' },
  });
  await res.arrayBuffer().catch(() => null);
  return res.status;
}
