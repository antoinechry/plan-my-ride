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
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${smp.map(s => s.lat.toFixed(4)).join(',')}&longitude=${smp.map(s => s.lon.toFixed(4)).join(',')}`
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
export function verdict(s: Stats) {
  const neg: string[] = [], pos: string[] = [];
  if (s.rain >= 10) neg.push(`grosse pluie (${Math.round(s.rain)} mm)`); else if (s.rain >= 3) neg.push(`pluie (${Math.round(s.rain)} mm)`); else if (s.rain >= 0.3) neg.push('quelques gouttes');
  if (s.head >= 8 || s.headPct >= 50) neg.push(`vent de face (${Math.round(Math.max(0, s.head))} km/h en moyenne)`);
  else if (s.head <= -8 || s.tailPct >= 50) pos.push('vent dans le dos');
  if (s.gust >= GUST_WARN) neg.push(`rafales à ${Math.round(s.gust)} km/h`);
  if (s.amin < 3) neg.push('froid'); else if (s.amin < 8) neg.push('fraîcheur'); else if (s.amax > 34) neg.push('canicule'); else if (s.amax > 30) neg.push('chaleur');
  const list = (a: string[]) => a.length < 2 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' et ' + a[a.length - 1];
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  const dry = s.rain < 0.3;
  const txt = !neg.length ? `Belles conditions : ${list(['au sec', ...pos])}` : dry ? `Au sec, mais ${list(neg)}` : cap(list(neg)) + (pos.length ? `, mais ${list(pos)}` : '');
  const lvl = s.rain >= 3 || s.head >= 20 || s.gust >= GUST_DANGER || s.amin < 0 ? 2 : s.rain >= 0.3 || s.head >= 12 || s.gust >= GUST_WARN || s.amin < 5 || s.amax > 30 ? 1 : 0;
  return { lvl, txt };
}
export const score = (s: Stats) => { const h = Math.max(0.5, s.rideH);
  return s.rain / h * 20 + (s.wet ? 5 : 0) + Math.max(0, 5 - s.amin) * 0.5 + s.headPct / 10 - s.tailPct / 20 + (s.amax > 30 ? (s.amax - 30) * 1.5 : 0) + (s.gust > 40 ? (s.gust - 40) * 0.3 : 0) + (s.miss ? 100 : 0); };

