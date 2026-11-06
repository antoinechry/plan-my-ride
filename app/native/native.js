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

  // ---- Écran de démarrage animé ----------------------------------------------
  // iOS impose un écran de lancement fixe (image) : on le prolonge par le même dessin, animé, posé
  // par-dessus la page, puis on retire l'écran natif sans fondu une fois notre écran affiché.
  // Même fond (#14201b), même logo à la même taille et au même endroit que assets/splash.png
  // (logo de 760 px centré à 1366, 1290 sur 2732 px, affiché en « aspect fill » : 1 px d'image = 100vmax / 2732).
  var SPLASH_MS = 3000, SPLASH_FADE = 300;
  var splashCss =
    '.app-splash{position:fixed;inset:0;z-index:2147483100;background:#14201b;transition:opacity .3s ease}' +
    '.app-splash.out{opacity:0;pointer-events:none}' +
    // l'écran de connexion masque tout le body sauf lui (body.gated > :not(.gate){display:none!important}) :
    // notre écran doit rester visible, connecté·e ou pas (spécificité plus forte que cette règle)
    'html.native body.gated>.app-splash,html.native body.public>.app-splash{display:block!important}' +
    '.app-splash-logo{position:absolute;left:50%;top:calc(50% - 2.8vmax);width:27.8vmax;height:25.3vmax;transform:translate(-50%,-50%)}' +
    '.app-splash-logo .ink{fill:#eef1ec}' +
    '.app-splash-logo .wheel{transform-origin:70px 48px;animation:app-wheel 2.4s linear infinite}' +
    '.app-splash-logo .ring{fill:none;stroke:#eef1ec;stroke-width:8}' +
    '.app-splash-logo .ray{fill:none;stroke:#e0a21b;stroke-width:3.5;stroke-linecap:round}' +
    '.app-splash-logo .sun{fill:#e0a21b}' +
    '.app-splash-logo .drop{fill:none;stroke:#5ba3da;stroke-width:5;stroke-linecap:round;animation:app-drop 1.6s cubic-bezier(.4,0,.8,.6) infinite}' +
    '.app-splash-logo .d2{animation-delay:.5s}.app-splash-logo .d3{animation-delay:1s}' +
    '@keyframes app-wheel{to{transform:rotate(360deg)}}' +
    '@keyframes app-drop{0%{transform:translateY(-4px);opacity:0}15%{opacity:1}75%{opacity:1}100%{transform:translateY(22px);opacity:0}}' +
    // le nom et le crédit apparaissent en fondu : l'écran natif ne montre que le logo
    '.app-splash-name{position:absolute;left:0;right:0;top:calc(50% + 10.9vmax);margin:0;text-align:center;font:800 4.6vmax/1 Archivo,system-ui,sans-serif;letter-spacing:-.03em;color:#eef1ec;animation:app-in .4s ease .15s both}' +
    '.app-splash-name b{font-weight:800;color:#e0a21b}' +
    '.app-splash-credit{position:absolute;left:0;right:0;bottom:calc(30px + env(safe-area-inset-bottom,0px));display:flex;align-items:center;justify-content:center;gap:10px;animation:app-in .4s ease .15s both}' +
    '.app-splash-txt{font:700 13px/1 Archivo,system-ui,sans-serif;letter-spacing:.14em;color:#fff}' +
    '.app-splash-btt{height:30px;width:auto;display:block}' +
    '@keyframes app-in{from{opacity:0}to{opacity:1}}' +
    '@media (prefers-reduced-motion:reduce){.app-splash-logo .wheel,.app-splash-logo .drop{animation:none}}' +
    'html[data-motion="reduce"] .app-splash-logo .wheel,html[data-motion="reduce"] .app-splash-logo .drop{animation:none}';
  var splashHtml =
    '<svg class="app-splash-logo" viewBox="0 0 110 100" aria-hidden="true">' +
    '<defs><mask id="appSplashMask"><rect x="-10" y="-10" width="130" height="120" fill="#fff"/><circle cx="70" cy="48" r="31" fill="#000"/></mask></defs>' +
    '<g class="ink" mask="url(#appSplashMask)"><circle cx="44" cy="56" r="15"/><rect x="18" y="58" width="56" height="16" rx="8"/></g>' +
    '<g class="wheel"><circle class="ring" cx="70" cy="48" r="26"/><path class="ray" d="M82 48h5M78.5 56.5l3.5 3.5M70 60v5M61.5 56.5L58 60M58 48h-5M61.5 39.5L58 36M70 36v-5M78.5 39.5L82 36"/></g>' +
    '<circle class="sun" cx="70" cy="48" r="8"/>' +
    '<path class="drop d1" d="M28 82l-3 9"/><path class="drop d2" d="M41 82l-3 9"/><path class="drop d3" d="M54 82l-3 9"/></svg>' +
    '<p class="app-splash-name">Sillage<b>.cc</b></p>' +
    '<div class="app-splash-credit"><span class="app-splash-txt">POWERED BY</span><img class="app-splash-btt" src="btt-logo.png" alt="Beyond The Track"></div>';
  var splashStyle = document.createElement('style');
  splashStyle.textContent = splashCss;
  document.head.appendChild(splashStyle);
  var nativeHidden = false;
  function hideNative() {
    if (nativeHidden) return;
    nativeHidden = true;
    if (P.SplashScreen) P.SplashScreen.hide({ fadeOutDuration: 0 }).catch(function () {});
  }
  // filet de sécurité : l'écran natif part quoi qu'il arrive au bout de 1,5 s
  setTimeout(hideNative, 1500);
  function splashStart() {
    var el = document.createElement('div');
    el.className = 'app-splash';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = splashHtml;
    document.body.insertBefore(el, document.body.firstChild);
    var img = el.querySelector('img');
    var t0 = Date.now();
    function ready() {
      // deux images rendues avant de retirer l'écran natif, pour ne jamais montrer un fond vide
      requestAnimationFrame(function () { requestAnimationFrame(hideNative); });
    }
    if (img.complete) ready(); else { img.onload = ready; img.onerror = ready; }
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { el.remove(); }, SPLASH_FADE);
    }, Math.max(0, SPLASH_MS - (Date.now() - t0)));
  }
  if (document.body) splashStart(); else document.addEventListener('DOMContentLoaded', splashStart);

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
