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
    // pas d'effet élastique en haut et en bas : il faisait apparaître le fond sombre de l'app derrière la page
    'html.native{overscroll-behavior-y:none;background:var(--bg)}' +
    'html.native body::before{content:"";position:fixed;left:0;right:0;top:0;height:env(safe-area-inset-top,0px);background:var(--bg);z-index:2147483000;pointer-events:none}' +
    // carte en plein écran : elle passe aussi sous l'heure et l'îlot
    'html.native body.fs-lock::before{display:none}';
  document.head.appendChild(css);
  // et si quelque chose décale malgré tout la page de côté, on la remet en place
  window.addEventListener('scroll', function () { if (window.scrollX) window.scrollTo(0, window.scrollY); }, { passive: true });

  // ---- Diagnostic provisoire (version de test) : signale ce qui dépasse la largeur de l'écran ----
  // Petit bandeau rouge en bas avec le premier élément trop large ; toucher le bandeau le ferme.
  function overflowCheck() {
    if (document.getElementById('sillageDbg')) return;
    var vw = document.documentElement.clientWidth, worst = null;
    var all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++) {
      var x = all[i], r = x.getBoundingClientRect();
      if (!r.width || r.right <= vw + 1 || getComputedStyle(x).position === 'fixed') continue;
      var p = x.parentElement, clipped = false;
      while (p && p !== document.body) { var o = getComputedStyle(p).overflowX; if (o !== 'visible') { clipped = p.getBoundingClientRect().right <= vw + 1; break; } p = p.parentElement; }
      if (clipped) continue;
      if (!worst || r.width > worst.w) worst = { el: x, w: r.width, right: r.right };
    }
    if (!worst) return;
    var e = worst.el, path = [];
    for (var k = 0, q = e; q && q !== document.body && k < 4; k++, q = q.parentElement) path.push(q.tagName.toLowerCase() + (q.id ? '#' + q.id : '') + (typeof q.className === 'string' && q.className ? '.' + q.className.trim().split(/\s+/).slice(0, 2).join('.') : ''));
    var d = document.createElement('div'); d.id = 'sillageDbg';
    d.style.cssText = 'position:fixed;left:8px;right:8px;bottom:calc(90px + env(safe-area-inset-bottom,0px));z-index:2147483646;background:#b5491f;color:#fff;font:12px/1.35 monospace;padding:8px 10px;border-radius:8px;white-space:pre-wrap';
    d.textContent = 'Trop large : ' + Math.round(worst.right) + ' px / écran ' + vw + ' px\n' + path.join(' < ') + '\n« ' + (e.textContent || '').trim().slice(0, 60) + ' »';
    d.addEventListener('click', function () { d.remove(); });
    document.body.appendChild(d);
  }
  setInterval(overflowCheck, 3000);

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
