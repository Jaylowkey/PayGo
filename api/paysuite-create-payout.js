import { getFirestore } from 'firebase-admin/firestore';
import { initializeApp, cert, getApps } from 'firebase-admin/app';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
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

function cleanPhone(value = '') {
  let phone = String(value).replace(/\D/g, '');
  if (phone.length === 9) phone = `258${phone}`;
  return phone;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Método não permitido.' });

  try {
    const token = process.env.PAYSUITE_API_KEY || process.env.PAYSUITE_API_TOKEN;
    if (!token) return res.status(500).json({ success: false, error: 'PAYSUITE_API_KEY em falta.' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const amount = Number(body.amount || 0);
    const method = String(body.method || '').toLowerCase();
    const phone = cleanPhone(body.beneficiary?.phone);
    const holder = String(body.beneficiary?.holder || '').trim();
    const reference = String(body.reference || `PO-${Date.now()}`).replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 50);
    const description = String(body.description || 'Payout PayGo').slice(0, 125);

    if (!amount || amount <= 0) return res.status(400).json({ success: false, error: 'Valor inválido.' });
    if (!['mpesa', 'emola'].includes(method)) return res.status(400).json({ success: false, error: 'Método inválido.' });
    if (!phone || phone.length < 12) return res.status(400).json({ success: false, error: 'Telefone inválido.' });
    if (!holder || holder.length < 3) return res.status(400).json({ success: false, error: 'Titular inválido.' });

    const payload = {
      amount,
      reference,
      description,
      method,
      beneficiary: { phone, holder }
    };

    const url = `${(process.env.PAYSUITE_API_URL || 'https://paysuite.tech/api/v1').replace(/\/+$/, '')}/payouts`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { result = { raw: text }; }

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: result.message || 'Erro ao criar payout na PaySuite.',
        data: result
      });
    }

    const payout = result.data || result;

    try {
      const db = getFirebase();
      const ledgerId = `payout_${payout.id || reference}`;
      await db.collection('paysuite_ledger').doc(ledgerId).set({
        type: 'payout',
        provider: 'paysuite',
        externalId: payout.id || null,
        reference: payout.reference || reference,
        amount: Number(payout.amount || amount),
        status: payout.status || 'pending',
        method: payout.method || method,
        beneficiary: payout.beneficiary || { phone, holder },
        description: payout.description || description,
        createdAt: payout.created_at || new Date().toISOString(),
        syncedAt: new Date().toISOString(),
        raw: payout
      }, { merge: true });
    } catch (e) {
      console.warn('Falha ao gravar ledger:', e.message);
    }

    return res.status(201).json({ success: true, data: payout });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Erro interno.' });
  }
}
