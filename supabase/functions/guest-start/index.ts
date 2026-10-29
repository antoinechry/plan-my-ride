import { createClient } from 'npm:@supabase/supabase-js@2';

// Visite sans compte (29/10/2026) : crée un compte invité (adresse technique, sans e-mail réel) et renvoie
// ses identifiants ; la page s'y connecte et passe ainsi par le relais Open-Meteo (licence payante, quota du compte).
// POST {} (clé anon) → { ok, email, password } ; 429 { error: 'limit' } au-delà de 10 comptes invités par jour et par
// adresse IP (IP hachée avec un sel du jour, table guest_ip gardée 2 jours) ou de 1000 par jour en tout.
// Le compte : app_users.status = 'guest', pmr = true, quota_om = 1000 appels par jour ; effacé après 30 jours
// d'inactivité (purge_old_data). Les règles de la visite (3 traces par semaine…) sont appliquées par la page.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sha(s: string) {
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
const GUEST_QUOTA = 1000, PER_IP = 10, PER_DAY = 1000;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  const salt = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').slice(-24);
  const [{ data: nIp }, { data: nAll }] = await Promise.all([
    db.rpc('guest_ip_hit', { h: await sha(`${salt}|${day}|${ip}`) }),
    db.rpc('guest_ip_hit', { h: 'all' }),
  ]);
  if (Number(nIp) > PER_IP || Number(nAll) > PER_DAY) return json({ error: 'limit' }, 429);

  const email = `guest-${crypto.randomUUID()}@guest.sillage-ride.eu`;
  const password = b64u(crypto.getRandomValues(new Uint8Array(24)));
  const { data: made, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { guest: true } });
  if (error || !made?.user) return json({ error: 'create', detail: (error?.message || '').slice(0, 160) }, 500);
  const { error: e2 } = await db.from('app_users').update({ status: 'guest', pmr: true, quota_om: GUEST_QUOTA, validated_at: new Date().toISOString() })
    .eq('user_id', made.user.id);
  if (e2) { await db.auth.admin.deleteUser(made.user.id).catch(() => {}); return json({ error: 'create' }, 500); }
  return json({ ok: true, email, password });
});
