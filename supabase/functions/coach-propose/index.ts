import { createClient } from 'jsr:@supabase/supabase-js@2';

// Coach Miguel : « Demander une sortie ».
// Le navigateur envoie la consigne (profil, forme, activités récentes, dispos, demande) ; cette fonction appelle
// l'API Claude avec la clé ANTHROPIC_API_KEY (secret Supabase, jamais renvoyée au navigateur) et renvoie la
// séance proposée en JSON. Réservé aux utilisateurs listés dans COACH_USER_IDS (par défaut : le propriétaire).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const OWNER = 'e51d871e-c7bb-4aa7-aaf1-4aa96ca3e36b';
const SYSTEM = "Tu es Miguel, coach d'endurance (vélo de route et course à pied / trail) d'un athlète amateur. " +
  'Tu proposes des séances prudentes, concrètes et adaptées à sa forme du moment. ' +
  'Réponds uniquement avec un objet JSON valide, sans texte autour ni bloc de code.';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: 'unauthorized' }, 401);
  const allowed = (Deno.env.get('COACH_USER_IDS') ?? OWNER).split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(user.id)) return json({ error: 'forbidden' }, 403);

  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) return json({ error: 'no_key' }, 503);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* corps vide */ }
  const prompt = String(body.prompt ?? '');
  if (prompt.length < 50 || prompt.length > 30000) return json({ error: 'bad_prompt' }, 400);

  const model = Deno.env.get('COACH_MODEL') || 'claude-sonnet-5-5';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 1500, system: SYSTEM, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) {
    let detail = '';
    try { const e = await r.json(); detail = e?.error?.message ?? ''; } catch (_) { /* rien */ }
    return json({ error: 'api', status: r.status, detail: detail.slice(0, 300) }, 502);
  }
  const out = await r.json();
  const text = (out.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return json({ error: 'invalid_json' }, 502);
  try {
    return json({ ok: true, proposal: JSON.parse(m[0]), model });
  } catch (_) {
    return json({ error: 'invalid_json' }, 502);
  }
});
