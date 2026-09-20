/* OnPatrol service worker
   Keeps the app itself (page, libraries, fonts, face-recognition models) available with no signal.
   It never touches the OnPatrol database, login or realtime traffic — those always go straight to the network.
   Put this file next to index.html (same folder, served over https). */

const VERSION = 'v1';
const SHELL = 'onpatrol-shell-' + VERSION;
const LIBS = 'onpatrol-libs-' + VERSION;

const LIB_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

const LIB_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js',
  'https://cdn.jsdelivr.net/npm/qr-scanner@1.4.2/qr-scanner.umd.min.js',
  'https://cdn.jsdelivr.net/npm/qr-scanner@1.4.2/qr-scanner-worker.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js',
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap'
];

const MODEL_BASE = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js/weights/';
const MODEL_FILES = [
  'tiny_face_detector_model-weights_manifest.json', 'tiny_face_detector_model-shard1',
  'face_landmark_68_model-weights_manifest.json', 'face_landmark_68_model-shard1',
  'face_recognition_model-weights_manifest.json', 'face_recognition_model-shard1', 'face_recognition_model-shard2'
].map(f => MODEL_BASE + f);

// Libraries are always fetched in CORS mode so they can be stored (opaque responses can't be cached safely).
function corsRequest(url){ return new Request(url, { mode: 'cors', credentials: 'omit' }); }

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // Best effort: one failed file must not stop the rest from being saved.
    const shell = await caches.open(SHELL);
    await shell.add(new Request(self.registration.scope, { cache: 'reload' })).catch(() => {});
    const libs = await caches.open(LIBS);
    await Promise.all(LIB_URLS.concat(MODEL_FILES).map(url =>
      fetch(corsRequest(url)).then(res => { if (res.ok) return libs.put(url, res); }).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = [SHELL, LIBS];
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('onpatrol-') && !keep.includes(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Open the page from the network when it answers quickly, otherwise from the saved copy.
async function pageRequest(req){
  const cache = await caches.open(SHELL);
  const network = fetch(req).then(res => {
    if (res && res.ok){ cache.put(req, res.clone()); cache.put(self.registration.scope, res.clone()); }
    return res;
  });
  network.catch(() => {});   // handled below; stops a late failure from being reported as an error
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), 3500));
  try{
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  }catch(e){ /* offline */ }
  return (await cache.match(req, { ignoreSearch: true })) || (await cache.match(self.registration.scope)) || network.catch(() => Response.error());
}

async function staleWhileRevalidate(req, cacheName, forceCors){
  const cache = await caches.open(cacheName);
  const key = req.url;
  const cached = await cache.match(key);
  const network = fetch(forceCors ? corsRequest(req.url) : req).then(res => {
    if (res && res.ok) cache.put(key, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('.supabase.co')) return;            // database, login, functions, realtime: always live
  if (req.mode === 'navigate'){ event.respondWith(pageRequest(req)); return; }
  if (url.origin === self.location.origin){ event.respondWith(staleWhileRevalidate(req, SHELL, false)); return; }
  if (LIB_HOSTS.includes(url.hostname)){ event.respondWith(staleWhileRevalidate(req, LIBS, true)); return; }
  // anything else (map tiles, etc.) goes straight to the network
});
