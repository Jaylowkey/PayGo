// sw.js - Service Worker para PWA PayGo
const CACHE_NAME = 'paygo-v2'; // Subimos a versão para forçar a limpeza nos telemóveis dos clientes
const urlsToCache = [
  '/',
  '/index.html',
  '/login.html',
  '/register.html',
  '/dashboard.html',
  '/admin.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Install Event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('📦 [Service Worker] A carregar cache inicial');
      return cache.addAll(urlsToCache);
    })
  );
  self.skipWaiting();
});

// Activate Event (Limpa caches antigas)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('🧹 [Service Worker] A apagar cache antiga:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch Event (Motor Inteligente de Interceção)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 🔥 BLINDAGEM DE SEGURANÇA: 
  // Nunca fazer cache a chamadas de API ou links que contenham Tokens do Firebase (oobCode)
  if (url.pathname.startsWith('/api/') || url.search.includes('oobCode') || url.search.includes('token') || url.search.includes('mode=')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache normal para o resto do site
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(response => {
      if (response) {
        return response; // Devolve da cache se existir
      }
      
      return fetch(event.request).then(networkResponse => {
        // Validações para não guardar erros na cache
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }
        
        // Apenas clona e guarda pedidos GET seguros
        if (event.request.method === 'GET') {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseToCache);
            });
        }
        
        return networkResponse;
      });
    })
  );
});
