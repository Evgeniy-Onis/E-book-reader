// Версию увеличивайте при каждом обновлении файлов приложения — иначе телефоны
// будут показывать старую закэшированную версию.
const CACHE_NAME = 'pgb-converter-v4';

const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './pgb.js',
  './pdftext.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './pdf.mjs',
  './pdf.worker.mjs'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Каждый файл отдельно: если какого-то нет (например, забыли положить pdf.mjs),
    // остальное всё равно закэшируется, а в консоли будет понятно, чего не хватает.
    const results = await Promise.allSettled(
      PRECACHE_URLS.map((u) => cache.add(new Request(u, { cache: 'reload' })))
    );
    results.forEach((r, i) => { if (r.status === 'rejected') console.warn('SW: не закэширован', PRECACHE_URLS[i]); });
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Всё постороннее (в т.ч. http://<ip ридера>/upload) и не-GET не трогаем.
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;

  // Кэш-first: приложение открывается даже без какой-либо сети (Service Worker
  // отвечает ДО попытки сходить в сеть).
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      return await fetch(req);
    } catch (e) {
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw e;
    }
  })());
});
