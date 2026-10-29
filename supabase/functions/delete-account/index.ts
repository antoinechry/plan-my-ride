import { createClient } from 'jsr:@supabase/supabase-js@2';

// Sillage : suppression du compte par son titulaire (page Moi → « Supprimer mon compte », depuis le 29/10/2026 ;
// exigée par l'App Store et Google Play).
// POST { password } avec le jeton de session du compte.
//   → vérifie le mot de passe (évite une suppression depuis un appareil laissé ouvert),
//   → refuse si c'est le dernier administrateur actif,
//   → retire le contact de Brevo (lettre d'info), s'il existe,
//   → supprime l'utilisateur Auth : la cascade efface app_users, routes, push_alerts, push_subs, usage_log, activity_log.
// Réponses : { ok: true } ; { error: 'auth' | 'password' | 'last_admin' | 'delete' }.
// Secrets : BREVO_API_KEY (facultatif : sans lui, le contact Brevo n'est pas retiré).

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
  const URL_ = Deno.env.get('SUPABASE_URL')!, ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
  const db = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* corps vide */ }

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: who } = await db.auth.getUser(jwt);
  const user = who?.user;
  if (!user?.email) return json({ error: 'auth' }, 401);

  // Mot de passe : même contrôle qu'une connexion.
  const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
  if (!password) return json({ error: 'password' }, 403);
  const chk = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password }),
  });
  await chk.arrayBuffer().catch(() => null);
  if (!chk.ok) return json({ error: 'password' }, 403);

  // Garder au moins un administrateur actif.
  const { data: me } = await db.from('app_users').select('is_admin').eq('user_id', user.id).maybeSingle();
  if (me?.is_admin) {
    const { count } = await db.from('app_users').select('user_id', { count: 'exact', head: true })
      .eq('is_admin', true).eq('status', 'active').neq('user_id', user.id);
    if (!count) return json({ error: 'last_admin' }, 409);
  }

  // Lettre d'info : retirer le contact (404 = pas inscrit).
  const key = (Deno.env.get('BREVO_API_KEY') || '').trim();
  if (key) {
    try {
      const r = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(user.email.toLowerCase())}?identifierType=email_id`, {
        method: 'DELETE', headers: { 'api-key': key, accept: 'application/json' },
      });
      if (!r.ok && r.status !== 404) console.error('brevo', r.status, (await r.text()).slice(0, 200));
    } catch (e) { console.error('brevo', String(e)); }
  }

  const { error } = await db.auth.admin.deleteUser(user.id);
  if (error) return json({ error: 'delete', detail: error.message.slice(0, 200) }, 500);
  return json({ ok: true });
});
