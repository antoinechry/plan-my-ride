import { createClient } from 'jsr:@supabase/supabase-js@2';

// Plan My Ride : relais vers MET Norway (api.met.no, Locationforecast 2.0 « complete »), avec un cache partagé
// entre tous les visiteurs (table `met_cache`, clé de service seulement). Conforme aux conditions de met.no :
// User-Agent identifiant le site, coordonnées à 3 décimales, pas de nouvelle demande avant l'en-tête Expires,
// puis If-Modified-Since avec la valeur Last-Modified reçue ; arrêt immédiat en cas de 429.
// POST { points: [{ lat, lon, asl? }] } (40 au plus) → { ok, points: [{ key, at, exp, data }], fetched, cached }
// `data` = réponse allégée de la même forme que celle de met.no (properties.timeseries[].data…).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const UA = 'plan-my-ride/1.0 https://github.com/antoinechry/plan-my-ride';
const MAX_POINTS = 40, PAR = 4, MIN_TTL = 30 * 60e3, KEEP_DAYS = 3;

type Pt = { lat: number; lon: number; asl: number | null; key: string };
type Row = { key: string; data: unknown; last_modified: string | null; exp: string; updated_at: string };

const r3 = (v: number) => Math.round(v * 1000) / 1000;
function cleanPoint(p: Record<string, unknown>): Pt | null {
  const lat = Number(p.lat), lon = Number(p.lon);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const a = p.asl == null ? null : Number(p.asl);
  const asl = a != null && isFinite(a) && a > -500 && a < 9000 ? Math.round(a / 10) * 10 : null;
  const la = r3(lat), lo = r3(lon);
  return { lat: la, lon: lo, asl, key: `${la.toFixed(3)},${lo.toFixed(3)},${asl ?? ''}` };
}

// On ne garde que ce que la page utilise : température, humidité, nébulosité, vent, rafales ; pluie, probabilité et
// symbole sur 1 h et 6 h.
function slim(j: Record<string, any>) {
  const ts = j?.properties?.timeseries;
  if (!Array.isArray(ts) || ts.length < 2) return null;
  const keep = ['air_temperature', 'relative_humidity', 'cloud_area_fraction', 'wind_speed', 'wind_from_direction', 'wind_speed_of_gust'];
  const per = (h: any) => h ? { summary: { symbol_code: h.summary?.symbol_code }, details: {
    precipitation_amount: h.details?.precipitation_amount, probability_of_precipitation: h.details?.probability_of_precipitation } } : undefined;
  return { properties: { meta: { updated_at: j.properties?.meta?.updated_at }, timeseries: ts.map((e: any) => {
    const d = e?.data || {}, inst: Record<string, number> = {};
    for (const k of keep) if (d.instant?.details?.[k] != null) inst[k] = d.instant.details[k];
    const out: Record<string, unknown> = { instant: { details: inst } };
    if (d.next_1_hours) out.next_1_hours = per(d.next_1_hours);
    if (d.next_6_hours) out.next_6_hours = per(d.next_6_hours);
    return { time: e.time, data: out };
  }) } };
}

class Throttled extends Error {}

async function fetchMet(p: Pt, prev: Row | undefined) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${p.lat.toFixed(3)}&lon=${p.lon.toFixed(3)}` + (p.asl != null ? `&altitude=${p.asl}` : '');
  const headers: Record<string, string> = { 'User-Agent': UA, 'Accept': 'application/json' };
  if (prev?.last_modified) headers['If-Modified-Since'] = prev.last_modified;
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 20000);
  let res: Response;
  try { res = await fetch(url, { headers, signal: ctl.signal }); } finally { clearTimeout(tm); }
  if (res.status === 429) throw new Throttled('met.no limite les demandes');
  const exp = new Date(Math.max(Date.now() + MIN_TTL, Date.parse(res.headers.get('Expires') || '') || 0)).toISOString();
  if (res.status === 304 && prev) return { data: prev.data, last_modified: prev.last_modified, exp, changed: false };
  if (!res.ok) throw new Error(`met.no a répondu ${res.status}`);
  const data = slim(await res.json());
  if (!data) throw new Error('réponse incomplète de met.no');
  return { data, last_modified: res.headers.get('Last-Modified'), exp, changed: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { return json({ error: 'body' }, 400); }
  const raw = Array.isArray(body.points) ? body.points : [];
  if (!raw.length || raw.length > MAX_POINTS) return json({ error: 'bad_points', max: MAX_POINTS }, 400);
  const pts = raw.map(p => cleanPoint((p || {}) as Record<string, unknown>));
  if (pts.some(p => !p)) return json({ error: 'bad_points' }, 400);
  const list = pts as Pt[];
  const uniq = [...new Map(list.map(p => [p.key, p])).values()];

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: rows, error } = await sb.from('met_cache').select('key,data,last_modified,exp,updated_at').in('key', uniq.map(p => p.key));
  if (error) return json({ error: 'db', detail: error.message }, 500);
  const have = new Map<string, Row>((rows || []).map((r: Row) => [r.key, r]));
  const now = Date.now();
  const todo = uniq.filter(p => { const r = have.get(p.key); return !r || Date.parse(r.exp) <= now; });

  // demandes à met.no, PAR à la fois ; un 429 arrête tout de suite les suivantes
  let next = 0, fetched = 0, throttled = false;
  const failed: string[] = [];
  const writes: Record<string, unknown>[] = [];
  const worker = async () => {
    while (next < todo.length && !throttled) {
      const p = todo[next++], prev = have.get(p.key);
      try {
        const r = await fetchMet(p, prev);
        fetched++;
        const row = { key: p.key, data: r.data, last_modified: r.last_modified, exp: r.exp, updated_at: new Date().toISOString() };
        have.set(p.key, row as Row);
        writes.push(row);
      } catch (e) {
        if (e instanceof Throttled) throttled = true;
        // une prévision encore récente fait l'affaire si met.no ne répond pas
        if (!(prev && now - Date.parse(prev.updated_at) < 6 * 3600e3)) failed.push(p.key);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAR, todo.length) }, worker));
  if (writes.length) await sb.from('met_cache').upsert(writes);
  // ménage de temps en temps : prévisions de plus de KEEP_DAYS jours
  if (Math.random() < 0.05) await sb.from('met_cache').delete().lt('updated_at', new Date(now - KEEP_DAYS * 864e5).toISOString());

  const missing = list.filter(p => !have.has(p.key) || failed.includes(p.key));
  if (missing.length) return json({ error: throttled ? 'throttled' : 'unavailable', missing: missing.length }, throttled ? 429 : 502);
  return json({ ok: true, fetched, cached: uniq.length - fetched, points: list.map(p => {
    const r = have.get(p.key)!;
    return { key: p.key, at: Date.parse(r.updated_at), exp: Date.parse(r.exp), data: r.data };
  }) });
});
