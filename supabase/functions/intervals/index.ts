import { createClient } from 'jsr:@supabase/supabase-js@2';

// Coach Miguel ↔ intervals.icu
// Actions (POST JSON { action, ... }) :
//   status                      → { connected, athlete_id }
//   link { api_key, athlete_id? } → vérifie la clé auprès d'intervals.icu puis l'enregistre
//   unlink                      → supprime la clé
//   sync                        → importe les activités des IMPORT_DAYS derniers jours
//   streams { ext_id }          → courbes d'une activité (temps, distance, altitude, vitesse, FC, puissance, cadence),
//                                 moyennées par paquets pour tenir en STREAM_POINTS points au plus
// La clé n'est jamais renvoyée au navigateur.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const API = 'https://intervals.icu/api/v1';
// Fenêtre glissante d'import : 12 mois (intervals.icu doit avoir l'historique, cf. « Téléch. d'anciennes données »).
const IMPORT_DAYS = 365;
const STREAM_POINTS = 1500;
const STREAM_TYPES = ['time', 'distance', 'altitude', 'velocity_smooth', 'heartrate', 'watts', 'cadence'];

const auth = (key: string) => 'Basic ' + btoa('API_KEY:' + key);
const cleanAthlete = (v: unknown) => {
  const s = String(v ?? '').trim();
  if (!s) return '0';
  return /^i?\d+$/.test(s) ? s : '';
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  const supaUrl = Deno.env.get('SUPABASE_URL')!;
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const userClient = createClient(supaUrl, anon, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: 'unauthorized' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* corps vide */ }
  const action = String(body.action ?? 'status');
  const admin = createClient(supaUrl, service);

  if (action === 'status') {
    const { data, error } = await admin.from('intervals_keys').select('athlete_id').eq('user_id', user.id).maybeSingle();
    if (error) return json({ error: 'read_failed' }, 500);
    return json({ connected: !!data, athlete_id: data?.athlete_id ?? null });
  }

  if (action === 'unlink') {
    const { error } = await admin.from('intervals_keys').delete().eq('user_id', user.id);
    if (error) return json({ error: 'delete_failed' }, 500);
    return json({ ok: true });
  }

  if (action === 'link') {
    const key = String(body.api_key ?? '').trim();
    const athlete = cleanAthlete(body.athlete_id);
    if (!key || key.length > 200) return json({ error: 'clé API manquante ou invalide' }, 400);
    if (!athlete) return json({ error: 'identifiant athlète invalide (ex. i123456)' }, 400);
    const r = await fetch(`${API}/athlete/${athlete}`, { headers: { Authorization: auth(key) } });
    if (r.status === 401 || r.status === 403) return json({ error: 'clé refusée par intervals.icu', status: r.status }, 400);
    if (!r.ok) return json({ error: 'intervals.icu injoignable', status: r.status }, 502);
    const a = await r.json();
    const id = String(a.id ?? athlete);
    const { error } = await admin.from('intervals_keys').upsert(
      { user_id: user.id, athlete_id: id, api_key: key, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    );
    if (error) return json({ error: 'store_failed' }, 500);
    return json({ ok: true, athlete_id: id, name: a.name ?? null });
  }

  if (action === 'sync') {
    const { data: k, error: kErr } = await admin.from('intervals_keys').select('*').eq('user_id', user.id).maybeSingle();
    if (kErr) return json({ error: 'read_failed' }, 500);
    if (!k) return json({ error: 'not_connected' }, 409);

    const newest = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const oldest = new Date(Date.now() - IMPORT_DAYS * 86400000).toISOString().slice(0, 10);
    const url = `${API}/athlete/${k.athlete_id}/activities?oldest=${oldest}&newest=${newest}`;
    const r = await fetch(url, { headers: { Authorization: auth(k.api_key) } });
    if (r.status === 401 || r.status === 403) return json({ error: 'clé refusée par intervals.icu', status: r.status }, 502);
    if (r.status === 429) return json({ error: 'rate_limited' }, 429);
    if (!r.ok) return json({ error: 'intervals_failed', status: r.status }, 502);
    const list = await r.json() as Record<string, unknown>[];

    const rows: Record<string, unknown>[] = [];
    let skipped = 0;
    for (const a of list) {
      // Les activités venues de Strava ne sont pas exposées par l'API d'intervals.icu (fiche vide).
      if (!a || a._note || a.source === 'STRAVA' || !a.start_date_local) { skipped++; continue; }
      rows.push({
        user_id: user.id,
        source: 'intervals',
        ext_id: String(a.id),
        strava_id: null,
        start_local: String(a.start_date_local).replace(/Z$/, ''),
        sport_type: a.type ?? null,
        name: a.name ?? null,
        distance_m: a.distance ?? 0,
        moving_time_s: a.moving_time ?? a.elapsed_time ?? 0,
        elevation_gain_m: a.total_elevation_gain ?? 0,
        relative_effort: null,
        training_load: a.icu_training_load ?? null,
        is_trainer: !!a.trainer || a.type === 'VirtualRide',
        raw: a,
      });
    }

    if (rows.length) {
      const { error: upErr } = await admin.from('activities').upsert(rows, { onConflict: 'user_id,source,ext_id' });
      if (upErr) return json({ error: 'store_failed', detail: upErr.message }, 500);
      // Évite les doublons avec l'ancien cache Strava : on ne supprime une ligne Strava que si intervals.icu
      // a la même sortie (même jour, même sport, distance à 3 % près). Le reste du cache Strava est conservé,
      // car l'API Strava n'est plus accessible pour le recharger.
      const earliest = rows.map((x) => String(x.start_local)).sort()[0].slice(0, 10);
      const { data: old } = await admin.from('activities').select('ext_id,start_local,sport_type,distance_m')
        .eq('user_id', user.id).eq('source', 'strava').gte('start_local', earliest);
      const byDay = new Map<string, Record<string, unknown>[]>();
      for (const x of rows) {
        const d = String(x.start_local).slice(0, 10);
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d)!.push(x);
      }
      const dup = (old ?? []).filter((s) => (byDay.get(String(s.start_local).slice(0, 10)) ?? []).some((x) => {
        const ds = Number(s.distance_m) || 0, dx = Number(x.distance_m) || 0;
        const sameSport = String(x.sport_type).replace('Virtual', '') === String(s.sport_type).replace('Virtual', '');
        return sameSport && Math.abs(ds - dx) <= Math.max(300, 0.03 * Math.max(ds, dx));
      })).map((s) => s.ext_id as string);
      for (let i = 0; i < dup.length; i += 200) {
        await admin.from('activities').delete().eq('user_id', user.id).eq('source', 'strava').in('ext_id', dup.slice(i, i + 200));
      }
    }
    return json({ ok: true, imported: rows.length, skipped, from: oldest });
  }

  if (action === 'streams') {
    const id = String(body.ext_id ?? '');
    if (!/^i?\d+$/.test(id)) return json({ error: 'bad_id' }, 400);
    const { data: act } = await admin.from('activities').select('ext_id').eq('user_id', user.id).eq('source', 'intervals').eq('ext_id', id).maybeSingle();
    if (!act) return json({ error: 'not_found' }, 404);
    const { data: k, error: kErr } = await admin.from('intervals_keys').select('*').eq('user_id', user.id).maybeSingle();
    if (kErr) return json({ error: 'read_failed' }, 500);
    if (!k) return json({ error: 'not_connected' }, 409);
    const r = await fetch(`${API}/activity/${id}/streams.json?types=${STREAM_TYPES.join(',')}`, { headers: { Authorization: auth(k.api_key) } });
    if (r.status === 401 || r.status === 403) return json({ error: 'clé refusée par intervals.icu', status: r.status }, 502);
    if (r.status === 404) return json({ error: 'no_streams' }, 404);
    if (r.status === 429) return json({ error: 'rate_limited' }, 429);
    if (!r.ok) return json({ error: 'intervals_failed', status: r.status }, 502);
    const list = await r.json() as { type: string; data: (number | null)[] }[];
    const get = (t: string) => (Array.isArray(list) ? list.find((x) => x && x.type === t) : null)?.data ?? null;
    const time = get('time');
    const n = time?.length ?? 0;
    if (!n) return json({ error: 'no_streams' }, 404);
    const step = Math.max(1, Math.ceil(n / STREAM_POINTS));
    // Moyenne de chaque paquet de `step` points (valeurs absentes ignorées), arrondie à `dec` décimales.
    const pack = (arr: (number | null)[] | null, dec: number) => {
      if (!arr || !arr.some((v) => typeof v === 'number')) return null;
      const out: (number | null)[] = [], f = 10 ** dec;
      for (let i = 0; i < n; i += step) {
        let s = 0, c = 0;
        for (let j = i; j < Math.min(n, i + step); j++) { const v = arr[j]; if (typeof v === 'number' && isFinite(v)) { s += v; c++; } }
        out.push(c ? Math.round((s / c) * f) / f : null);
      }
      return out;
    };
    return json({
      ok: true, n, step,
      time: pack(time, 0), distance: pack(get('distance'), 0), altitude: pack(get('altitude'), 1),
      velocity: pack(get('velocity_smooth'), 2), heartrate: pack(get('heartrate'), 0), watts: pack(get('watts'), 0), cadence: pack(get('cadence'), 0),
    });
  }

  return json({ error: 'action inconnue' }, 400);
});
