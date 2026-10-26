// Construit app/www (le contenu embarqué dans l'app iPhone / Android) à partir de la page web.
//   node scripts/build-www.mjs          → depuis ../index.html (version en ligne)
//   node scripts/build-www.mjs --test   → depuis ../test.html (nouveautés en essai)
// La page web n'est jamais modifiée : les adaptations sont faites sur la copie, et chacune vérifie
// que le texte attendu est bien là (sinon le script s'arrête et dit lequel a changé).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(APP, '..');
const WWW = path.join(APP, 'www');
const NM = path.join(APP, 'node_modules');
const TEST = process.argv.includes('--test');
const SRC = path.join(ROOT, TEST ? 'test.html' : 'index.html');
const WEB = 'https://antoinechry.github.io/plan-my-ride/';

const die = m => { console.error('✗ ' + m); process.exit(1); };
const cp = (a, b) => { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(a, b); };

// 1. Dossier propre
fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(path.join(WWW, 'vendor', 'fonts'), { recursive: true });

// 2. Bibliothèques et polices embarquées (l'app démarre sans réseau, et sans dépendre d'un CDN)
const LF = path.join(NM, 'leaflet', 'dist');
cp(path.join(LF, 'leaflet.js'), path.join(WWW, 'vendor', 'leaflet', 'leaflet.js'));
cp(path.join(LF, 'leaflet.css'), path.join(WWW, 'vendor', 'leaflet', 'leaflet.css'));
for (const f of fs.readdirSync(path.join(LF, 'images'))) cp(path.join(LF, 'images', f), path.join(WWW, 'vendor', 'leaflet', 'images', f));

const FONTS = [['archivo', [400, 500, 600, 700, 800]], ['ibm-plex-mono', [400, 500]]];
let fontCss = '/* Archivo et IBM Plex Mono (SIL Open Font License), alphabets latin et latin étendu */\n';
for (const [fam, weights] of FONTS) {
  for (const w of weights) {
    const css = fs.readFileSync(path.join(NM, '@fontsource', fam, `${w}.css`), 'utf8');
    for (const block of css.match(/\/\*[^*]*\*\/\s*@font-face\s*{[^}]*}/g) || []) {
      if (!/\/\*\s*[\w-]+-(latin|latin-ext)-\d+-normal\s*\*\//.test(block)) continue;
      fontCss += block.replace(/url\(\.\/files\/([^)]+)\)/g, (m, f) => {
        if (f.endsWith('.woff2')) cp(path.join(NM, '@fontsource', fam, 'files', f), path.join(WWW, 'vendor', 'fonts', f));
        return `url(fonts/${f})`;
      }).replace(/,\s*url\(fonts\/[^)]+\.woff\)\s*format\('woff'\)/g, '') + '\n';
    }
  }
}
if (!/Archivo/.test(fontCss) || !/IBM Plex Mono/.test(fontCss)) die('polices introuvables dans @fontsource');
fs.writeFileSync(path.join(WWW, 'vendor', 'fonts.css'), fontCss);

// 3. Fichiers de la page
cp(path.join(ROOT, 'lang.js'), path.join(WWW, 'lang.js'));
for (const f of fs.readdirSync(path.join(ROOT, 'icons'))) cp(path.join(ROOT, 'icons', f), path.join(WWW, 'icons', f));
cp(path.join(APP, 'native', 'native.js'), path.join(WWW, 'native.js'));

// 4. La page, adaptée à l'app
let h = fs.readFileSync(SRC, 'utf8');
const swap = (what, from, to, all = false) => {
  const n = h.split(from).length - 1;
  if (!n) die(`« ${what} » introuvable dans ${path.basename(SRC)} : la page a changé, adapter build-www.mjs`);
  h = all ? h.split(from).join(to) : h.replace(from, to);
};
const swapRe = (what, re, to) => { if (!re.test(h)) die(`« ${what} » introuvable dans ${path.basename(SRC)}`); h = h.replace(re, to); };

// pont natif, avant tout autre script
swap('balise viewport', '<meta name="viewport"', '<script src="native.js"></script>\n<meta name="viewport"');
// app : largeur d'affichage figée sur celle de l'écran, sans zoom de la page (sinon iOS élargit toute la zone
// d'affichage dès qu'un élément dépasse, et les panneaux fixes se retrouvent coupés à droite)
swapRe('contenu de la balise viewport', /<meta name="viewport" content="[^"]*">/, '<meta name="viewport" content="width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">');
// plus de manifeste ni de service worker web : l'app est déjà installée
swapRe('lien du manifeste', /<link rel="manifest" href="[^"]+">\n?/, '');
// polices et Leaflet en local
swapRe('Google Fonts', /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\n<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>\n<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]+" rel="stylesheet">/, '<link rel="stylesheet" href="vendor/fonts.css">');
swap('Leaflet CSS', 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css', 'vendor/leaflet/leaflet.css');
swap('Leaflet JS', 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js', 'vendor/leaflet/leaflet.js');
// « Mot de passe oublié ? » : le lien de l'e-mail ne peut pas revenir dans l'app → page web
swap('redirection du mot de passe oublié', 'redirectTo: location.origin + location.pathname', `redirectTo: (window.SILLAGE_WEB || location.origin + location.pathname)`);
// Admin : reste une page web (ouverte dans le navigateur du téléphone)
swap('lien Admin', `href="${TEST ? 'admin-test.html' : 'admin.html'}"`, `href="${WEB}${TEST ? 'admin-test.html' : 'admin.html'}"`, true);

fs.writeFileSync(path.join(WWW, 'index.html'), h);

const size = d => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`✓ www construit depuis ${path.basename(SRC)} (${(size(WWW) / 1024).toFixed(0)} Ko)`);
