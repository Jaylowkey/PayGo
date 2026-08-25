import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createPayout } from './lib/services/zumbopay.js';

function getFirebase() {
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
  try { db = getFirestore(app, 'paygodb'); } catch { db = getFirestore(app); }
  return { db, auth: getAuth(app) };
}

async function authenticateAdmin(req, body) {
  const { db, auth } = getFirebase();
  const header = req.headers.authorization || req.headers.Authorization || '';

  let uid = '';
  if (String(header).startsWith('Bearer ')) {
    const token = String(header).slice(7).trim();
    const decoded = await auth.verifyIdToken(token);
    uid = decoded.uid;
  } else {
    // Compatibilidade com o modal B2C atual. O UID é validado contra Firestore.
    uid = String(body.adminId || '').trim();
  }

  if (!uid) throw new Error('Autenticação administrativa em falta.');

  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) throw new Error('Perfil administrativo não encontrado.');

  const user = userSnap.data() || {};
  const role = String(user.role || '').toLowerCase();
  if (!['admin', 'superadmin'].includes(role)) {
    const err = new Error('Acesso negado. Apenas administradores podem executar B2C.');
    err.status = 403;
    throw err;
  }

  return { uid, name: user.name || 'Admin PayGo', role, db };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://paygo.co.mz');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Método não permitido.' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  if (String(body.withdrawalId || '') !== 'MANUAL_PAYOUT') {
    return res.status(400).json({ success: false, error: 'Operação B2C inválida.' });
  }

  const amount = Number(body.targetAmount ?? body.amount);
  const method = String(body.targetMethod ?? body.method ?? '').toLowerCase().trim();
  const destination = String(body.targetPhone ?? body.destination ?? '').trim();

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Valor da transferência inválido.' });
  }
  if (!['mpesa', 'emola'].includes(method)) {
    return res.status(400).json({ success: false, error: 'Método inválido. Use M-Pesa ou e-Mola.' });
  }
  if (!destination) {
    return res.status(400).json({ success: false, error: 'Número de destino é obrigatório.' });
  }

  let admin;
  try {
    admin = await authenticateAdmin(req, body);
  } catch (error) {
    return res.status(error.status || 401).json({ success: false, error: error.message || 'Não autenticado.' });
  }

  const now = new Date().toISOString();

  try {
    const payout = await createPayout({
      amount,
      method,
      destination,
      notes: String(body.notes || 'Transferência Manual B2C PayGo').slice(0, 500),
      autoDispatch: method === 'mpesa',
      walletId: body.walletId || undefined,
    });

    await admin.db.collection('zumbopay_payouts').add({
      id: payout.payoutId || null,
      provider: 'zumbopay',
      payoutId: payout.payoutId || null,
      reference: payout.reference || null,
      providerReference: payout.providerReference || null,
      status: payout.status || 'pending',
      method: payout.method || method,
      destination: payout.destination || destination,
      amount: payout.amount || amount,
      feeAmount: payout.feeAmount || 0,
      netAmount: payout.netAmount || 0,
      currency: payout.currency || 'MZN',
      adminId: admin.uid,
      adminName: admin.name,
      source: 'dashboard_manual_b2c',
      createdAt: now,
      updatedAt: now,
    });

    await admin.db.collection('admin_audit_logs').add({
      adminId: admin.uid,
      adminName: admin.name,
      action: 'MANUAL_B2C_PAYOUT_CREATED',
      targetId: payout.payoutId || payout.reference || 'MANUAL_PAYOUT',
      targetType: 'zumbopay_payout',
      details: {
        amount,
        method,
        destination: payout.destination || destination,
        status: payout.status || 'pending',
        reference: payout.reference || null,
      },
      createdAt: now,
    });

    return res.status(200).json({ success: true, data: payout, message: 'Transferência B2C criada com sucesso.' });
  } catch (error) {
    console.error('❌ Manual B2C payout:', error);
    return res.status(error.status >= 400 && error.status < 500 ? error.status : 502).json({
      success: false,
      error: error.message || 'Não foi possível executar a transferência B2C.',
      code: error.code || null,
    });
  }
}
