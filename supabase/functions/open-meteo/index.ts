import { createClient } from 'npm:@supabase/supabase-js@2';

// Sillage : relais vers l'API Open-Meteo payante (abonnement « API Standard » depuis le 29/10/2026).
// La clé reste côté serveur (secret OPENMETEO_API_KEY) ; la page ne connaît que ce relais.
// POST { q } avec le jeton de session d'un compte connecté (rôle « authenticated » ; la clé publique seule est refusée).
//   q = la chaîne de requête de /v1/forecast (latitude=…&longitude=…&hourly=…), sans clé.
//   → réponse JSON d'Open-Meteo telle quelle (même statut), en-tête x-om: hit | miss.
// POST { ping: true } → { ok, status } : vérifie que la clé est acceptée (petite requête, jamais la clé renvoyée).
// Cache partagé entre tous les comptes : table om_cache (clé = SHA-256 de q), 30 min.
// Compteur : om_usage (demandes, réponses du cache, appels décomptés par Open-Meteo, estimés comme eux :
// par lieu, max(1, variables / 10) × max(1, jours / 14)).
// Quota par compte et par jour (UTC) depuis le 29/10/2026 : app_users.quota_om (appels décomptés, null = sans limite),
// compteur om_user_day via om_user_add, seulement quand on appelle vraiment Open-Meteo (le cache ne compte pas).
// Quota atteint → 429 { error, reason: 'quota', relay: true }, en-tête x-om: quota (la page n'essaie pas l'API gratuite).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': 'x-om',
};
const out = (body: string, status: number, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } });
const err = (e: string, status: number) => out(JSON.stringify({ error: true, reason: e, relay: true }), status);

const API = 'https://customer-api.open-meteo.com/v1/forecast';
const TTL = 30 * 60e3;
const MAX_BODY = 4_000_000;

function claims(jwt: string): { role?: string; sub?: string } {
  try { return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (_) { return {}; }
}
async function sha(s: string) {
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
function calls(q: string) {
  const p = new URLSearchParams(q);
  const loc = (p.get('latitude') || '').split(',').filter(Boolean).length || 1;
  const vars = (p.get('hourly') || '').split(',').filter(Boolean).length || 1;
  let days = Number(p.get('forecast_days')) || 7;
  const a = p.get('start_date'), b = p.get('end_date');
  if (a && b) days = Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
  return loc * Math.max(1, vars / 10) * Math.max(1, days / 14);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return err('method', 405);
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const who = claims(jwt);
  if (who.role !== 'authenticated' || !who.sub) return err('auth', 401); // signature déjà vérifiée par la passerelle (verify_jwt)
  const key = (Deno.env.get('OPENMETEO_API_KEY') || '').trim();
  if (!key) return err('config', 500);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { return err('body', 400); }

  if (body.ping === true) {
    const r = await fetch(`${API}?latitude=48.58&longitude=7.75&hourly=temperature_2m&forecast_days=1&apikey=${encodeURIComponent(key)}`);
    const t = await r.text();
    let reason = ''; if (!r.ok) { try { reason = String(JSON.parse(t).reason || '').slice(0, 160); } catch (_) { /* */ } }
    return out(JSON.stringify({ ok: r.ok, status: r.status, reason }), 200);
  }

  const q = typeof body.q === 'string' ? body.q : '';
  if (!q || q.length > 12000 || !/^latitude=[-0-9.,]+&longitude=[-0-9.,]+&[A-Za-z0-9_=&,.:%-]+$/.test(q) || /(^|&)apikey=/i.test(q)) return err('query', 400);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const k = await sha(q);
  const { data: hit } = await db.from('om_cache').select('body,exp').eq('key', k).maybeSingle();
  if (hit && Date.parse(hit.exp) > Date.now()) {
    await db.rpc('om_count', { n: 0, hit: true }).then(() => {}, () => {});
    return out(hit.body, 200, { 'x-om': 'hit' });
  }

  const n = calls(q);
  const day = new Date().toISOString().slice(0, 10);
  const [{ data: acc }, { data: used }] = await Promise.all([
    db.from('app_users').select('quota_om,status').eq('user_id', who.sub).maybeSingle(),
    db.from('om_user_day').select('calls').eq('user_id', who.sub).eq('day', day).maybeSingle(),
  ]);
  const quota = acc && acc.status === 'active' ? acc.quota_om : 0; // compte en attente, bloqué ou sans fiche : rien
  if (quota != null && Number(used?.calls || 0) + n > quota) {
    return out(JSON.stringify({ error: true, reason: 'quota', relay: true, used: Number(used?.calls || 0), quota }), 429, { 'x-om': 'quota' });
  }

  let r: Response;
  try { r = await fetch(`${API}?${q}&apikey=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(35000) }); }
  catch (_) { return err('upstream', 504); }
  const t = await r.text();
  // attendus avant de répondre (le moteur peut s'arrêter dès la réponse envoyée)
  await Promise.all([
    db.rpc('om_count', { n, hit: false }).then(() => {}, () => {}),
    r.ok ? db.rpc('om_user_add', { uid: who.sub, n }).then(() => {}, () => {}) : null,
    r.ok && t.length < MAX_BODY
      ? db.from('om_cache').upsert({ key: k, body: t, exp: new Date(Date.now() + TTL).toISOString(), updated_at: new Date().toISOString() }).then(() => {}, () => {})
      : null,
  ]);
  return out(t, r.status, { 'x-om': 'miss' });
});
