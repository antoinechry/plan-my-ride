import { createClient } from 'jsr:@supabase/supabase-js@2';

// Création de compte pour Plan My Ride (les inscriptions directes restent fermées dans Supabase).
// POST { email, password, prenom?, code? } (clé anon) → { ok, status: 'active' | 'pending' }
// Avec un code de lien testeur actif (table tester_links), le compte a tout de suite accès à Plan My Ride
// (le déclencheur handle_new_user lit user_metadata.invite) ; sinon il attend la validation d'un administrateur.
// L'adresse est confirmée d'office (pas d'e-mail de confirmation : l'envoi gratuit de Supabase est très limité).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* corps vide */ }

  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const prenom = String(body.prenom ?? '').trim().slice(0, 40);
  const code = String(body.code ?? '').trim().slice(0, 40);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) return json({ error: 'email' }, 400);
  if (password.length < 8 || password.length > 200) return json({ error: 'password' }, 400);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  let valid = false;
  if (code) {
    const { data } = await admin.from('tester_links').select('active').eq('code', code).maybeSingle();
    valid = !!data?.active;
    if (!valid) return json({ error: 'code' }, 400);
  }
  const { error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { prenom, ...(valid ? { invite: code } : {}) },
  });
  if (error) {
    if (/already|exists|registered/i.test(error.message)) return json({ error: 'exists' }, 409);
    return json({ error: 'create', detail: error.message.slice(0, 200) }, 500);
  }
  return json({ ok: true, status: valid ? 'active' : 'pending' });
});
