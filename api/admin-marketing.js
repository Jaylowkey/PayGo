import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

function getDb() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT em falta.');
    const serviceAccount = JSON.parse(raw);
    if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    initializeApp({ credential: cert(serviceAccount) });
  }
  try { return getFirestore(getApps()[0], 'paygodb'); } catch { return getFirestore(); }
}

async function requireAdmin(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) throw Object.assign(new Error('Token de autenticação ausente.'), { status: 401 });
  const db = getDb();
  const decoded = await getAuth().verifyIdToken(header.slice(7).trim());
  const snap = await db.collection('users').doc(decoded.uid).get();
  if (!snap.exists) throw Object.assign(new Error('Perfil administrativo não encontrado.'), { status: 403 });
  const role = String(snap.data()?.role || '').toLowerCase();
  if (!['admin', 'superadmin'].includes(role)) throw Object.assign(new Error('Acesso administrativo necessário.'), { status: 403 });
  return { db, uid: decoded.uid };
}

function serialize(value) {
  if (value?.toDate) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serialize(v);
    return out;
  }
  return value;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const { db } = await requireAdmin(req);
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const snap = await db.collection('marketingCampaigns').limit(500).get();
    const campaigns = snap.docs.map(d => serialize({ id: d.id, ...d.data() }));
    campaigns.sort((a, b) => {
      const ta = new Date(a.createdAt || 0).getTime() || 0;
      const tb = new Date(b.createdAt || 0).getTime() || 0;
      return tb - ta;
    });

    let sent = 0, scheduled = 0, delivered = 0, totalSent = 0;
    for (const d of campaigns) {
      const status = d.status || 'draft';
      const stats = d.stats || {};
      if (status === 'processed') sent++;
      if (status === 'scheduled') scheduled++;
      delivered += Number(stats.delivered || 0);
      totalSent += Number(stats.accepted ?? stats.sent ?? 0);
    }

    return res.status(200).json({
      ok: true,
      campaigns,
      stats: {
        campaigns: campaigns.length,
        scheduled,
        sent,
        delivered,
        totalSent,
        deliveryRate: totalSent ? Math.round(delivered / totalSent * 100) : null
      }
    });
  } catch (error) {
    console.error('[admin-marketing]', error);
    const status = Number(error?.status) || 500;
    return res.status(status).json({ ok: false, error: error?.message || 'Erro interno.' });
  }
}
