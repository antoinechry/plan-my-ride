import { createClient } from 'npm:@supabase/supabase-js@2';

// Sillage : base de départ des points OpenStreetMap de la carte des points utiles (31/10/2026).
// Appelée par pg_cron (tâche « sillage-osm-import »), en-tête x-cron-token (table push_keys).
// Prend le prochain carré de osm_tiles (osm_tile_claim), demande ses points à Overpass (4 serveurs en même temps),
// garde les 8 types de la carte et les étiquettes utiles, puis remplace les points du carré (osm_tile_store).
// Carré trop lourd pour Overpass : coupé en 4 (osm_tile_split). Carrés refaits au bout de 7 jours.
//   POST { n?: nombre de carrés (1 par défaut, 2 au plus) }  → { done: [{ key, n }], errors: [...] }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const SERVERS = [
  'https://overpass.openstreetmap.fr/api/interpreter', // OSM France : le seul qui répondait le 31/10/2026
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const KEEP = ['name', 'opening_hours', 'addr:housenumber', 'addr:street', 'addr:city', 'phone', 'website', 'drinking_water', 'seasonal', 'fee',
  'backcountry', 'camp_site', 'amenity', 'shop', 'tourism', 'man_made', 'bicycle', 'shelter_type'];

type Tags = Record<string, string>;
function classify(t: Tags): string | null { // même classement que pmClassify dans test.html
  const a = t.amenity || '', s = t.shop || '', tr = t.tourism || '';
  if (a === 'drinking_water' || a === 'water_point' || ((a === 'fountain' || t.man_made === 'water_tap') && t.drinking_water === 'yes')) return 'fontaine';
  if (s === 'bakery' || s === 'pastry') return 'boulangerie';
  if (/^(convenience|supermarket|general|greengrocer|farm)$/.test(s)) return 'epicerie';
  if (tr === 'camp_site' || tr === 'camp_pitch') return 'bivouac';
  if (tr === 'wilderness_hut' || tr === 'alpine_hut' || (a === 'shelter' && !/public_transport|parking|field/.test(t.shelter_type || ''))) return 'abri';
  if (/^(cafe|restaurant|fast_food|pub|bar)$/.test(a)) return 'cafe';
  if (s === 'bicycle' || a === 'bicycle_repair_station') return 'atelier';
  if (a === 'device_charging_station' || (a === 'charging_station' && /^(yes|designated)$/.test(t.bicycle || ''))) return 'recharge';
  return null;
}
const query = (s: number, w: number, n: number, e: number) => `[out:json][timeout:90][bbox:${s},${w},${n},${e}];
(
nwr["amenity"~"^(drinking_water|water_point|cafe|restaurant|fast_food|pub|bar|shelter|bicycle_repair_station|device_charging_station)$"];
nwr["amenity"="fountain"]["drinking_water"="yes"];
nwr["man_made"="water_tap"]["drinking_water"="yes"];
nwr["amenity"="charging_station"]["bicycle"~"^(yes|designated)$"];
nwr["shop"~"^(bakery|pastry|convenience|supermarket|general|greengrocer|farm|bicycle)$"];
nwr["tourism"~"^(camp_site|camp_pitch|wilderness_hut|alpine_hut)$"];
);
out center tags;`;

// Tous les serveurs en même temps, première réponse valable (95 s au plus) : un seul serveur lent bloquait l'appel.
async function overpass(q: string): Promise<{ elements?: unknown[]; heavy?: boolean; err?: string }> {
  const errs: string[] = [], ctls = SERVERS.map(() => new AbortController());
  const tm = setTimeout(() => ctls.forEach((c) => c.abort()), 95000);
  try {
    return await Promise.any(SERVERS.map(async (url, k) => {
      const host = new URL(url).host;
      try {
        const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }), signal: ctls[k].signal,
          headers: { 'User-Agent': 'Sillage (github.com/antoinechry/plan-my-ride; hello@sillage-ride.eu)' } });
        if (!r.ok) throw new Error(`${host} ${r.status}`);
        const j = await r.json() as { elements?: unknown[]; remark?: string };
        if (typeof j.remark === 'string' && /runtime error|timed out|out of memory/i.test(j.remark)) return { heavy: true, err: `${host} ${j.remark.slice(0, 80)}` };
        return { elements: j.elements ?? [] };
      } catch (e) { errs.push((e as Error).message.startsWith(host) ? (e as Error).message : `${host} ${(e as Error).name === 'AbortError' ? 'timeout' : 'error'}`); throw e; }
    }));
  } catch (_) { return { err: errs.join(', ') || 'timeout' }; }
  finally { clearTimeout(tm); ctls.forEach((c) => c.abort()); }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const tok = req.headers.get('x-cron-token') ?? '';
  const { data: k } = await db.from('push_keys').select('cron_token').eq('id', 1).maybeSingle();
  if (!tok || !k?.cron_token || tok !== k.cron_token) return json({ error: 'auth' }, 401);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* corps vide */ }
  const want = Math.min(2, Math.max(1, Number(body.n) || 1));

  const { data: tiles, error } = await db.rpc('osm_tile_claim', { k: want });
  if (error) return json({ error: 'claim', detail: error.message }, 500);
  const done: unknown[] = [], errors: unknown[] = [];
  for (const t of (tiles ?? []) as { key: string; s: number; w: number; n: number; e: number }[]) {
    const r = await overpass(query(t.s, t.w, t.n, t.e));
    if (r.heavy || (r.err && /timeout/.test(r.err) && t.n - t.s > 0.13)) {
      await db.rpc('osm_tile_split', { p_key: t.key });
      errors.push({ key: t.key, split: true, err: r.err }); continue;
    }
    if (!r.elements) {
      await db.from('osm_tiles').update({ status: 'error', err: (r.err || 'inconnu').slice(0, 300) }).eq('key', t.key);
      errors.push({ key: t.key, err: r.err }); continue;
    }
    const rows = [];
    for (const e of r.elements as { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Tags }[]) {
      const tags = e.tags || {}, type = classify(tags); if (!type) continue;
      const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon; if (typeof lat !== 'number' || typeof lon !== 'number') continue;
      const tt: Tags = {}; for (const key of KEEP) if (tags[key] && key !== 'name') tt[key] = String(tags[key]).slice(0, 200);
      rows.push({ id: `${e.type}/${e.id}`, type, name: tags.name ? String(tags.name).slice(0, 120) : null, lat: +lat.toFixed(6), lon: +lon.toFixed(6), t: tt });
    }
    const { data: c, error: e2 } = await db.rpc('osm_tile_store', { p_key: t.key, p_rows: rows });
    if (e2) { await db.from('osm_tiles').update({ status: 'error', err: ('store ' + e2.message).slice(0, 300) }).eq('key', t.key); errors.push({ key: t.key, err: e2.message }); continue; }
    done.push({ key: t.key, n: c });
  }
  return json({ done, errors });
});
