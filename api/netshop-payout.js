import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const BASE_URL = (process.env.NETSHOP_API_URL || 'https://www.netshop.co.mz/api/v1').replace(/\/+$/, '');
const MIN_PAYOUT = 1000;

function getFirebase() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT em falta.');
    const account = JSON.parse(raw);
    if (account.private_key) account.private_key = account.private_key.replace(/\\n/g, '\n');
    initializeApp({ credential: cert(account) });
  }
  const app = getApps()[0];
  let firestore;
  try { firestore = getFirestore(app, 'paygodb'); } catch { firestore = getFirestore(app); }
  return { auth: getAuth(app), firestore };
}

async function getAuthenticatedAdmin(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  if (!header.startsWith('Bearer ')) throw new Error('Token de autenticação ausente.');
  const idToken = header.slice(7).trim();
  if (!idToken) throw new Error('Token inválido.');

  const { auth, firestore } = getFirebase();
  const decoded = await auth.verifyIdToken(idToken);
  const snap = await firestore.collection('users').doc(decoded.uid).get();
  if (!snap.exists) throw new Error('Perfil do utilizador não encontrado.');
  const user = snap.data() || {};
  const role = String(user.role || '').toLowerCase();
  if (!['admin', 'superadmin'].includes(role)) throw new Error('Acesso negado. Utilizador não é admin.');
  return { uid: decoded.uid, email: decoded.email || user.email || '', name: user.name || decoded.name || decoded.email || 'Admin PayGo', role };
}

function normalizeMethod(value) {
  const v = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (v === 'mpesa') return 'mpesa';
  if (v === 'emola') return 'emola';
  if (v === 'mkesh') return 'mkesh';
  return '';
}

function walletForMethod(method) {
  return process.env[`NETSHOP_WALLET_${method.toUpperCase()}`] || process.env.NETSHOP_WALLET_ID || '';
}

function cleanPhone(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (/^258\d{9}$/.test(digits)) return `+${digits}`;
  if (/^\d{9}$/.test(digits)) return `+258${digits}`;
  return raw;
}

function money(value) {
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

async function netshopRequest(path, { method = 'GET', body, walletId, idempotencyKey } = {}) {
  const apiKey = process.env.NETSHOP_API_KEY;
  if (!apiKey) throw new Error('NETSHOP_API_KEY não configurada na Vercel.');
  if (!walletId) throw new Error('Wallet NetShop não configurada para este método.');

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Wallet-ID': String(walletId),
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text || `NetShop HTTP ${response.status}` }; }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || data?.error || `NetShop HTTP ${response.status}`;
    const err = new Error(String(message));
    err.status = response.status;
    err.code = data?.error?.code || data?.code || null;
    throw err;
  }
  return data?.data || data;
}

function normalizePayout(row) {
  return {
    id: row.id || null,
    reference: row.reference || null,
    providerPayoutId: row.providerPayoutId || row.payoutId || null,
    status: String(row.status || 'PENDING').toUpperCase(),
    provider: 'netshop',
    amountMinor: Math.round(money(row.amount) * 100),
    feeMinor: Math.round(money(row.feeAmount || row.fee) * 100),
    destination: { method: row.method || null, msisdn: row.msisdn || null },
    wallet: { id: row.walletId || null, currency: row.currency || 'MZN', status: row.walletStatus || 'ACTIVE' },
    createdAt: row.createdAt || new Date().toISOString(),
    updatedAt: row.updatedAt || row.createdAt || new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let admin;
  try { admin = await getAuthenticatedAdmin(req); }
  catch (error) {
    return res.status(error?.message?.includes('Acesso negado') ? 403 : 401).json({ success: false, error: error?.message || 'Não autenticado.' });
  }

  const { firestore } = getFirebase();

  if (req.method === 'GET') {
    const snap = await firestore.collection('netshop_payouts').orderBy('createdAt', 'desc').limit(200).get();
    const payouts = snap.docs.map(doc => normalizePayout({ id: doc.id, ...doc.data() }));
    return res.status(200).json({
      success: true,
      payouts,
      wallets: {
        mpesa: Boolean(process.env.NETSHOP_WALLET_MPESA || process.env.NETSHOP_WALLET_ID),
        emola: Boolean(process.env.NETSHOP_WALLET_EMOLA || process.env.NETSHOP_WALLET_ID),
        mkesh: Boolean(process.env.NETSHOP_WALLET_MKESH || process.env.NETSHOP_WALLET_ID),
      },
      admin: { name: admin.name, role: admin.role },
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Método não permitido.' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const method = normalizeMethod(body.method);
  const amount = money(body.amount);
  const msisdn = cleanPhone(body.msisdn || body.phone || body.destination);
  const reference = String(body.reference || `PG-PAYOUT-${Date.now()}`).trim();
  const idempotencyKey = String(body.idempotencyKey || `paygo-${reference}-${Date.now()}`).trim();

  if (!method) return res.status(400).json({ success: false, error: 'Método inválido. Use M-Pesa, e-Mola ou mKesh.' });
  if (!Number.isFinite(amount) || amount < MIN_PAYOUT) return res.status(400).json({ success: false, error: `O payout mínimo é ${MIN_PAYOUT.toFixed(2)} MT.` });
  if (!/^\+258\d{9}$/.test(msisdn)) return res.status(400).json({ success: false, error: 'Número de destino inválido. Use um número moçambicano com 9 dígitos.' });

  const walletId = walletForMethod(method);
  if (!walletId) return res.status(503).json({ success: false, error: `Wallet NetShop de ${method} não configurada.` });

  const existing = await firestore.collection('netshop_payouts').where('idempotencyKey', '==', idempotencyKey).limit(1).get();
  if (!existing.empty) return res.status(200).json({ success: true, duplicate: true, payout: normalizePayout({ id: existing.docs[0].id, ...existing.docs[0].data() }) });

  const now = new Date().toISOString();
  const localRef = firestore.collection('netshop_payouts').doc();
  await localRef.set({
    provider: 'netshop', reference, method, msisdn, amount, currency: 'MZN', walletId,
    status: 'PROCESSING', idempotencyKey, adminId: admin.uid, adminName: admin.name, createdAt: now, updatedAt: now,
  });

  try {
    const provider = await netshopRequest('/payouts', {
      method: 'POST', walletId, idempotencyKey,
      body: { amount, currency: 'MZN', method, msisdn, reference },
    });

    const payoutId = provider?.id || provider?.payout_id || provider?.payoutId || provider?.provider_reference || null;
    const status = String(provider?.status || 'PROCESSING').toUpperCase();
    await localRef.set({ providerPayoutId: payoutId, providerResponse: provider, status, updatedAt: new Date().toISOString() }, { merge: true });
    await firestore.collection('admin_audit_logs').add({
      adminId: admin.uid, adminName: admin.name, action: 'NETSHOP_PAYOUT_CREATED', targetId: payoutId || localRef.id,
      targetType: 'netshop_payout', details: { amount, method, msisdn, reference, status }, createdAt: now,
    });

    const saved = await localRef.get();
    return res.status(201).json({ success: true, payout: normalizePayout({ id: localRef.id, ...saved.data() }), provider });
  } catch (error) {
    await localRef.set({ status: 'FAILED', error: error?.message || 'Erro NetShop', updatedAt: new Date().toISOString() }, { merge: true });
    return res.status(error?.status >= 400 && error.status < 500 ? error.status : 502).json({ success: false, error: error?.message || 'Não foi possível criar o payout na NetShop.', code: error?.code || null });
  }
}
