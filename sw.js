// Service worker de Plan My Ride (depuis le 25/10/2026) : alertes météo (notifications Web Push).
// Pas de cache ni d'interception des requêtes : la page reste toujours celle du site.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Plan My Ride', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png',
    tag: d.tag || 'pmr', renotify: true, data: { url: d.url || './' },
  }));
});

// Toucher la notification : ouvre le parcours au bon jour et à la bonne heure (page déjà ouverte réutilisée).
self.addEventListener('notificationclick', e => {
  e.notification.close();
  let url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope);
  if (url.origin !== self.location.origin) url = new URL('./', self.registration.scope);
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if (new URL(c.url).pathname === url.pathname && 'navigate' in c) {
        try { await c.navigate(url.href); } catch (_) { /* page d'une autre origine */ }
        return c.focus();
      }
    }
    return self.clients.openWindow(url.href);
  })());
});
