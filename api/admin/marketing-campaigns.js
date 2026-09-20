import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

function db() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT em falta.');
    const sa = JSON.parse(raw);
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore(getApps()[0], 'paygodb');
}

async function authorized(req, database) {
  const header = String(req.headers.authorization || '');
  const secret = process.env.CRON_SECRET;
  if (secret && header === `Bearer ${secret}`) return true;
  if (!header.startsWith('Bearer ')) return false;
  try {
    const decoded = await getAuth().verifyIdToken(header.slice(7).trim());
    const user = await database.collection('users').doc(decoded.uid).get();
    const role = String(user.data()?.role || '').toLowerCase();
    return user.exists && ['admin', 'superadmin'].includes(role);
  } catch (e) {
    console.error('[marketing-campaigns-auth]', e);
    return false;
  }
}

function serializeTimestamp(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value._seconds != null) return new Date(value._seconds * 1000).toISOString();
  return value;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const database = db();
    if (!await authorized(req, database)) return res.status(401).json({ error: 'Unauthorized' });

    const snap = await database.collection('marketingCampaigns').limit(500).get();
    const campaigns = snap.docs.map(d => {
      const data = d.data() || {};
      return {
        id: d.id,
        ...data,
        createdAt: serializeTimestamp(data.createdAt),
        scheduleAt: serializeTimestamp(data.scheduleAt),
        queuedAt: serializeTimestamp(data.queuedAt),
        completedAt: serializeTimestamp(data.completedAt),
        lastProcessedAt: serializeTimestamp(data.lastProcessedAt),
        cancelledAt: serializeTimestamp(data.cancelledAt)
      };
    });

    campaigns.sort((a, b) => {
      const av = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bv = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bv - av;
    });

    return res.status(200).json({ ok: true, campaigns });
  } catch (e) {
    console.error('[marketing-campaigns]', e);
    return res.status(500).json({ error: 'Não foi possível carregar as campanhas.', message: e.message });
  }
}