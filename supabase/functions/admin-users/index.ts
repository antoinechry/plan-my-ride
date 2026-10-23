import { createClient } from 'jsr:@supabase/supabase-js@2';

// Gestion des comptes pour la page Admin (admin.html), réservée aux administrateurs actifs (app_users.is_admin).
// POST (jeton de session de l'admin) :
//   { action: 'list' }                                   → { ok, users: [{ id, email, created_at, last_sign_in_at, routes, routes_last }] }
//   { action: 'create', email, password, prenom?, pmr?, coach? } → { ok, id }  (compte actif tout de suite, adresse confirmée d'office)
//   { action: 'set_password', user_id, password }        → { ok }
// Ces actions demandent la clé de service (auth.admin) : elles ne peuvent pas se faire depuis le navigateur.

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
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // qui appelle ? (jeton de session) → administrateur actif seulement
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: who } = await admin.auth.getUser(jwt);
  if (!who?.user) return json({ error: 'auth' }, 401);
  const { data: me } = await admin.from('app_users').select('is_admin,status').eq('user_id', who.user.id).maybeSingle();
  if (!me?.is_admin || me.status !== 'active') return json({ error: 'forbidden' }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* corps vide */ }
  const action = String(body.action ?? '');

  if (action === 'list') {
    const users: Record<string, unknown>[] = [];
    for (let page = 1; page <= 10; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) return json({ error: 'list', detail: error.message.slice(0, 200) }, 500);
      for (const u of data.users) users.push({ id: u.id, email: u.email, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at ?? null, routes: 0, routes_last: null });
      if (data.users.length < 200) break;
    }
    // parcours enregistrés dans le compte (table routes) : nombre et dernière utilisation
    const { data: rt } = await admin.from('routes').select('user_id,used_at,created_at').limit(20000);
    const byId = new Map(users.map(u => [u.id as string, u]));
    for (const r of rt ?? []) {
      const u = byId.get(r.user_id); if (!u) continue;
      u.routes = (u.routes as number) + 1;
      const t = r.used_at || r.created_at;
      if (t && (!u.routes_last || t > (u.routes_last as string))) u.routes_last = t;
    }
    return json({ ok: true, users });
  }

  const password = String(body.password ?? '');
  if (password.length < 8 || password.length > 200) return json({ error: 'password' }, 400);

  if (action === 'create') {
    const email = String(body.email ?? '').trim().toLowerCase();
    const prenom = String(body.prenom ?? '').trim().slice(0, 40);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) return json({ error: 'email' }, 400);
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { prenom } });
    if (error || !data?.user) {
      if (error && /already|exists|registered/i.test(error.message)) return json({ error: 'exists' }, 409);
      return json({ error: 'create', detail: (error?.message ?? '').slice(0, 200) }, 500);
    }
    // la ligne app_users est créée par le déclencheur handle_new_user : on l'ouvre tout de suite avec les accès choisis
    const pmr = body.pmr !== false, coach = !!body.coach;
    const { error: e2 } = await admin.from('app_users').update({
      status: 'active', pmr: pmr || !coach, coach, prenom: prenom || null, validated_at: new Date().toISOString(),
    }).eq('user_id', data.user.id);
    if (e2) return json({ ok: true, id: data.user.id, warn: 'access', detail: e2.message.slice(0, 200) });
    return json({ ok: true, id: data.user.id });
  }

  if (action === 'set_password') {
    const id = String(body.user_id ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'user' }, 400);
    const { error } = await admin.auth.admin.updateUserById(id, { password });
    if (error) return json({ error: 'update', detail: error.message.slice(0, 200) }, 500);
    return json({ ok: true });
  }

  return json({ error: 'action' }, 400);
});
