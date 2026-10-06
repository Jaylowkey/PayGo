import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, FieldValue as AdminFieldValue } from 'firebase-admin/firestore';

function getFirebase() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT em falta.');
    const serviceAccount = JSON.parse(raw);
    if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    initializeApp({ credential: cert(serviceAccount) });
  }
  let db;
  try { db = getAdminFirestore('paygodb'); } catch { db = getAdminFirestore(); }
  return { db, auth: getAuth() };
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase().slice(0, 100);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Método não permitido.' });

  try {
    const { db, auth } = getFirebase();
    const action = String(req.body?.action || '').trim();

    if (action === 'click') {
      const affiliateCode = normalizeCode(req.body?.affiliateCode);
      if (!affiliateCode) return res.status(400).json({ success: false, error: 'Código de afiliado em falta.' });

      const snap = await db.collection('users').where('affiliateCode', '==', affiliateCode).limit(1).get();
      if (snap.empty) return res.status(404).json({ success: false, error: 'Código de afiliado não encontrado.' });

      await snap.docs[0].ref.update({
        affiliateClicks: AdminFieldValue.increment(1),
        lastAffiliateClickAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      return res.status(200).json({ success: true, tracked: true });
    }

    if (action === 'register') {
      const header = String(req.headers.authorization || '');
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!token) return res.status(401).json({ success: false, error: 'Sessão não autenticada.' });

      const decoded = await auth.verifyIdToken(token);
      const uid = decoded.uid;
      const userRef = db.collection('users').doc(uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) return res.status(404).json({ success: false, error: 'Perfil do utilizador não encontrado.' });

      const userData = userSnap.data() || {};
      const affiliateCode = normalizeCode(userData.referredBy);
      if (!affiliateCode) return res.status(200).json({ success: true, tracked: false, reason: 'Sem convite.' });
      if (userData.affiliateAttributionProcessed === true) {
        return res.status(200).json({ success: true, tracked: false, reason: 'Já contabilizado.' });
      }

      const affiliateSnap = await db.collection('users')
        .where('affiliateCode', '==', affiliateCode)
        .where('role', '==', 'affiliate')
        .limit(1)
        .get();

      if (affiliateSnap.empty) {
        return res.status(200).json({ success: true, tracked: false, reason: 'Afiliado não ativo.' });
      }

      const affiliateRef = affiliateSnap.docs[0].ref;
      await db.runTransaction(async transaction => {
        const freshUser = await transaction.get(userRef);
        const freshAffiliate = await transaction.get(affiliateRef);
        if (!freshUser.exists || !freshAffiliate.exists) throw new Error('Dados de atribuição indisponíveis.');

        const currentUser = freshUser.data() || {};
        if (currentUser.affiliateAttributionProcessed === true) return;

        transaction.update(affiliateRef, {
          totalReferrals: AdminFieldValue.increment(1),
          updatedAt: new Date().toISOString()
        });
        transaction.update(userRef, {
          affiliateAttributionProcessed: true,
          affiliateAttributedAt: new Date().toISOString(),
          affiliateReferrerId: affiliateRef.id
        });
      });

      return res.status(200).json({ success: true, tracked: true, affiliateCode });
    }

    return res.status(400).json({ success: false, error: 'Ação inválida.' });
  } catch (error) {
    console.error('[affiliate-tracking]', error);
    const unauthorized = String(error?.code || '').startsWith('auth/');
    return res.status(unauthorized ? 401 : 500).json({ success: false, error: error.message || 'Erro interno.' });
  }
}
