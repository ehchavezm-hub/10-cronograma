// sw.js — Service Worker para cache-first offline
// Versión: incrementar al desplegar cambios a assets
const CACHE = 'cronogramas-v187';

// Assets del shell de la app que siempre se cachean en la instalación
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './fonts/fonts.css',
  './css/tokens.css?v=100',
  './css/layout.css?v=100',
  './css/components.css?v=100',
  './css/print.css?v=102',
  './js/main.js?v=103',
  './js/auth.js?v=180',
  './js/state.js',
  './js/storage.js',
  './js/config.js',
  './js/i18n.js',
  './js/calendar.js',
  './js/cpm.js',
  './js/scene.js',
  './js/gantt-canvas.js',
  './js/wbs-table.js?v=100',
  './js/lookahead-detailed.js',
  './js/evm.js',
  './js/dcma.js',
  './js/demo-data.js',
  './js/demo-seed.js',
  './js/io.js',
  './js/print.js',
  './js/sync.js',
  './js/baseline.js',
  './js/change-log.js',
  './js/gantt-svg.js',
  './js/supabase.js',
  './js/xer-import.js',
  './js/resource-leveling.js',
  './js/monte-carlo.js',
  './js/risk-register.js',
  './js/baseline-compare.js',
  './js/lookahead.js',
  './js/curva-s.js',
  './js/notifications.js',
  './js/wbs-dictionary.js',
  './js/pdf-report.js',
  './js/pdf-utils.js',
  './js/reports.js',
  './js/resource-histogram.js',
  './js/workers/monte-carlo.worker.js',
  './js/cache.js',
  './js/async-queue.js',
  './js/plataforma-admin.js',
  './js/vendor/xlsx.full.min.js',
];

// ---- Install: pre-cachear el shell ----
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.allSettled(SHELL.map(url => cache.add(url).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

// ---- Activate: limpiar caches antiguas ----
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ---- Fetch: cache-first para assets, network-first para datos ----
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Solo manejar GET de mismo origen
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // Supabase y peticiones de API → network-only
  if (url.hostname.endsWith('supabase.co') || url.pathname.startsWith('/rest/')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      // No en cache → red y cachear
      return fetch(e.request).then(response => {
        if (response.ok && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline y no cacheado → devolver index.html para rutas de app
        if (e.request.headers.get('accept')?.includes('text/html')) {
          return caches.match('./index.html');
        }
      });
    })
  );
});
