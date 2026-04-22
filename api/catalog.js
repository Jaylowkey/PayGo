import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const RELOADLY_ENV = String(process.env.RELOADLY_ENV || 'sandbox').toLowerCase();
const RELOADLY_AUDIENCE = 'https://giftcards.reloadly.com';
const TOKEN_URL = 'https://auth.reloadly.com/oauth/token';
const API_BASE = RELOADLY_ENV === 'live'
  ? 'https://giftcards.reloadly.com'
  : 'https://giftcards-sandbox.reloadly.com';

let cachedToken = null;
let tokenExpiresAt = 0;

export function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export function json(res, status, payload) {
  res.status(status).json(payload);
}

export function normalizeBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

export function getFirebase() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT em falta.');
    const serviceAccount = JSON.parse(raw);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    initializeApp({ credential: cert(serviceAccount) });
  }

  const app = getApps()[0];
  let db;
  try {
    db = getFirestore(app, 'paygodb');
  } catch {
    db = getFirestore(app);
  }

  return { db, auth: getAuth(app) };
}

export async function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) throw new Error('Token de autenticação ausente.');
  const idToken = authHeader.slice(7).trim();
  if (!idToken) throw new Error('Token inválido.');

  const { auth, db } = getFirebase();
  const decoded = await auth.verifyIdToken(idToken);
  const userRef = db.collection('users').doc(decoded.uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new Error('Utilizador não encontrado.');

  return {
    uid: decoded.uid,
    email: decoded.email || userSnap.data()?.email || '',
    name: userSnap.data()?.name || decoded.name || 'Cliente PayGo',
    phone: userSnap.data()?.phone || '',
    userRef,
    userData: userSnap.data() || {}
  };
}

export async function getReloadlyAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const client_id = process.env.RELOADLY_CLIENT_ID;
  const client_secret = process.env.RELOADLY_CLIENT_SECRET;
  if (!client_id || !client_secret) throw new Error('Credenciais Reloadly em falta.');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      client_id,
      client_secret,
      grant_type: 'client_credentials',
      audience: RELOADLY_AUDIENCE
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.message || data.error || 'Falha ao autenticar na Reloadly.');
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + ((Number(data.expires_in) || 3600) * 1000);
  return cachedToken;
}

export async function reloadlyGet(path, params = {}) {
  const token = await getReloadlyAccessToken();
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && String(v) !== '') qs.set(k, String(v));
  });
  const url = `${API_BASE}${path}${qs.toString() ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/com.reloadly.giftcards-v1+json, application/json'
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Reloadly GET falhou (${res.status}).`);
  return data;
}

export async function reloadlyPost(path, payload) {
  const token = await getReloadlyAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/com.reloadly.giftcards-v1+json, application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Reloadly POST falhou (${res.status}).`);
  return data;
}

export function calculatePayGoFee(usd, settings = {}) {
  const tax1 = Number(settings.tax1) || 150;
  const tax2 = Number(settings.tax2) || 250;
  const tax3 = Number(settings.tax3) || 600;
  if (usd > 50) return tax3;
  if (usd > 20) return tax2;
  return tax1;
}

export async function getSettings(db) {
  const snap = await db.collection('settings').doc('global').get();
  return snap.exists ? (snap.data() || {}) : {};
}

export async function recordSuccessfulReloadlyOrder({ user, body, reloadlyOrder, exchangeRate, feeMt, totalMt }) {
  const { db } = getFirebase();
  const batch = db.batch();
  const freshSnap = await user.userRef.get();
  const walletBalance = Number(freshSnap.data()?.walletBalance || 0);
  if (walletBalance < totalMt) throw new Error('Saldo insuficiente na carteira.');

  const orderId = `RLD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const reference = reloadlyOrder.transactionId || reloadlyOrder.referenceId || orderId;
  const detail = `[GIFTCARD][RELOADLY] Item: ${body.productName || body.productId} | Destinatário: ${body.recipientName} <${body.recipientEmail}> | Ref Reloadly: ${reference} | USD: ${Number(body.amount).toFixed(2)} | Câmbio: ${exchangeRate} | Taxa: ${Number(feeMt).toFixed(2)} MT | Total: ${Number(totalMt).toFixed(2)} MT | Notas: ${body.notes || 'N/A'}`;

  batch.update(user.userRef, { walletBalance: FieldValue.increment(-totalMt) });
  batch.set(db.collection('wallet_transactions').doc(), {
    userId: user.uid,
    type: 'debit',
    amount: totalMt,
    description: `Gift Card Reloadly: ${body.productName || body.productId}`,
    reference,
    createdAt: new Date().toISOString()
  });
  batch.set(db.collection('orders').doc(), {
    orderId,
    userId: user.uid,
    name: user.name,
    email: user.email,
    category: 'digital',
    type: 'giftcard_reloadly',
    detail,
    usd: Number(body.amount),
    exchangeRate,
    tax: feeMt,
    total: totalMt,
    paymentMethod: 'wallet',
    isPaid: true,
    status: 'completed',
    reloadly: {
      provider: 'reloadly',
      productId: body.productId,
      transactionId: reloadlyOrder.transactionId || null,
      referenceId: reloadlyOrder.referenceId || null,
      recipientEmail: body.recipientEmail,
      recipientName: body.recipientName,
      raw: reloadlyOrder
    },
    createdAt: new Date().toISOString()
  });
  await batch.commit();

  return { orderId, reference, detail };
}
