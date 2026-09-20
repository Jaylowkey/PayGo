import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import { getFirestore } from 'firebase-admin/firestore';

function database() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT em falta.');
    const sa = JSON.parse(raw);
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    initializeApp({ credential: cert(sa) });
  }
  try { return getFirestore(getApps()[0], 'paygodb'); } catch { return getFirestore(); }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const db = database();
    const authHeader = String(req.headers.authorization || '');
    if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const decoded = await getAuth().verifyIdToken(authHeader.slice(7).trim());
    const caller = await db.collection('users').doc(decoded.uid).get();
    const role = String(caller.data()?.role || '').toLowerCase();
    if (!caller.exists || !['admin', 'superadmin'].includes(role)) {
      return res.status(403).json({ ok: false, error: 'Admin access required' });
    }

    const targetUserId = String(req.body?.targetUserId || decoded.uid);
    const userRef = db.collection('users').doc(targetUserId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ ok: false, error: 'Utilizador não encontrado', targetUserId });

    const tokenSnap = await userRef.collection('pushTokens').where('enabled', '==', true).limit(500).get();
    const tokenDocs = tokenSnap.docs.filter(d => d.data()?.token);
    const tokens = tokenDocs.map(d => String(d.data().token));

    if (!tokens.length) {
      return res.status(200).json({
        ok: false,
        sent: 0,
        failed: 0,
        tokenCount: 0,
        targetUserId,
        message: 'Nenhum token FCM ativo encontrado para este utilizador.'
      });
    }

    const response = await getMessaging().sendEachForMulticast({
      tokens,
      notification: {
        title: 'PayGo — teste de notificações',
        body: 'Se recebeu esta mensagem, o Push do PayGo está a funcionar.'
      },
      data: {
        title: 'PayGo — teste de notificações',
        body: 'Se recebeu esta mensagem, o Push do PayGo está a funcionar.',
        campaignId: 'push-self-test',
        link: 'https://www.paygo.co.mz/dashboard.html'
      },
      webpush: {
        fcmOptions: { link: 'https://www.paygo.co.mz/dashboard.html' }
      }
    });

    const failures = [];
    for (let i = 0; i < response.responses.length; i++) {
      const r = response.responses[i];
      if (r.success) continue;
      const code = String(r.error?.code || 'unknown');
      const message = String(r.error?.message || 'Erro desconhecido');
      failures.push({ code, message });
      if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(code)) {
        await tokenDocs[i]?.ref.delete().catch(() => {});
      }
    }

    return res.status(200).json({
      ok: response.successCount > 0 && response.failureCount === 0,
      sent: response.successCount,
      failed: response.failureCount,
      tokenCount: tokens.length,
      targetUserId,
      failures
    });
  } catch (e) {
    console.error('[test-push]', e);
    return res.status(500).json({
      ok: false,
      error: 'Push test failed',
      code: e?.code || null,
      message: e?.message || String(e)
    });
  }
}
