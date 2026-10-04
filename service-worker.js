const CACHE_NAME = 'pgb-converter-v1';
const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon.svg',
  './pdf.min.js',
  './pdf.worker.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Запросы на устройство (http://<ip>/upload) и вообще всё постороннее -
  // не трогаем, пусть идёт напрямую в сеть как обычная ссылка.
  if (!event.request.url.startsWith(self.location.origin)) {
    return;
  }
  // Кэш-first: сначала пробуем отдать из кэша (работает даже без интернета
  // вообще, т.к. Service Worker перехватывает запрос ДО попытки сети).
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
