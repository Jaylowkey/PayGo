import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const SECRET = 'PayGo-Grant-SA-2026-09-20-7f3c9b2e8d41a6';
const EMAIL = 'jrsamadh@gmail.com';

function firebase() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT em falta.');
    const serviceAccount = JSON.parse(raw);
    if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    initializeApp({ credential: cert(serviceAccount) });
  }
  const app = getApps()[0];
  let db;
  try { db = getFirestore(app, 'paygodb'); } catch { db = getFirestore(app); }
  return { auth: getAuth(app), db };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' || req.query?.key !== SECRET) {
    return res.status(404).json({ ok: false });
  }
  try {
    const { auth, db } = firebase();
    const user = await auth.getUserByEmail(EMAIL);
    const current = user.customClaims || {};
    await auth.setCustomUserClaims(user.uid, { ...current, admin: true, role: 'superadmin' });
    await db.collection('users').doc(user.uid).set({
      role: 'superadmin',
      admin: true,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    return res.status(200).json({ ok: true, email: EMAIL, uid: user.uid, role: 'superadmin' });
  } catch (error) {
    console.error('grant-superadmin failed', error);
    return res.status(500).json({ ok: false, error: error?.message || 'failed' });
  }
}
