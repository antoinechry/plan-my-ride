/* Sillage — pont natif (app iPhone / Android, Capacitor).
   Chargé seulement dans l'app, avant le script principal (inséré par scripts/build-www.mjs).
   index.html reste la même page que sur le web : ce fichier ne fait que combler ce que la WebView
   ne sait pas faire seule. */
(function () {
  var Cap = window.Capacitor;
  if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;
  var P = Cap.Plugins || {};
  var platform = Cap.getPlatform();

  // Repères pour la page (CSS : html.native, html.native-ios, html.native-android)
  window.SILLAGE_NATIVE = platform;
  window.SILLAGE_WEB = 'https://antoinechry.github.io/plan-my-ride/index.html';
  document.documentElement.classList.add('native', 'native-' + platform);

  // ---- Encoche / îlot et barre d'état -----------------------------------------
  // Dans Safari, la barre d'adresse réserve le haut de l'écran ; dans l'app, la page commence
  // sous l'heure et l'îlot. On décale la page et on pose un bandeau de la couleur du fond
  // derrière la barre d'état, pour que rien ne défile dessous.
  var css = document.createElement('style');
  css.textContent =
    'html.native body{padding-top:env(safe-area-inset-top,0px)}' +
    // pas de défilement de côté : la page et les panneaux ne bougent que de haut en bas
    'html.native,html.native body{overflow-x:hidden;overscroll-behavior-x:none}' +
    'html.native body::before{content:"";position:fixed;left:0;right:0;top:0;height:env(safe-area-inset-top,0px);background:var(--bg);z-index:2147483000;pointer-events:none}';
  document.head.appendChild(css);

  // ---- Fichiers : export image, CSV, GPX -----------------------------------
  // La WebView ne sait ni télécharger (<a download>) ni partager des fichiers (navigator.share
  // absent sur Android) : on écrit le fichier dans le cache de l'app puis on ouvre la feuille
  // de partage du téléphone (Enregistrer dans Photos / Fichiers, WhatsApp, Strava…).
  function toB64(blob) {
    return new Promise(function (ok, ko) {
      var r = new FileReader();
      r.onload = function () { ok(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { ko(r.error); };
      r.readAsDataURL(blob);
    });
  }
  function safeName(n) { return String(n || 'sillage').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120); }
  async function shareFiles(files, title) {
    if (!P.Filesystem || !P.Share) throw new Error('plugins absents');
    var uris = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var w = await P.Filesystem.writeFile({ path: safeName(f.name), data: await toB64(f), directory: 'CACHE' });
      uris.push(w.uri);
    }
    await P.Share.share({ title: title || 'Sillage', files: uris, dialogTitle: title || 'Sillage' });
  }

  // navigator.share({ files }) : utilisé par l'export image
  var webShare = navigator.share && navigator.share.bind(navigator);
  try {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: function () { return true; } });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async function (data) {
        data = data || {};
        if (data.files && data.files.length) {
          try { return await shareFiles(data.files, data.title); }
          catch (e) { if (/cancel/i.test(String(e && (e.message || e)))) { var a = new Error('AbortError'); a.name = 'AbortError'; throw a; } throw e; }
        }
        if (P.Share) return P.Share.share({ title: data.title, text: data.text, url: data.url });
        if (webShare) return webShare(data);
      }
    });
  } catch (e) {}

  // <a download href="blob:…">.click() : utilisé par le CSV, le GPX et l'export si le partage échoue
  var aClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var a = this;
    if (a.hasAttribute('download') && /^(blob|data):/.test(a.href)) {
      fetch(a.href).then(function (r) { return r.blob(); })
        .then(function (b) { return shareFiles([new File([b], a.getAttribute('download') || 'sillage', { type: b.type })]); })
        .catch(function (e) { console.warn('Sillage: partage impossible', e); });
      return;
    }
    return aClick.call(a);
  };

  // ---- Bouton retour d'Android ---------------------------------------------
  // Même ordre que la touche Échap de la page : fenêtre, carte plein écran, panneau, page, puis l'app passe en arrière-plan.
  function esc() { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }
  if (P.App) P.App.addListener('backButton', function () {
    var dl = document.querySelectorAll('dialog[open]');
    if (dl.length) { dl[dl.length - 1].close(); return; }
    var b = document.body, fs = document.getElementById('mapCard');
    if ((fs && fs.classList.contains('map-fs')) || b.classList.contains('sheet-open') || b.classList.contains('lib-open')) { esc(); return; }
    P.App.minimizeApp();
  });

  // ---- Lien d'alerte ou lien testeur ouvert dans l'app -----------------------
  // https://…/index.html?route=…&date=…&time=… ou ?invite=CODE → même page, mêmes paramètres.
  if (P.App) P.App.addListener('appUrlOpen', function (ev) {
    try {
      var u = new URL(ev.url), q = u.search;
      if (q && q !== location.search) location.replace(location.pathname + q + (u.hash || ''));
    } catch (e) {}
  });

  // ---- Barre d'état : texte clair sur fond sombre, et l'inverse ---------------
  function isDark() {
    var t = document.documentElement.getAttribute('data-theme');
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function bar() {
    if (!P.StatusBar) return;
    var dark = isDark();
    P.StatusBar.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(function () {});
    if (platform === 'android') P.StatusBar.setBackgroundColor({ color: dark ? '#121b17' : '#f1f3f0' }).catch(function () {});
  }
  new MutationObserver(bar).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', bar);
  document.addEventListener('DOMContentLoaded', bar);
})();
