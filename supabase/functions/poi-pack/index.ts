// Sillage : relais en lecture vers les packs de points OSM publiés dans la release « poi-packs » du dépôt
// antoinechry/plan-my-ride (12/11/2026). Les téléchargements de releases GitHub ne sont pas lisibles par une page web
// (pas d'en-tête CORS) : la page passe par ici. L'app iPhone / Android pourra lire GitHub directement plus tard.
// GET ?f=index.json | ?f=<pack>.ndjson.gz → le fichier tel quel. Déployée sans vérification JWT (requête simple, sans
// en-tête, pour éviter le pré-vol CORS) : elle ne lit que ces fichiers publics.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const REL = 'https://github.com/antoinechry/plan-my-ride/releases/download/poi-packs/';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET') return new Response('method', { status: 405, headers: CORS });
  const f = new URL(req.url).searchParams.get('f') || '';
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(f) || !(f === 'index.json' || f.endsWith('.ndjson.gz'))) {
    return new Response('bad file', { status: 400, headers: CORS });
  }
  const r = await fetch(REL + f, { redirect: 'follow' });
  if (!r.ok || !r.body) return new Response('not found', { status: r.status === 404 ? 404 : 502, headers: CORS });
  return new Response(r.body, {
    headers: {
      ...CORS,
      'Content-Type': f.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      'Cache-Control': f === 'index.json' ? 'public, max-age=600' : 'public, max-age=86400',
    },
  });
});
