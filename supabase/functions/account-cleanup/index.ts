import { createClient } from 'jsr:@supabase/supabase-js@2';
import { warningMail } from './mail.ts';

// Sillage : suppression des comptes inactifs (depuis le 29/10/2026, voir la page Confidentialité).
// Appelée chaque nuit par pg_cron (tâche « sillage-inactive-accounts »), en-tête x-cron-token (table push_keys).
//   { action: 'cron' } → avertit par e-mail les comptes sans activité depuis 35 mois,
//                        supprime ceux sans activité depuis 36 mois et avertis depuis au moins 28 jours.
//   { action: 'dry' }  → même calcul, sans rien envoyer ni supprimer (pour vérifier).
// Dernière activité = la plus récente de app_users.last_seen_at (journaux) et auth.users.last_sign_in_at.
// Les administrateurs ne sont jamais concernés. Supprimer l'utilisateur Auth efface en cascade
// app_users, routes, push_alerts, push_subs, usage_log et activity_log.
// Secret requis : BREVO_API_KEY.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const MONTH = 30.44 * 864e5;
const WARN_AFTER = 35 * MONTH, DELETE_AFTER = 36 * MONTH, MIN_NOTICE = 28 * 864e5;
const MAX_DELETE = 50; // garde-fou par passage

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* corps vide */ }
  const tok = req.headers.get('x-cron-token') ?? '';
  const { data: k } = await db.from('push_keys').select('cron_token').eq('id', 1).maybeSingle();
  if (!tok || !k?.cron_token || tok !== k.cron_token) return json({ error: 'auth' }, 401);
  const dry = body.action !== 'cron';

  // Dernière connexion connue de chaque compte (Auth).
  const signIn = new Map<string, number>();
  for (let page = 1; page < 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return json({ error: 'auth_list', detail: error.message.slice(0, 200) }, 500);
    for (const u of data.users) if (u.last_sign_in_at) signIn.set(u.id, Date.parse(u.last_sign_in_at));
    if (data.users.length < 1000) break;
  }

  const { data: users, error } = await db.from('app_users')
    .select('user_id,email,prenom,is_admin,created_at,last_seen_at,inactive_warned_at');
  if (error) return json({ error: 'db', detail: error.message.slice(0, 200) }, 500);
  const { data: langs } = await db.from('push_alerts').select('user_id,lang');
  const langOf = new Map((langs ?? []).map((l) => [l.user_id as string, l.lang === 'en' ? 'en' : 'fr']));

  const now = Date.now(), key = (Deno.env.get('BREVO_API_KEY') || '').trim();
  const out = { checked: 0, warned: [] as string[], deleted: [] as string[], reset: 0, errors: [] as string[] };
  for (const u of users ?? []) {
    if (u.is_admin) continue;
    out.checked++;
    const seen = Math.max(Date.parse(u.last_seen_at ?? u.created_at) || 0, signIn.get(u.user_id) ?? 0);
    const idle = now - seen, warnedAt = u.inactive_warned_at ? Date.parse(u.inactive_warned_at) : 0;

    // Revenu·e depuis l'avertissement : on oublie l'avertissement.
    if (warnedAt && seen > warnedAt) {
      out.reset++;
      if (!dry) await db.from('app_users').update({ inactive_warned_at: null }).eq('user_id', u.user_id);
      continue;
    }
    if (idle >= DELETE_AFTER && warnedAt && now - warnedAt >= MIN_NOTICE) {
      if (out.deleted.length >= MAX_DELETE) continue;
      out.deleted.push(u.user_id);
      if (!dry) {
        const { error: e } = await db.auth.admin.deleteUser(u.user_id);
        if (e) out.errors.push(`delete ${u.user_id}: ${e.message.slice(0, 120)}`);
      }
      continue;
    }
    if (idle >= WARN_AFTER && !warnedAt && u.email) {
      out.warned.push(u.user_id);
      if (dry) continue;
      if (!key) { out.errors.push('BREVO_API_KEY manquant'); continue; }
      const deleteOn = new Date(Math.max(seen + DELETE_AFTER, now + 30 * 864e5));
      const m = warningMail(langOf.get(u.user_id) ?? 'fr', u.prenom ?? '', deleteOn);
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: 'Sillage.cc', email: 'hello@sillage-ride.eu' },
          replyTo: { email: 'hello@sillage-ride.eu', name: 'Sillage.cc' },
          to: [{ email: u.email }], subject: m.subject, htmlContent: m.html, tags: ['compte-inactif'],
        }),
      }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as Response);
      if (r.ok) await db.from('app_users').update({ inactive_warned_at: new Date(now).toISOString() }).eq('user_id', u.user_id);
      else out.errors.push(`mail ${u.user_id}: ${r.status} ${(await r.text()).slice(0, 120)}`); // nouvel essai la nuit suivante
    }
  }
  return json({ ok: true, dry, ...out });
});
