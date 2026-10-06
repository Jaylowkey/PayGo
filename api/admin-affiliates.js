import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

function getFirebase() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT em falta.');
    const serviceAccount = JSON.parse(raw);
    if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\\n');
    initializeApp({ credential: cert(serviceAccount) });
  }
  const app = getApps()[0];
  return { auth: getAuth(app), db: getFirestore(app, 'paygodb') };
}

function dateText(value) {
  if (!value) return '-';
  const d = typeof value.toDate === 'function' ? value.toDate() : new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('pt-MZ');
}

function cleanUser(id, data) {
  return {
    id,
    name: data.name || 'Desconhecido',
    email: data.email || '',
    phone: data.phone || '',
    role: data.role || 'user',
    status: data.status || 'active',
    affiliateStatus: data.affiliateStatus || null,
    affiliateCode: data.affiliateCode || '',
    affiliateCodeActive: data.affiliateCodeActive === true,
    affiliateEarnings: Number(data.affiliateEarnings || 0),
    approvedReferrals: Number(data.approvedReferrals || 0),
    createdAtText: dateText(data.createdAt),
    whyAffiliate: data.whyAffiliate || '',
    promoMethod: data.promoMethod || '',
    expectedReferrals: data.expectedReferrals || '',
    socialMediaLinks: data.socialMediaLinks || ''
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Método não permitido.' });

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.status(401).json({ success: false, error: 'Sessão administrativa em falta.' });

    const { auth, db } = getFirebase();
    const decoded = await auth.verifyIdToken(token);
    const adminSnap = await db.collection('users').doc(decoded.uid).get();
    if (!adminSnap.exists || !['admin', 'superadmin'].includes(adminSnap.data().role)) {
      return res.status(403).json({ success: false, error: 'Acesso administrativo negado.' });
    }

    const [pendingSnap, affiliateSnap, withdrawalSnap] = await Promise.all([
      db.collection('users').where('affiliateStatus', '==', 'pending').limit(100).get(),
      db.collection('users').where('role', '==', 'affiliate').limit(500).get(),
      db.collection('withdrawals').where('status', '==', 'pending').limit(100).get()
    ]);

    const pending = pendingSnap.docs.map(d => cleanUser(d.id, d.data()));
    const affiliates = affiliateSnap.docs.map(d => cleanUser(d.id, d.data())).filter(u => u.affiliateStatus !== 'pending');
    const withdrawals = withdrawalSnap.docs.map(d => {
      const w = d.data();
      return {
        id: d.id,
        userId: w.userId || '',
        affiliateCode: w.affiliateCode || '',
        amount: Number(w.amount || 0),
        method: w.method || '',
        phone: w.phone || '',
        status: w.status || 'pending',
        requestedAtText: dateText(w.requestedAt)
      };
    });

    return res.status(200).json({
      success: true,
      pending,
      affiliates,
      withdrawals,
      kpis: {
        activeAffiliates: affiliates.filter(u => u.status === 'active').length,
        earnings: affiliates.reduce((sum, u) => sum + Number(u.affiliateEarnings || 0), 0),
        pendingWithdrawals: withdrawals.length
      }
    });
  } catch (error) {
    console.error('[admin-affiliates]', error);
    return res.status(500).json({ success: false, error: error.message || 'Erro interno ao carregar afiliados.' });
  }
}
