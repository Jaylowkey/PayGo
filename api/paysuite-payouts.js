import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { initializeApp, cert, getApps } from 'firebase-admin/app';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

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

  try {
    return getFirestore(getApps()[0], 'paygodb');
  } catch {
    return getFirestore(getApps()[0]);
  }
}

async function saveLedgerSnapshot(db, payouts) {
  const batch = db.batch();
  const now = new Date().toISOString();

  for (const item of payouts) {
    const id = item.id || item.reference;
    if (!id) continue;

    const ref = db.collection('paysuite_ledger').doc(`payout_${id}`);
    batch.set(ref, {
      type: 'payout',
      provider: 'paysuite',
      externalId: item.id || null,
      reference: item.reference || null,
      amount: Number(item.amount || 0),
      status: item.status || 'pending',
      method: item.method || null,
      beneficiary: item.beneficiary || null,
      description: item.description || null,
      createdAt: item.created_at || now,
      syncedAt: now,
      raw: item
    }, { merge: true });
  }

  if (payouts.length) await batch.commit();
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Método não permitido.' });

  try {
    const token = process.env.PAYSUITE_API_KEY || process.env.PAYSUITE_API_TOKEN;
    if (!token) return res.status(500).json({ success: false, error: 'PAYSUITE_API_KEY em falta.' });

    const page = Number(req.query.page || 1);
    const limit = Math.min(Number(req.query.limit || 15), 100);

    const url = `${(process.env.PAYSUITE_API_URL || 'https://paysuite.tech/api/v1').replace(/\/+$/, '')}/payouts?page=${page}&limit=${limit}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    });

    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { result = { raw: text }; }

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: result.message || 'Erro ao buscar payouts na PaySuite.',
        data: result
      });
    }

    const payouts = Array.isArray(result.data) ? result.data : [];

    try {
      const db = getFirebase();
      await saveLedgerSnapshot(db, payouts);
    } catch (e) {
      console.warn('Falha ao sincronizar ledger:', e.message);
    }

    return res.status(200).json({
      success: true,
      data: payouts,
      links: result.links || null,
      meta: {
        ...(result.meta || {}),
        hasNext: Boolean(result.links?.next)
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Erro interno.' });
  }
}
