import { createClient } from 'jsr:@supabase/supabase-js@2';
import { confirmLink, confirmMail } from './mail.ts';

// Création de compte Sillage (les inscriptions directes restent fermées dans Supabase).
// POST { email, password, prenom?, code?, lang? } (clé anon) → { ok, status: 'active' | 'pending' }
//   Avec un code de lien testeur actif (table tester_links), le compte a tout de suite accès à Sillage
//   (le déclencheur handle_new_user lit user_metadata.invite).
//   Sinon (inscription ouverte depuis le 29/10/2026) : compte « pending » jusqu'à la confirmation de l'adresse :
//   e-mail « Confirme ton adresse » envoyé par Brevo avec un lien vers sillage-ride.eu/compte-confirme/?t=…
//   (jeton aléatoire, gardé haché dans email_confirm, 48 h), que la fonction confirm-email valide.
// POST { action: 'resend', email, lang? } → { ok: true } dans tous les cas (rien n'indique si l'adresse existe) ;
//   renvoie l'e-mail si le compte attend sa confirmation, au plus une fois toutes les 2 minutes.
// L'adresse est marquée confirmée côté Auth (connexion possible) ; c'est app_users.status qui ouvre l'accès.
// Secret : BREVO_API_KEY.

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

type Admin = ReturnType<typeof createClient>;
// Nouveau jeton de confirmation + envoi de l'e-mail. Rend true si Brevo a accepté l'envoi.
async function sendConfirm(db: Admin, uid: string, email: string, prenom: string, lang: string) {
  const key = (Deno.env.get('BREVO_API_KEY') || '').trim();
  if (!key) return false;
  const token = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const { error } = await db.from('email_confirm').insert({ token_hash: await sha(token), user_id: uid, lang, exp: new Date(Date.now() + 48 * 3600e3).toISOString() });
  if (error) { console.error('token', error.message); return false; }
  const m = confirmMail(lang, prenom, confirmLink(lang, token));
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Sillage.cc', email: 'hello@sillage-ride.eu' },
      replyTo: { email: 'hello@sillage-ride.eu', name: 'Sillage.cc' },
      to: [{ email, ...(prenom ? { name: prenom } : {}) }],
      subject: m.subject, htmlContent: m.html, tags: ['confirmation-compte'],
    }),
  }).catch((e) => { console.error('brevo', String(e)); return null; });
  if (!r || !r.ok) { if (r) console.error('brevo', r.status, (await r.text()).slice(0, 200)); return false; }
  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* corps vide */ }
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const email = String(body.email ?? '').trim().toLowerCase();
  const lang = body.lang === 'en' ? 'en' : 'fr';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) return json({ error: 'email' }, 400);

  if (body.action === 'resend') {
    const { data: u } = await admin.from('app_users').select('user_id,prenom,status,validated_at').eq('email', email).maybeSingle();
    if (u && u.status === 'pending' && !u.validated_at) {
      const { data: last } = await admin.from('email_confirm').select('created_at').eq('user_id', u.user_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (!last || Date.now() - Date.parse(last.created_at) > 120e3) await sendConfirm(admin, u.user_id, email, u.prenom || '', lang);
    }
    return json({ ok: true });
  }

  const password = String(body.password ?? '');
  const prenom = String(body.prenom ?? '').trim().slice(0, 40);
  const code = String(body.code ?? '').trim().slice(0, 40);
  if (password.length < 8 || password.length > 200) return json({ error: 'password' }, 400);

  let valid = false;
  if (code) {
    const { data } = await admin.from('tester_links').select('active').eq('code', code).maybeSingle();
    valid = !!data?.active;
    if (!valid) return json({ error: 'code' }, 400);
  }
  const { data: made, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { prenom, ...(valid ? { invite: code } : {}) },
  });
  if (error) {
    if (/already|exists|registered/i.test(error.message)) return json({ error: 'exists' }, 409);
    return json({ error: 'create', detail: error.message.slice(0, 200) }, 500);
  }
  if (valid) return json({ ok: true, status: 'active' });
  const mail = await sendConfirm(admin, made.user.id, email, prenom, lang);
  return json({ ok: true, status: 'pending', mail });
});
