import { createClient } from 'npm:@supabase/supabase-js@2';

// Confirmation de l'adresse e-mail d'un nouveau compte Sillage (depuis le 29/10/2026).
// Appelée par la page sillage-ride.eu/compte-confirme/?t=… (et /en/account-confirmed/), sans session.
// POST { t } → { ok: true, prenom, already? } : le jeton (haché dans email_confirm, 48 h) ouvre l'accès
//   (app_users.status = 'active', pmr = true, validated_at) ; les jetons du compte sont ensuite effacés.
//   { ok: false, error: 'invalid' | 'expired' } sinon. Un compte bloqué n'est pas réactivé.
// Le jeton fait 32 octets aléatoires : impossible à deviner, d'où pas de jeton de session exigé.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
async function sha(s: string) {
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* corps vide */ }
  const t = typeof body.t === 'string' ? body.t : '';
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(t)) return json({ ok: false, error: 'invalid' });

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: row } = await db.from('email_confirm').select('user_id,exp').eq('token_hash', await sha(t)).maybeSingle();
  if (!row) return json({ ok: false, error: 'invalid' });
  if (Date.parse(row.exp) < Date.now()) return json({ ok: false, error: 'expired' });

  const { data: u } = await db.from('app_users').select('status,prenom').eq('user_id', row.user_id).maybeSingle();
  if (!u) return json({ ok: false, error: 'invalid' });
  let already = true;
  if (u.status === 'pending') {
    already = false;
    const { error } = await db.from('app_users').update({ status: 'active', pmr: true, validated_at: new Date().toISOString() })
      .eq('user_id', row.user_id).eq('status', 'pending');
    if (error) return json({ ok: false, error: 'db' }, 500);
  } else if (u.status !== 'active') return json({ ok: false, error: 'invalid' });
  await db.from('email_confirm').delete().eq('user_id', row.user_id);
  return json({ ok: true, prenom: u.prenom || '', already });
});
