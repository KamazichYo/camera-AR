// Service worker: офлайн-режим. Оболочка приложения — «сеть, затем кэш»,
// OpenCV.js с CDN — «кэш, затем сеть» (файл большой и версия зафиксирована).
const VERSION = 'artcam-v12';
const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest',
  'js/app.js', 'js/geometry.js', 'js/stage.js', 'js/camera.js', 'js/recorder.js',
  'js/reference.js', 'js/tracker.js', 'js/tracker.worker.js', 'js/syncview.js', 'js/glframes.js', 'js/storage.js',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'artcam-cdn').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (/opencv-js@[\d.]+-release/.test(url.pathname)) {
    e.respondWith(caches.open('artcam-cdn').then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })),
  );
});
