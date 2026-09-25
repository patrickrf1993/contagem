// Guarda a página no aparelho para ela abrir mesmo sem sinal.
// As chamadas à /api nunca passam pelo cache: a página cuida delas.
const CACHE = 'contagem-v3';
const ARQUIVOS = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const chave = req.mode === 'navigate' ? '/' : req;
  // tenta a rede por até 4 s (para pegar versões novas); se falhar ou demorar, usa o que está guardado
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const guardado = await cache.match(chave);
    const daRede = fetch(req).then(r => { if (r.ok) cache.put(chave, r.clone()); return r; });
    if (!guardado) return daRede.catch(() => new Response('Sem conexão', { status: 503 }));
    const limite = new Promise(ok => setTimeout(() => ok(guardado), 4000));
    return Promise.race([daRede.catch(() => guardado), limite]);
  })());
});
