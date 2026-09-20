import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import { getFirestore, doc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { getMessaging, getToken, onMessage, isSupported } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAHxyX5e9O8qQo6Z3VHURgVXhxbxSp0Qh8',
  authDomain: 'paygo-14311.firebaseapp.com',
  projectId: 'paygo-14311',
  storageBucket: 'paygo-14311.firebasestorage.app',
  messagingSenderId: '208360646277',
  appId: '1:208360646277:web:aecc57cc0077ae48a52bec'
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app, 'paygodb');

let messaging = null;
let currentUser = null;

function pushButton() {
  let button = document.getElementById('enablePushNotifications');
  if (button) return button;
  button = document.createElement('button');
  button.id = 'enablePushNotifications';
  button.type = 'button';
  button.innerHTML = '<span style="font-size:16px">🔔</span><span>Ativar notificações</span>';
  Object.assign(button.style, {
    position:'fixed', right:'16px', bottom:'16px', zIndex:'9999',
    display:'none', alignItems:'center', gap:'8px', padding:'12px 15px',
    border:'0', borderRadius:'14px', background:'#2563eb', color:'#fff',
    font:'700 13px system-ui', boxShadow:'0 12px 30px rgba(15,23,42,.22)',
    cursor:'pointer'
  });
  document.body.appendChild(button);
  button.addEventListener('click', enablePush);
  return button;
}

async function getVapidKey() {
  const r = await fetch('/api/push-config', { cache: 'no-store' });
  if (!r.ok) throw new Error('FCM_VAPID_PUBLIC_KEY não configurada no servidor.');
  const data = await r.json();
  if (!data.vapidKey) throw new Error('Chave VAPID ausente.');
  return data.vapidKey;
}

async function tokenId(token) {
  const bytes = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function registerPush(user, requestPermission = false) {
  if (!user || !('Notification' in window) || !('serviceWorker' in navigator)) return false;
  if (!(await isSupported())) return false;

  const permission = Notification.permission === 'granted'
    ? 'granted'
    : requestPermission
      ? await Notification.requestPermission()
      : Notification.permission;

  if (permission !== 'granted') return false;

  const vapidKey = await getVapidKey();
  const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });
  messaging = getMessaging(app);

  const token = await getToken(messaging, {
    vapidKey,
    serviceWorkerRegistration: registration
  });
  if (!token) throw new Error('FCM não devolveu um token.');

  const id = await tokenId(token);
  await setDoc(doc(db, 'users', user.uid, 'pushTokens', id), {
    token,
    platform: 'web',
    browser: navigator.userAgent.slice(0, 300),
    permission: 'granted',
    enabled: true,
    updatedAt: serverTimestamp(),
    createdAt: serverTimestamp()
  }, { merge: true });

  return true;
}

async function enablePush() {
  const button = pushButton();
  button.disabled = true;
  button.innerHTML = '<span>⏳</span><span>A ativar...</span>';
  try {
    const ok = await registerPush(currentUser, true);
    if (ok) {
      button.remove();
    } else {
      button.disabled = false;
      button.innerHTML = '<span>🔔</span><span>Ativar notificações</span>';
    }
  } catch (error) {
    console.error('[paygo-push]', error);
    button.disabled = false;
    button.innerHTML = '<span>⚠️</span><span>Tentar novamente</span>';
  }
}

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) return;

  try {
    const supported = 'Notification' in window && 'serviceWorker' in navigator && await isSupported();
    if (!supported) return;

    if (Notification.permission === 'granted') {
      await registerPush(user, false);
      if (messaging) {
        onMessage(messaging, (payload) => {
          const n = payload.notification || {};
          const d = payload.data || {};
          const title = n.title || d.title || 'PayGo';
          const body = n.body || d.body || 'Tem uma nova notificação.';
          window.dispatchEvent(new CustomEvent('paygo:push', { detail: payload }));
          if (document.visibilityState === 'visible') {
            try { new Notification(title, { body, icon: '/favicon.ico' }); } catch {}
          }
        });
      }
    } else if (Notification.permission === 'default') {
      pushButton().style.display = 'flex';
    }
  } catch (error) {
    console.warn('[paygo-push-init]', error);
  }
});

window.PayGoPush = {
  enable: enablePush,
  isSupported: () => Boolean(messaging)
};
