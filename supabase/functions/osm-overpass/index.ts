// Plan My Ride : relais vers le service Overpass (OpenStreetMap), utilisé quand le navigateur n'arrive pas à le
// joindre directement (serveur saturé, connexion refusée, limite par adresse IP). Essaie plusieurs serveurs
// Overpass à tour de rôle et renvoie la première réponse valable. Seules les requêtes Overpass QL en JSON, de
// taille raisonnable, sont acceptées.
// POST { q } → { elements, server } ou { error, tried }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const SERVERS = [ // le premier qui répond (overpass-api.de refuse parfois les connexions : essayé en second)
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { return json({ error: 'body' }, 400); }
  const q = typeof body.q === 'string' ? body.q : '';
  if (!q.startsWith('[out:json]') || q.length > 60000 || /\[out:(xml|csv)/.test(q)) return json({ error: 'bad_query' }, 400);
  const tried: string[] = [];
  for (const url of SERVERS) {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }), signal: ctl.signal, headers: { 'User-Agent': 'plan-my-ride (github.com/antoinechry/plan-my-ride)' } });
      if (!r.ok) { tried.push(`${new URL(url).host} ${r.status}`); continue; }
      const j = await r.json() as Record<string, unknown>;
      if (typeof j.remark === 'string' && /runtime error|timed out|out of memory/i.test(j.remark)) { tried.push(`${new URL(url).host} remark`); return json({ error: 'too_heavy', remark: j.remark, tried }, 422); }
      return json({ elements: j.elements ?? [], server: new URL(url).host });
    } catch (e) {
      tried.push(`${new URL(url).host} ${(e as Error).name === 'AbortError' ? 'timeout' : 'error'}`);
    } finally { clearTimeout(tm); }
  }
  return json({ error: 'unavailable', tried }, 503);
});
