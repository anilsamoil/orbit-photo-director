self.addEventListener('install', (event) => {
  const seed = fetch(new Request('/', { cache: 'reload' })).catch(() => null);
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(null), 8000);
  });
  event.waitUntil(
    Promise.race([seed, timeout]).then((response) => {
      if (!response || !response.ok) return undefined;
      return caches.open('opd-shell').then((cache) => cache.put('/', response));
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim().then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true })).then((clients) => {
    setTimeout(() => {
      for (const client of clients) {
        if (!client.url) continue;
        client.navigate(client.url).catch(() => undefined);
      }
    }, 0);
  }));
});
