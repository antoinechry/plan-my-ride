import { createClient } from 'jsr:@supabase/supabase-js@2';

// Plan My Ride : mesure d'audience de la version publique (table `pmr_visits`).
// La page envoie { event: 'visit' | 'gpx', visitor, mode, device, km? } avec la clé publique (anon).
// La fonction déduit une localisation approximative (pays, région, département, ville) de l'adresse IP de la
// requête via un service de géolocalisation (ipapi.co, à défaut ipwho.is), puis enregistre la ligne.
// L'adresse IP n'est jamais stockée ni renvoyée. Une localisation est gardée 1 h en mémoire par IP pour
// limiter les appels au service.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

type Geo = { country: string | null; region: string | null; dept: string | null; city: string | null };
const CACHE = new Map<string, { at: number; geo: Geo }>();

// Département français tiré du code postal (Corse : 2A / 2B ; outre-mer : 3 chiffres).
function deptFrom(country: string | null, postal: string | null): string | null {
  if (country !== 'FR' || !postal || !/^\d{5}$/.test(postal)) return null;
  if (postal.startsWith('97') || postal.startsWith('98')) return postal.slice(0, 3);
  if (postal.startsWith('20')) return +postal < 20200 ? '2A' : '2B';
  return postal.slice(0, 2);
}
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);

async function locate(ip: string): Promise<Geo> {
  const none: Geo = { country: null, region: null, dept: null, city: null };
  if (!ip) return none;
  const hit = CACHE.get(ip);
  if (hit && Date.now() - hit.at < 3600e3) return hit.geo;
  let geo = none;
  const get = async (url: string) => {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 2500);
    try { const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'plan-my-ride' } }); return r.ok ? await r.json() : null; }
    catch (_) { return null; } finally { clearTimeout(tm); }
  };
  const a = await get(`https://ipapi.co/${encodeURIComponent(ip)}/json/`) as Record<string, unknown> | null;
  if (a && !a.error && a.country_code) {
    const c = str(a.country_code);
    geo = { country: c, region: str(a.region), city: str(a.city), dept: deptFrom(c, str(a.postal)) };
  } else {
    const b = await get(`https://ipwho.is/${encodeURIComponent(ip)}`) as Record<string, unknown> | null;
    if (b && b.success !== false && b.country_code) {
      const c = str(b.country_code);
      geo = { country: c, region: str(b.region), city: str(b.city), dept: deptFrom(c, str(b.postal)) };
    }
  }
  CACHE.set(ip, { at: Date.now(), geo });
  if (CACHE.size > 500) CACHE.delete(CACHE.keys().next().value!);
  return geo;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { return json({ error: 'body' }, 400); }
  const event = body.event === 'gpx' ? 'gpx' : body.event === 'visit' ? 'visit' : null;
  const visitor = typeof body.visitor === 'string' && /^[a-z0-9]{8,24}$/.test(body.visitor) ? body.visitor : null;
  if (!event || !visitor) return json({ error: 'bad_request' }, 400);
  const mode = body.mode === 'ultra' ? 'ultra' : 'ride';
  const device = body.device === 'mobile' ? 'mobile' : 'desktop';
  const km = typeof body.km === 'number' && isFinite(body.km) && body.km >= 0 && body.km < 20000 ? Math.round(body.km) : null;

  const ip = (req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0] || '').trim();
  const geo = await locate(ip);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { error } = await sb.from('pmr_visits').insert({ event, visitor, mode, device, km, ...geo });
  if (error) return json({ error: 'db', detail: error.message }, 500);
  return json({ ok: true });
});
