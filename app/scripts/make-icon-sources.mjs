// Images sources de l'icône et de l'écran de démarrage (dossier app/assets), à partir du logo
// « nuage roulant » de la charte Sillage (même dessin que l'en-tête de la page).
// Ensuite, `capacitor-assets generate` en tire toutes les tailles iPhone et Android (npm run icons).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(APP, 'assets');
fs.mkdirSync(OUT, { recursive: true });

const C = { night: '#14201b', nightDeep: '#121b17', paper: '#f1f3f0', sun: '#e0a21b', rain: '#5ba3da', rainLight: '#3e86c0', ink: '#14201b' };

// Logo (viewBox 0 0 110 100), centré sur (cx, cy) avec une largeur w.
// bold = variante « icône » des PNG du site (icons/sillage-512.png) : traits plus épais, deux gouttes
function mark({ cx, cy, w, ink, rain, bold }) {
  const s = w / 110, x = cx - 55 * s, y = cy - 50 * s;
  const g = bold
    ? { mask: 32, ring: 9.5, sun: 8.7, ray: 4.7, rays: 'M83.20 48.00L86.00 48.00M79.33 57.33L81.31 59.31M70.00 61.20L70.00 64.00M60.67 57.33L58.69 59.31M56.80 48.00L54.00 48.00M60.67 38.67L58.69 36.69M70.00 34.80L70.00 32.00M79.33 38.67L81.31 36.69', drop: 6.4, drops: 'M30.4 83.7L27.5 92.3M46.4 83.7L43.5 92.3' }
    : { mask: 31, ring: 8, sun: 8, ray: 3.5, rays: 'M82 48h5M78.5 56.5l3.5 3.5M70 60v5M61.5 56.5L58 60M58 48h-5M61.5 39.5L58 36M70 36v-5M78.5 39.5L82 36', drop: 5, drops: 'M28 82l-3 9M41 82l-3 9M54 82l-3 9' };
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <defs><mask id="m"><rect x="-20" y="-20" width="150" height="140" fill="#fff"/><circle cx="70" cy="48" r="${g.mask}" fill="#000"/></mask></defs>
    <g fill="${ink}" mask="url(#m)"><circle cx="44" cy="56" r="15"/><rect x="18" y="58" width="56" height="16" rx="8"/></g>
    <circle cx="70" cy="48" r="26" fill="none" stroke="${ink}" stroke-width="${g.ring}"/>
    <path d="${g.rays}" fill="none" stroke="${C.sun}" stroke-width="${g.ray}" stroke-linecap="round"/>
    <circle cx="70" cy="48" r="${g.sun}" fill="${C.sun}"/>
    <path d="${g.drops}" fill="none" stroke="${rain}" stroke-width="${g.drop}" stroke-linecap="round"/>
  </g>`;
}
// Position de la variante icône sur 1024 px : celle de icons/sillage-512.png ×2 (anneau centré en 619, 517 ; 3,625 px par unité ×2)
const ICON = { cx: 619 - (70 - 55) * 7.25, cy: 517 - (48 - 50) * 7.25, w: 110 * 7.25 };
const svg = (W, H, body, bg) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${bg ? `<rect width="${W}" height="${H}" fill="${bg}"/>` : ''}${body}</svg>`);
const png = (buf, f) => sharp(buf).png().toFile(path.join(OUT, f));

// Icône complète (iPhone, Android ancien) : même dessin que l'icône du site, en vectoriel
await png(svg(1024, 1024, mark({ ...ICON, ink: C.paper, rain: C.rain, bold: true }), C.night), 'icon-only.png');
// Android adaptatif : même dessin réduit à 80 % pour tenir dans la zone sûre, fond uni
await png(svg(1024, 1024, mark({ cx: 512 + (ICON.cx - 512) * 0.8, cy: 512 + (ICON.cy - 512) * 0.8, w: ICON.w * 0.8, ink: C.paper, rain: C.rain, bold: true })), 'icon-foreground.png');
await png(svg(1024, 1024, '', C.night), 'icon-background.png');
// Écran de démarrage : logo + « Sillage » (Archivo ExtraBold n'est pas garanti ici : le texte reste dans l'app, pas sur l'écran)
await png(svg(2732, 2732, mark({ cx: 1366, cy: 1340, w: 560, ink: C.paper, rain: C.rain }), C.night), 'splash.png');
await png(svg(2732, 2732, mark({ cx: 1366, cy: 1340, w: 560, ink: C.paper, rain: C.rain }), C.nightDeep), 'splash-dark.png');
console.log('✓ assets/ : icon-only, icon-foreground, icon-background, splash, splash-dark');
