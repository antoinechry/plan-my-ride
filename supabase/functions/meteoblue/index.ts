import { createClient } from 'jsr:@supabase/supabase-js@2';

// Plan My Ride : prévisions meteoblue (API « packages ») pour des points de la trace.
// La clé METEOBLUE_API_KEY (secret Supabase) n'est jamais renvoyée au navigateur. Réservé aux utilisateurs
// listés dans COACH_USER_IDS (par défaut : le propriétaire), pour protéger les crédits.
// POST { points: [{ lat, lon, asl? }], days } → { ok, days, pkg, points: [{ t[], temp[], app[], pr[], prob[], pic[], day[],
//   ws[] (km/h), wd[], gust[] (km/h), cc[], sun[], sunUnit, asl, modelrun, updated }] }
// POST { debug: true, points: [un point], pkg? } → aperçu brut de la réponse meteoblue (unités, champs).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const OWNER = 'e51d871e-c7bb-4aa7-aaf1-4aa96ca3e36b';
// Paquets accessibles à l'essai gratuit : basic-1h, wind-3h, clouds-3h… (pas de wind-1h ni clouds-1h).
// Crédits par point (en-tête mb-credits-accounted) : basic-1h 8 000 ; avec clouds-3h 16 000 ; avec wind-3h et clouds-3h
// 32 000, quelle que soit la durée (1 à 7 jours). Par défaut basic-1h seul ; au plus MAX_POINTS points par appel.
const PKGS = ['basic-1h', 'basic-1h_clouds-3h', 'basic-1h_wind-3h_clouds-3h'];
const MAX_POINTS = 10;

type Pt = { lat: number; lon: number; asl: number | null };

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
  const key = Deno.env.get('METEOBLUE_API_KEY');
  if (!key) return json({ error: 'no_key' }, 503);
  const mask = (s: string) => s.split(key).join('***');

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* corps vide */ }
  const pts = (Array.isArray(body.points) ? body.points : []).slice(0, MAX_POINTS) as Record<string, unknown>[];
  const clean: Pt[] = pts.map((p) => ({ lat: Number(p.lat), lon: Number(p.lon), asl: p.asl == null ? null : Math.round(Number(p.asl)) }))
    .filter((p) => isFinite(p.lat) && isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
  if (!clean.length) return json({ error: 'no_points' }, 400);
  const days = Math.max(1, Math.min(7, Math.round(Number(body.days) || 7)));
  const pkg = PKGS.includes(String(body.pkg)) ? String(body.pkg) : PKGS[0];

  const urlFor = (p: Pt) =>
    `https://my.meteoblue.com/packages/${pkg}?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}` +
    (p.asl != null && isFinite(p.asl) && p.asl > -500 && p.asl < 9000 ? `&asl=${p.asl}` : '') +
    `&apikey=${encodeURIComponent(key)}&format=json&timeformat=timestamp_utc&windspeed=kmh&forecast_days=${days}`;

  if (body.debug) {
    const t0 = Date.now();
    const r = await fetch(urlFor(clean[0]));
    const text = mask(await r.text());
    let j: Record<string, unknown> | null = null; try { j = JSON.parse(text); } catch (_) { /* texte brut */ }
    if (!j) return json({ status: r.status, ms: Date.now() - t0, text: text.slice(0, 500) });
    const d = (j.data_1h ?? {}) as Record<string, unknown[]>, d3 = (j.data_3h ?? {}) as Record<string, unknown[]>;
    const headers = Object.fromEntries([...r.headers].filter(([k]) => !/cookie/i.test(k)));
    return json({ status: r.status, ms: Date.now() - t0, pkg, headers, keys: Object.keys(j), metadata: j.metadata, units: j.units,
      error: j.error_message ?? j.error ?? null,
      fields: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Array.isArray(v) ? [v.length, ...v.slice(0, 3)] : v])),
      fields3h: Object.fromEntries(Object.entries(d3).map(([k, v]) => [k, Array.isArray(v) ? [v.length, ...v.slice(0, 3)] : v])) });
  }

  const one = async (p: Pt) => {
    const r = await fetch(urlFor(p));
    if (!r.ok) throw new Error(`${r.status} ${mask(await r.text()).slice(0, 200)}`);
    const j = await r.json() as Record<string, unknown>;
    const d = (j.data_1h ?? {}) as Record<string, (number | string | null)[]>;
    const units = (j.units ?? {}) as Record<string, string>;
    // Vent en km/h quelle que soit l'unité renvoyée.
    const wu = String(units.windspeed ?? '').toLowerCase().replace(/\s/g, '');
    const wf = /^(ms-1|m\/s|ms)$/.test(wu) ? 3.6 : /kn/.test(wu) ? 1.852 : /mph/.test(wu) ? 1.609 : 1;
    const num = (k: string, f = 1) => (d[k] ?? []).map((v) => v == null || v === '' ? null : Math.round(Number(v) * f * 100) / 100);
    const sec = (v: unknown) => typeof v === 'number' ? v : Math.round(Date.parse(String(v).replace(' ', 'T') + 'Z') / 1000);
    const t = (d.time ?? []).map(sec);
    // Champs des paquets 3 h (rafales, nébulosité, ensoleillement) ramenés sur la grille horaire par interpolation.
    const d3 = (j.data_3h ?? {}) as Record<string, (number | string | null)[]>, t3 = (d3.time ?? []).map(sec);
    const from3 = (k: string, f = 1) => {
      const v3 = (d3[k] ?? []).map((v) => v == null || v === '' ? NaN : Number(v));
      if (!v3.length || t3.length < 2) return null;
      let i = 0;
      return t.map((tt) => {
        while (i < t3.length - 2 && t3[i + 1] <= tt) i++;
        const a = t3[i], b = t3[i + 1], x = Math.min(1, Math.max(0, (tt - a) / (b - a)));
        const va = v3[i], vb = v3[i + 1], v = isFinite(va) && isFinite(vb) ? va + (vb - va) * x : (isFinite(va) ? va : vb);
        return isFinite(v) ? Math.round(v * f * 100) / 100 : null;
      });
    };
    const has = (k: string) => Array.isArray(d[k]) && d[k].length > 0;
    const meta = (j.metadata ?? {}) as Record<string, unknown>;
    return { t, temp: num('temperature'), app: num('felttemperature'), pr: num('precipitation'), prob: num('precipitation_probability'),
      pic: num('pictocode'), day: num('isdaylight'), ws: num('windspeed', wf), wd: num('winddirection'),
      gust: has('gust') ? num('gust', wf) : from3('gust', wf),
      cc: has('totalcloudcover') ? num('totalcloudcover') : from3('totalcloudcover'),
      // ensoleillement en minutes par heure (les valeurs 3 h couvrent 3 heures)
      sun: has('sunshinetime') ? num('sunshinetime') : from3('sunshinetime', 1 / 3), sunUnit: units.sunshinetime ?? null,
      asl: meta.height ?? null, modelrun: meta.modelrun_utc ?? null, updated: meta.modelrun_updatetime_utc ?? null };
  };
  try {
    const out: unknown[] = new Array(clean.length);
    let next = 0;
    const worker = async () => { while (next < clean.length) { const i = next++; out[i] = await one(clean[i]); } };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return json({ ok: true, days, pkg, points: out });
  } catch (e) {
    return json({ error: 'meteoblue', detail: mask(String((e as Error).message || e)) }, 502);
  }
});
