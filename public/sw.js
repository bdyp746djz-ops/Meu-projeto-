// App instalável da Rafa Busca Peças.
// Não guarda o sistema em cache (cada abertura pega a versão nova do site): só mostra uma página
// de "sem internet" quando a conexão cai, em vez da tela de erro do iPhone.
const CACHE = 'rafa-v2';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/offline', '/icons/icon-192.png'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method === 'GET' && e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/offline')));
  }
});
