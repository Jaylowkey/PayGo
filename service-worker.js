const CACHE_NAME = 'paygo-cache-v1';

// Ficheiros essenciais para guardar logo na instalação
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json'
  // Adiciona aqui outros ficheiros locais importantes (ex: imagens de logo, CSS extra)
];

// Instalação do Service Worker e criação da Cache
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Cache criada com sucesso');
        return cache.addAll(ASSETS_TO_CACHE);
      })
  );
  self.skipWaiting();
});

// Activação e limpeza de Caches antigas
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[Service Worker] A apagar cache antiga:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Interceção de pedidos (Estratégia: Network First, Fallback para Cache)
self.addEventListener('fetch', (event) => {
  // Ignorar pedidos POST ou pedidos para URLs de terceiros (como o Firebase e APIs)
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // Se houver internet, guarda uma cópia no cache e devolve a resposta
        const responseClone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseClone);
        });
        return networkResponse;
      })
      .catch(() => {
        // Se falhar (offline), tenta procurar o ficheiro na cache
        return caches.match(event.request);
      })
  );
});
