// Prévision d'un parcours pour les alertes : heure locale, découpage du parcours, météo Open-Meteo, simulation et verdict.
export const AROME = 'meteofrance_seamless';
export const GUST_WARN = 50, GUST_DANGER = 70;

/* ---------- heure locale ---------- */
export function localParts(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) + 1;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute, wd };
}
// date + heure locales → instant (ms), en tenant compte du décalage du fuseau ce jour-là
export function zoned(date: string, time: string, tz: string) {
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = (ms: number) => { const p = localParts(ms, tz); const [Y, M, D] = p.date.split('-').map(Number); return Date.UTC(Y, M - 1, D, p.hour, p.minute) - ms; };
  let t = guess - off(guess); t = guess - off(t); return t;
}
export const addDays = (date: string, k: number) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10); };
export const isoWd = (date: string) => { const [y, m, d] = date.split('-').map(Number); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7 + 1; };

/* ---------- parcours et prévision ---------- */
const RAD = Math.PI / 180;
const hav = (a: number[], b: number[]) => { const dLa = (b[0] - a[0]) * RAD, dLo = (b[1] - a[1]) * RAD;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLo / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
const bearing = (a: number[], b: number[]) => { const y = Math.sin((b[1] - a[1]) * RAD) * Math.cos(b[0] * RAD);
  const x = Math.cos(a[0] * RAD) * Math.sin(b[0] * RAD) - Math.sin(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.cos((b[1] - a[1]) * RAD); return (Math.atan2(y, x) / RAD + 360) % 360; };

type Seg = { km: number; climb: number; brg: number; s: number }; // tronçon entre deux points (s = point météo le plus proche)
export function route(pts: number[][]) {
  const segs: Seg[] = [], cum = [0]; let total = 0, lastEle = pts[0][2];
  for (let i = 1; i < pts.length; i++) {
    const d = hav(pts[i - 1], pts[i]); cum.push(total + d);
    if (d <= 0) continue;
    let climb = 0; const e = pts[i][2];
    if (e != null && lastEle != null) { const dz = e - lastEle; if (Math.abs(dz) >= 3) { if (dz > 0) climb = dz; lastEle = e; } } else if (e != null) lastEle = e;
    segs.push({ km: d, climb, brg: bearing(pts[i - 1], pts[i]), s: 0 }); total += d;
  }
  // points météo : un tous les ~8 km, 13 au plus (Open-Meteo compte chaque point comme un appel)
  const m = Math.max(2, Math.min(12, Math.round(total / 8))), smp: { lat: number; lon: number; km: number }[] = [];
  for (let k = 0, i = 0; k <= m; k++) { const target = total * k / m; while (i < pts.length - 1 && cum[i] < target) i++; smp.push({ lat: pts[i][0], lon: pts[i][1], km: cum[i] }); }
  let a = 0;
  for (const g of segs) { const mid = a + g.km / 2; let best = 0; for (let q = 1; q < smp.length; q++) if (Math.abs(smp[q].km - mid) < Math.abs(smp[best].km - mid)) best = q; g.s = best; a += g.km; }
  return { segs, smp, total };
}

export type Series = { t0: number; pr: number[]; app: number[]; ws: number[]; wd: number[]; gust: number[]; code: number[] };
export async function weather(smp: { lat: number; lon: number }[], from: string, to: string, arome: boolean): Promise<Series[]> {
  const vars = 'apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m';
  // abonnement Open-Meteo « API Standard » (depuis le 29/10/2026) : clé du secret OPENMETEO_API_KEY, sinon API gratuite
  const key = (Deno.env.get('OPENMETEO_API_KEY') || '').trim();
  const url = `https://${key ? 'customer-api' : 'api'}.open-meteo.com/v1/forecast?${key ? 'apikey=' + encodeURIComponent(key) + '&' : ''}latitude=${smp.map(s => s.lat.toFixed(4)).join(',')}&longitude=${smp.map(s => s.lon.toFixed(4)).join(',')}`
    + `&hourly=${vars}${arome ? '&models=' + AROME : ''}&wind_speed_unit=kmh&timeformat=unixtime&timezone=GMT&start_date=${from}&end_date=${to}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.reason || 'open-meteo ' + res.status);
  return (Array.isArray(j) ? j : [j]).map((L: { hourly: Record<string, (number | null)[]> }) => {
    const h = L.hourly, f = (k: string) => (h[k] || []).map(v => v == null ? NaN : v);
    return { t0: h.time[0] as number, pr: f('precipitation'), app: f('apparent_temperature'), ws: f('wind_speed_10m'), wd: f('wind_direction_10m'), gust: f('wind_gusts_10m'), code: f('weather_code') };
  });
}

export type Stats = { rain: number; head: number; headPct: number; tailPct: number; gust: number; amin: number; amax: number; rideH: number; endMs: number; wet: boolean; miss: boolean };
export function ride(R: ReturnType<typeof route>, wx: Series[], startMs: number, speed: number, vam: number): Stats {
  let t = startMs, rain = 0, hs = 0, headKm = 0, tailKm = 0, gust = 0, amin = Infinity, amax = -Infinity, miss = false;
  for (const g of R.segs) {
    const dt = (g.km / speed + g.climb / vam) * 3600e3, mid = t + dt / 2, L = wx[g.s];
    const i = Math.floor((mid / 1000 - L.t0) / 3600), x = (mid / 1000 - L.t0) / 3600 - i;
    if (i < 0 || i + 1 >= L.pr.length || isNaN(L.app[i])) { miss = true; t += dt; continue; }
    const lin = (a: number[]) => isNaN(a[i + 1]) ? a[i] : a[i] + (a[i + 1] - a[i]) * x;
    const ws = lin(L.ws), wd = L.wd[i], hw = ws * Math.cos((wd - g.brg) * RAD);
    rain += (L.pr[Math.min(i + 1, L.pr.length - 1)] || 0) * dt / 3600e3; // pluie de l'heure qui se termine
    hs += hw * g.km; if (hw > 4) headKm += g.km; else if (hw < -4) tailKm += g.km;
    const gu = lin(L.gust); if (isFinite(gu)) gust = Math.max(gust, gu);
    const ap = lin(L.app); amin = Math.min(amin, ap); amax = Math.max(amax, ap);
    t += dt;
  }
  const tot = Math.max(0.1, R.total);
  return { rain, head: hs / tot, headPct: Math.round(headKm / tot * 100), tailPct: Math.round(tailKm / tot * 100), gust, amin, amax,
    rideH: (t - startMs) / 3600e3, endMs: t, wet: rain >= 0.3, miss };
}
// Textes des alertes : français (clé) → autres langues ; {0} = valeur
export const LANGS = ['fr', 'en'];
const EN: Record<string, string> = {
  'grosse pluie ({0} mm)': 'heavy rain ({0} mm)', 'pluie ({0} mm)': 'rain ({0} mm)', 'quelques gouttes': 'a few drops',
  'vent de face ({0} km/h en moyenne)': 'headwind ({0} km/h on average)', 'vent dans le dos': 'tailwind', 'rafales à {0} km/h': 'gusts of {0} km/h',
  'froid': 'cold', 'fraîcheur': 'chilly', 'canicule': 'heatwave', 'chaleur': 'heat', ' et ': ' and ', 'au sec': 'dry',
  'Belles conditions : {0}': 'Great conditions: {0}', 'Au sec, mais {0}': 'Dry, but {0}', ', mais {0}': ', but {0}',
  "Aujourd'hui": 'Today', 'Demain': 'Tomorrow', 'Ton parcours': 'Your route', 'ressenti {0} °C': 'feels like {0} °C',
  'ressenti {0} à {1} °C': 'feels like {0} to {1} °C', 'Prévision incomplète pour ce parcours.': 'Incomplete forecast for this route.',
  'arrivée vers {0}': 'finish around {0}', 'Mieux à {0} ({1})': 'Better at {0} ({1})', 'Alerte de test (météo indisponible : {0}).': 'Test alert (weather unavailable: {0}).',
  'Les alertes fonctionnent sur cet appareil. Choisis un parcours pour recevoir sa météo.': 'Alerts work on this device. Choose a route to get its weather.',
};
// Unités d'affichage du compte (calculs toujours en km/h, °C, mm) : mi = mph et pouces, f = °F
export type Units = { mi: boolean; f: boolean };
export const unitsOf = (a: { dist?: string | null; temp?: string | null }): Units => ({ mi: a.dist === 'mi', f: a.temp === 'f' });
export const cv = { v: (u: Units, kmh: number) => Math.round(u.mi ? kmh * 0.621371 : kmh), t: (u: Units, c: number) => Math.round(u.f ? c * 1.8 + 32 : c),
  r: (u: Units, mm: number) => u.mi ? String(Math.round(mm / 25.4 * 100) / 100) : String(Math.round(mm)) };
export function tr(lang: string, k: string, a: (string | number)[] = [], u?: Units) {
  let r = lang === 'en' && EN[k] != null ? EN[k] : k;
  if (u?.mi) r = r.replace(/(\{\d+\}) km\/h/g, '$1 mph').replace(/(\{\d+\}) mm/g, '$1 in');
  if (u?.f) r = r.replace(/(\{\d+\}) °C/g, '$1 °F');
  return r.replace(/\{(\d+)\}/g, (_m, i) => String(a[+i]));
}
export function verdict(s: Stats, lang = 'fr', u: Units = { mi: false, f: false }) {
  const T = (k: string, a?: (string | number)[]) => tr(lang, k, a, u);
  const neg: string[] = [], pos: string[] = [];
  if (s.rain >= 10) neg.push(T('grosse pluie ({0} mm)', [cv.r(u, s.rain)])); else if (s.rain >= 3) neg.push(T('pluie ({0} mm)', [cv.r(u, s.rain)])); else if (s.rain >= 0.3) neg.push(T('quelques gouttes'));
  if (s.head >= 8 || s.headPct >= 50) neg.push(T('vent de face ({0} km/h en moyenne)', [cv.v(u, Math.max(0, s.head))]));
  else if (s.head <= -8 || s.tailPct >= 50) pos.push(T('vent dans le dos'));
  if (s.gust >= GUST_WARN) neg.push(T('rafales à {0} km/h', [cv.v(u, s.gust)]));
  if (s.amin < 3) neg.push(T('froid')); else if (s.amin < 8) neg.push(T('fraîcheur')); else if (s.amax > 34) neg.push(T('canicule')); else if (s.amax > 30) neg.push(T('chaleur'));
  const list = (a: string[]) => a.length < 2 ? (a[0] || '') : a.slice(0, -1).join(', ') + T(' et ') + a[a.length - 1];
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  const dry = s.rain < 0.3;
  const txt = !neg.length ? T('Belles conditions : {0}', [list([T('au sec'), ...pos])]) : dry ? T('Au sec, mais {0}', [list(neg)]) : cap(list(neg)) + (pos.length ? T(', mais {0}', [list(pos)]) : '');
  const lvl = s.rain >= 3 || s.head >= 20 || s.gust >= GUST_DANGER || s.amin < 0 ? 2 : s.rain >= 0.3 || s.head >= 12 || s.gust >= GUST_WARN || s.amin < 5 || s.amax > 30 ? 1 : 0;
  return { lvl, txt };
}
export const score = (s: Stats) => { const h = Math.max(0.5, s.rideH);
  return s.rain / h * 20 + (s.wet ? 5 : 0) + Math.max(0, 5 - s.amin) * 0.5 + s.headPct / 10 - s.tailPct / 20 + (s.amax > 30 ? (s.amax - 30) * 1.5 : 0) + (s.gust > 40 ? (s.gust - 40) * 0.3 : 0) + (s.miss ? 100 : 0); };

