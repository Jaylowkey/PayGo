import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function getFirebase() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT em falta na Vercel.');

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
  } catch (_) {
    db = getFirestore(app);
  }

  return { auth: getAuth(app), db };
}

async function getUserFromBearer(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    throw new Error('Token Firebase ausente. Faça login novamente.');
  }

  const idToken = authHeader.slice(7).trim();
  const { auth, db } = getFirebase();
  const decoded = await auth.verifyIdToken(idToken);

  const userSnap = await db.collection('users').doc(decoded.uid).get();
  const userData = userSnap.exists ? userSnap.data() || {} : {};

  return {
    uid: decoded.uid,
    email: decoded.email || userData.email || '',
    name: userData.name || decoded.name || userData.fullName || '',
    userData,
  };
}

function getBaseUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  return `${proto}://${host}`;
}

function pickDiditUrl(data) {
  return (
    data?.url ||
    data?.verification_url ||
    data?.session_url ||
    data?.data?.url ||
    data?.data?.verification_url ||
    data?.data?.session_url ||
    data?.session?.url ||
    data?.session?.verification_url ||
    null
  );
}

function pickDiditSessionId(data) {
  return (
    data?.id ||
    data?.session_id ||
    data?.data?.id ||
    data?.data?.session_id ||
    data?.session?.id ||
    null
  );
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método não permitido. Use POST.' });
  }

  try {
    const DIDIT_API_KEY = process.env.DIDIT_API_KEY;
    const DIDIT_WORKFLOW_ID = process.env.DIDIT_WORKFLOW_ID;

    if (!DIDIT_API_KEY) throw new Error('DIDIT_API_KEY em falta na Vercel.');
    if (!DIDIT_WORKFLOW_ID) throw new Error('DIDIT_WORKFLOW_ID em falta na Vercel.');

    const user = await getUserFromBearer(req);
    const { db } = getFirebase();
    const baseUrl = getBaseUrl(req);
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    const fullName = String(body.fullName || user.name || '').trim();
    if (!fullName || fullName.length < 3) {
      return res.status(400).json({ success: false, error: 'Nome completo inválido para KYC.' });
    }

    const now = new Date().toISOString();

    const localSessionRef = await db.collection('kyc_sessions').add({
      userId: user.uid,
      provider: 'didit',
      providerSessionId: null,
      fullName,
      email: user.email,
      status: 'pending',
      riskLevel: 'unknown',
      trustScore: null,
      consent: Boolean(body.consent),
      source: 'paygo_flutter_app',
      createdAt: now,
      updatedAt: now,
    });

    const diditPayload = {
      workflow_id: DIDIT_WORKFLOW_ID,
      vendor_data: JSON.stringify({
        userId: user.uid,
        kycSessionDocId: localSessionRef.id,
        email: user.email,
      }),
      callback_url: `${baseUrl}/api/didit-webhook`,
      redirect_url: body.redirectUrl || `${baseUrl}/kyc-success.html`,
      metadata: {
        app: 'PayGo',
        userId: user.uid,
        email: user.email,
        fullName,
      },
    };

    const diditResponse = await fetch('https://verification.didit.me/v3/session/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-api-key': DIDIT_API_KEY,
      },
      body: JSON.stringify(diditPayload),
    });

    const responseText = await diditResponse.text();
    let diditData;
    try {
      diditData = JSON.parse(responseText);
    } catch (_) {
      diditData = { raw: responseText };
    }

    if (!diditResponse.ok) {
      await localSessionRef.update({
        status: 'failed_to_create',
        error: diditData?.message || diditData?.error || responseText.slice(0, 500),
        updatedAt: new Date().toISOString(),
      });

      return res.status(diditResponse.status).json({
        success: false,
        error: diditData?.message || diditData?.error || 'Falha ao criar sessão Didit.',
        didit: diditData,
      });
    }

    const verificationUrl = pickDiditUrl(diditData);
    const providerSessionId = pickDiditSessionId(diditData);

    await localSessionRef.update({
      providerSessionId,
      verificationUrl,
      diditRaw: diditData,
      updatedAt: new Date().toISOString(),
    });

    await db.collection('kyc_audit_logs').add({
      userId: user.uid,
      kycSessionId: localSessionRef.id,
      provider: 'didit',
      action: 'DIDIT_SESSION_CREATED',
      details: {
        providerSessionId,
        hasVerificationUrl: Boolean(verificationUrl),
      },
      createdAt: new Date().toISOString(),
    });

    await db.collection('users').doc(user.uid).set({
      kycStatus: 'pending',
      kycProvider: 'didit',
      kycSessionId: localSessionRef.id,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return res.status(200).json({
      success: true,
      sessionId: localSessionRef.id,
      providerSessionId,
      verificationUrl,
      url: verificationUrl,
      raw: diditData,
    });
  } catch (error) {
    console.error('didit-create-session error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno ao criar sessão Didit.',
    });
  }
}
