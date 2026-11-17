// Lưu sẵn phần khung của app để mở được khi mất mạng. Dữ liệu bản đồ/API không lưu ở đây.
const CACHE = 'canhbao-v2';
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/engine.js', 'js/roads.js', 'js/sources.js', 'js/db.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'icons/icon-192.png', 'icons/icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Mạng trước, mất mạng thì dùng bản đã lưu — để bản cập nhật mới luôn được dùng khi có mạng
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
