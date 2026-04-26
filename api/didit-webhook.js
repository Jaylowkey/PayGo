import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-didit-signature');
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

  return { db };
}

function normalizeStatus(value) {
  const s = String(value || '').toLowerCase();
  if (['approved', 'success', 'completed', 'verified'].includes(s)) return 'approved';
  if (['declined', 'rejected', 'failed', 'denied'].includes(s)) return 'rejected';
  if (['in_review', 'review', 'manual_review', 'pending_review'].includes(s)) return 'review';
  return 'pending';
}

function extractVendorData(payload) {
  const raw = payload?.vendor_data || payload?.vendorData || payload?.data?.vendor_data || payload?.data?.vendorData;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function extractProviderSessionId(payload) {
  return (
    payload?.session_id ||
    payload?.id ||
    payload?.data?.session_id ||
    payload?.data?.id ||
    payload?.session?.id ||
    null
  );
}

function extractStatus(payload) {
  return (
    payload?.status ||
    payload?.data?.status ||
    payload?.session?.status ||
    payload?.verification?.status ||
    null
  );
}

function extractTrustScore(payload) {
  const v = payload?.trust_score ?? payload?.data?.trust_score ?? payload?.session?.trust_score ?? payload?.score ?? null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function riskFromStatusAndScore(status, trustScore) {
  if (status === 'approved') {
    if (trustScore === null) return 'low';
    if (trustScore >= 80) return 'low';
    if (trustScore >= 60) return 'medium';
    return 'high';
  }
  if (status === 'review') return 'medium';
  if (status === 'rejected') return 'high';
  return 'unknown';
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método não permitido. Use POST.' });
  }

  try {
    const { db } = getFirebase();
    const payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const vendor = extractVendorData(payload);

    const userId = vendor.userId || payload?.user_id || payload?.data?.user_id || null;
    const localDocId = vendor.kycSessionDocId || null;
    const providerSessionId = extractProviderSessionId(payload);
    const status = normalizeStatus(extractStatus(payload));
    const trustScore = extractTrustScore(payload);
    const riskLevel = riskFromStatusAndScore(status, trustScore);
    const now = new Date().toISOString();

    let sessionRef = null;

    if (localDocId) {
      sessionRef = db.collection('kyc_sessions').doc(localDocId);
    } else if (providerSessionId) {
      const snap = await db.collection('kyc_sessions')
        .where('providerSessionId', '==', providerSessionId)
        .limit(1)
        .get();
      if (!snap.empty) sessionRef = snap.docs[0].ref;
    }

    if (!sessionRef) {
      await db.collection('kyc_audit_logs').add({
        userId: userId || 'unknown',
        provider: 'didit',
        action: 'DIDIT_WEBHOOK_UNMATCHED',
        details: { providerSessionId, payload },
        createdAt: now,
      });
      return res.status(200).json({ success: true, warning: 'Sessão local não encontrada.' });
    }

    const update = {
      status,
      riskLevel,
      trustScore,
      providerSessionId,
      webhookRaw: payload,
      updatedAt: now,
    };

    await sessionRef.set(update, { merge: true });

    const sessionSnap = await sessionRef.get();
    const sessionData = sessionSnap.exists ? sessionSnap.data() || {} : {};
    const finalUserId = userId || sessionData.userId;

    if (finalUserId) {
      await db.collection('users').doc(finalUserId).set({
        kycStatus: status,
        kycProvider: 'didit',
        kycRiskLevel: riskLevel,
        kycTrustScore: trustScore,
        kycUpdatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      await db.collection('kyc_audit_logs').add({
        userId: finalUserId,
        kycSessionId: sessionRef.id,
        provider: 'didit',
        action: 'DIDIT_WEBHOOK_STATUS_UPDATED',
        details: { status, riskLevel, trustScore, providerSessionId },
        createdAt: now,
      });
    }

    return res.status(200).json({ success: true, status, riskLevel, trustScore });
  } catch (error) {
    console.error('didit-webhook error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Erro interno no webhook Didit.' });
  }
}
