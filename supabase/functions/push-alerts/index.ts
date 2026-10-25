import { createClient } from 'jsr:@supabase/supabase-js@2';
import { sendPush, vapidGenerate, type VapidKeys, type Sub } from './webpush.ts';
import { localParts, zoned, addDays, isoWd, route, weather, ride, verdict, score } from './forecast.ts';

// Alertes météo de Plan My Ride (notifications Web Push), depuis le 25/10/2026.
// POST, jeton de session d'un compte actif avec l'accès Plan My Ride :
//   { action: 'key' }                                 → { ok, key }   clé publique VAPID pour s'abonner
//   { action: 'subscribe', sub: PushSubscription, ua } → { ok }        cet appareil reçoit les alertes
//   { action: 'unsubscribe', endpoint }               → { ok }
//   { action: 'test' }                                → { ok, sent, title, body }   alerte envoyée tout de suite
// POST { action: 'cron' } avec l'en-tête x-cron-token (table push_keys) : appelé chaque heure par pg_cron ;
// envoie l'alerte de chaque compte à son heure (la veille à 20 h ou le jour même à 7 h, heure locale).
// Clés VAPID créées au premier appel et gardées dans push_keys (clé de service seulement, jamais dans le dépôt).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const SITE = 'https://antoinechry.github.io/plan-my-ride/';
const SUBJECT = SITE; // contact VAPID (adresse du site plutôt qu'un e-mail)
const NOTIFY_H: Record<string, number> = { eve: 20, morn: 7 };

type Admin = ReturnType<typeof createClient>;
type Alert = { user_id: string; enabled: boolean; route_id: string | null; route_name: string | null; dep_time: string; days: number[];
  notify: string; speed: number | null; vam: number | null; tz: string; page: string | null; last_sent: string | null };

async function vapid(db: Admin): Promise<VapidKeys> {
  const { data } = await db.from('push_keys').select('pub,priv').eq('id', 1).maybeSingle();
  if (data?.pub && data?.priv) return { pub: data.pub, priv: data.priv };
  const k = await vapidGenerate();
  await db.from('push_keys').upsert({ id: 1, pub: k.pub, priv: k.priv }, { onConflict: 'id' });
  return k;
}

// Alerte d'un compte pour un jour donné : titre, texte et lien qui ouvre le parcours à ce jour et cette heure.
async function buildAlert(db: Admin, a: Alert, day: string, todayLocal: string) {
  const { data: r } = await db.from('routes').select('id,name,pts').eq('user_id', a.user_id).eq('id', a.route_id).is('deleted_at', null).maybeSingle();
  if (!r || !Array.isArray(r.pts) || r.pts.length < 2) return null;
  const R = route(r.pts as number[][]), tz = a.tz || 'Europe/Paris';
  const speed = Math.min(45, Math.max(10, Number(a.speed) || 25)), vam = Math.min(1500, Math.max(250, Number(a.vam) || 700));
  const ahead = Math.round((Date.parse(day) - Date.parse(todayLocal)) / 864e5);
  const wx = await weather(R.smp, addDays(day, -1), addDays(day, 1), ahead <= 2);
  const t0 = zoned(day, a.dep_time, tz), s = ride(R, wx, t0, speed, vam), v = verdict(s);
  // meilleure heure de départ ce jour-là (6 h → 17 h), si nettement meilleure
  let best: { h: number; sc: number; v: ReturnType<typeof verdict> } | null = null;
  for (let h = 6; h <= 17; h++) {
    const s2 = ride(R, wx, zoned(day, String(h).padStart(2, '0') + ':00', tz), speed, vam); if (s2.miss) continue;
    const sc = score(s2); if (!best || sc < best.sc) best = { h, sc, v: verdict(s2) };
  }
  const dot = ['🟢', '🟠', '🔴'][v.lvl], name = a.route_name || r.name || 'Ton parcours';
  const when = day === todayLocal ? 'Aujourd\'hui' : day === addDays(todayLocal, 1) ? 'Demain' : new Intl.DateTimeFormat('fr-FR', { weekday: 'long', timeZone: 'UTC' }).format(new Date(day + 'T12:00Z'));
  const fmt = (ms: number) => new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(ms));
  const ressenti = Math.round(s.amin) === Math.round(s.amax) ? `ressenti ${Math.round(s.amin)} °C` : `ressenti ${Math.round(s.amin)} à ${Math.round(s.amax)} °C`;
  let body = s.miss ? 'Prévision incomplète pour ce parcours.' : `${dot} ${v.txt} · ${ressenti} · arrivée vers ${fmt(s.endMs)}`;
  if (best && !s.miss && best.sc < score(s) - 2 && String(best.h).padStart(2, '0') + ':00' !== a.dep_time)
    body += `\nMieux à ${String(best.h).padStart(2, '0')}:00 (${best.v.txt.charAt(0).toLowerCase() + best.v.txt.slice(1)})`;
  const page = a.page && a.page.startsWith(SITE) ? a.page : SITE;
  const url = `${page}?route=${encodeURIComponent(r.id)}&date=${day}&time=${a.dep_time}`;
  return { title: `${when} ${a.dep_time} · ${name}`, body, url, tag: 'pmr-alert-' + day, lvl: v.lvl };
}

async function deliver(db: Admin, keys: VapidKeys, userId: string, msg: Record<string, unknown>) {
  const { data: subs } = await db.from('push_subs').select('id,endpoint,p256dh,auth').eq('user_id', userId);
  let sent = 0;
  for (const s of subs ?? []) {
    let st = 0;
    try { st = await sendPush(s as Sub, msg, keys, SUBJECT); } catch (_) { st = 0; }
    if (st >= 200 && st < 300) { sent++; await db.from('push_subs').update({ last_ok_at: new Date().toISOString(), fails: 0 }).eq('id', s.id); }
    else if (st === 404 || st === 410) await db.from('push_subs').delete().eq('id', s.id); // abonnement expiré
    else await db.rpc('push_sub_fail', { sid: s.id }).then(() => {}, () => {});
  }
  return { sent, devices: (subs ?? []).length };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* corps vide */ }
  const action = String(body.action ?? '');

  if (action === 'cron') {
    const tok = req.headers.get('x-cron-token') ?? '';
    const { data: k } = await db.from('push_keys').select('cron_token').eq('id', 1).maybeSingle();
    if (!tok || !k?.cron_token || tok !== k.cron_token) return json({ error: 'auth' }, 401);
    const keys = await vapid(db), now = Date.now(), out: unknown[] = [];
    const { data: alerts } = await db.from('push_alerts').select('*').eq('enabled', true).not('route_id', 'is', null);
    for (const a of (alerts ?? []) as Alert[]) {
      try {
        const tz = a.tz || 'Europe/Paris', L = localParts(now, tz);
        if (L.hour !== (NOTIFY_H[a.notify] ?? 20) || a.last_sent === L.date) continue;
        const day = a.notify === 'morn' ? L.date : addDays(L.date, 1);
        await db.from('push_alerts').update({ last_sent: L.date }).eq('user_id', a.user_id);
        if (Array.isArray(a.days) && a.days.length && !a.days.includes(isoWd(day))) { out.push({ u: a.user_id, skip: 'day' }); continue; }
        const { data: u } = await db.from('app_users').select('status,pmr').eq('user_id', a.user_id).maybeSingle();
        if (!u || u.status !== 'active' || !u.pmr) continue;
        const msg = await buildAlert(db, a, day, L.date); if (!msg) continue;
        out.push({ u: a.user_id, ...(await deliver(db, keys, a.user_id, msg)) });
      } catch (e) { out.push({ u: a.user_id, error: String((e as Error).message ?? e).slice(0, 200) }); }
    }
    return json({ ok: true, done: out });
  }

  // appels depuis l'app : compte actif avec l'accès Plan My Ride
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: who } = await db.auth.getUser(jwt);
  if (!who?.user) return json({ error: 'auth' }, 401);
  const uid = who.user.id;
  const { data: me } = await db.from('app_users').select('status,pmr').eq('user_id', uid).maybeSingle();
  if (!me || me.status !== 'active' || !me.pmr) return json({ error: 'forbidden' }, 403);

  if (action === 'key') return json({ ok: true, key: (await vapid(db)).pub });

  if (action === 'subscribe') {
    const s = body.sub as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | undefined;
    const ep = String(s?.endpoint ?? ''), p = String(s?.keys?.p256dh ?? ''), au = String(s?.keys?.auth ?? '');
    if (!/^https:\/\//.test(ep) || ep.length > 1000 || !/^[\w-]{80,100}$/.test(p) || !/^[\w-]{16,40}$/.test(au)) return json({ error: 'sub' }, 400);
    const { error } = await db.from('push_subs').upsert({ user_id: uid, endpoint: ep, p256dh: p, auth: au, ua: String(body.ua ?? '').slice(0, 200), fails: 0 }, { onConflict: 'endpoint' });
    if (error) return json({ error: 'save', detail: error.message.slice(0, 200) }, 500);
    return json({ ok: true });
  }
  if (action === 'unsubscribe') {
    await db.from('push_subs').delete().eq('user_id', uid).eq('endpoint', String(body.endpoint ?? ''));
    return json({ ok: true });
  }
  if (action === 'test') {
    const keys = await vapid(db);
    const { data: a } = await db.from('push_alerts').select('*').eq('user_id', uid).maybeSingle();
    let msg: Record<string, unknown> | null = null;
    if (a?.route_id) {
      const tz = a.tz || 'Europe/Paris', L = localParts(Date.now(), tz);
      const day = a.notify === 'morn' && L.hour < 12 ? L.date : addDays(L.date, 1);
      try { msg = await buildAlert(db, a as Alert, day, L.date); } catch (e) { msg = { title: 'Plan My Ride', body: 'Alerte de test (météo indisponible : ' + String((e as Error).message).slice(0, 80) + ').', url: SITE }; }
    }
    if (!msg) msg = { title: 'Plan My Ride', body: 'Les alertes fonctionnent sur cet appareil. Choisis un parcours pour recevoir sa météo.', url: (a?.page && String(a.page).startsWith(SITE)) ? a.page : SITE };
    const r = await deliver(db, keys, uid, msg);
    return json({ ok: true, ...r, title: msg.title, body: msg.body });
  }
  return json({ error: 'action' }, 400);
});
