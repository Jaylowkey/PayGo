importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyAHxyX5e9O8qQo6Z3VHURgVXhxbxSp0Qh8',
  authDomain: 'paygo-14311.firebaseapp.com',
  projectId: 'paygo-14311',
  storageBucket: 'paygo-14311.firebasestorage.app',
  messagingSenderId: '208360646277',
  appId: '1:208360646277:web:aecc57cc0077ae48a52bec'
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const notification = payload.notification || {};
  const data = payload.data || {};
  const title = notification.title || data.title || 'PayGo';
  const body = notification.body || data.body || 'Tem uma nova notificação.';
  const link = data.link || notification?.click_action || 'https://www.paygo.co.mz/dashboard.html';

  self.registration.showNotification(title, {
    body,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: { link },
    tag: data.campaignId || 'paygo-notification'
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification?.data?.link || 'https://www.paygo.co.mz/dashboard.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          try {
            const url = new URL(link);
            if (new URL(client.url).origin === url.origin) {
              client.navigate(link);
              return client.focus();
            }
          } catch {}
        }
      }
      return clients.openWindow(link);
    })
  );
});
