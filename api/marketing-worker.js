import { Resend } from 'resend';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import { FieldPath, FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = process.env.FROM_EMAIL || 'PayGo Moçambique <noreply@paygo.co.mz>';
const EMAIL_PROVIDER = String(process.env.MARKETING_EMAIL_PROVIDER || 'resend').toLowerCase();
const BATCH = Math.max(1, Math.min(500, Number(process.env.MARKETING_BATCH_SIZE || 100)));

function db() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT em falta.');
    const sa = JSON.parse(raw);
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    initializeApp({ credential: cert(sa) });
  }
  try { return getFirestore(getApps()[0], 'paygodb'); } catch { return getFirestore(); }
}

async function authorized(req, database) {
  const secret = process.env.CRON_SECRET;
  const header = String(req.headers.authorization || '');
  if (secret && header === `Bearer ${secret}`) return true;
  if (!header.startsWith('Bearer ')) return false;
  try {
    const token = header.slice(7).trim();
    const decoded = await getAuth().verifyIdToken(token);
    const user = await database.collection('users').doc(decoded.uid).get();
    const role = String(user.data()?.role || '').toLowerCase();
    return user.exists && ['admin', 'superadmin'].includes(role);
  } catch (e) {
    console.error('[marketing-auth]', e);
    return false;
  }
}

function vars(s, u = {}) {
  const firstName = u.firstName || u.first_name || u.name?.split?.(' ')?.[0] || 'Cliente';
  const name = u.name || u.displayName || firstName;
  const balance = u.balance ?? u.walletBalance ?? u.wallet?.balance ?? 0;
  return String(s || '')
    .replace(/{{\s*firstName\s*}}/gi, String(firstName))
    .replace(/{{\s*name\s*}}/gi, String(name))
    .replace(/{{\s*balance\s*}}/gi, String(balance));
}

function audience(u, a) {
  if (a === 'all') return true;
  const status = String(u.status || '').toLowerCase();
  const balance = Number(u.balance ?? u.walletBalance ?? u.wallet?.balance ?? 0);
  if (a === 'active') return ['active', 'verified'].includes(status) || u.active === true || u.emailVerified === true;
  if (a === 'wallet') return balance > 0;
  if (a === 'affiliate') return Boolean(u.affiliateCode || u.affiliate_code || u.referralCode || u.isAffiliate);
  return true;
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

async function push(tokens, title, body, link, id) {
  if (!tokens.length) return { accepted: 0, failed: 0, invalid: [] };
  const messaging = getMessaging();
  const responses = [];
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    const response = await messaging.sendEachForMulticast({
      tokens: batch,
      notification: { title, body },
      data: {
        title: String(title || 'PayGo'),
        body: String(body || ''),
        campaignId: String(id || ''),
        link: String(link || 'https://www.paygo.co.mz/dashboard.html')
      },
      webpush: { fcmOptions: { link: String(link || 'https://www.paygo.co.mz/dashboard.html') } }
    });
    response.responses.forEach((result, index) => responses.push({ token: batch[index], success: result.success, error: result.error }));
  }
  return {
    accepted: responses.filter(x => x.success).length,
    failed: responses.filter(x => !x.success).length,
    invalid: responses.filter(x => !x.success && ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(x.error?.code)).map(x => x.token)
  };
}

async function email(to, subject, body, id) {
  if (EMAIL_PROVIDER !== 'resend' || !resend) return false;
  const r = await resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject,
    html: `<div style="max-width:620px;margin:auto;padding:32px;font-family:Arial;color:#0f172a"><b style="font-size:28px;color:#2563eb">PayGo</b><p style="white-space:pre-wrap;line-height:1.7">${esc(body)}</p><hr><small>PayGo Moçambique · contact@paygo.co.mz</small></div>`,
    text: body,
    headers: { 'X-PayGo-Campaign': id }
  });
  return !r.error;
}

function campaignStats(c, accepted, delivered, failed, processed, channelStats) {
  return {
    ...(c.stats || {}),
    accepted,
    sent: accepted,
    delivered,
    failed,
    processed,
    channelStats
  };
}

async function runCampaign(database, ref) {
  const c = ref.data() || {};
  const id = ref.id;
  const channels = Array.isArray(c.channels) && c.channels.length ? c.channels : ['in_app'];
  const aud = c.audience || 'all';
  let accepted = Number(c.stats?.accepted ?? c.stats?.sent ?? 0);
  let delivered = Number(c.stats?.delivered || 0);
  let failed = Number(c.stats?.failed || 0);
  const channelStats = {
    in_app: { ...(c.stats?.channelStats?.in_app || {}), attempted: Number(c.stats?.channelStats?.in_app?.attempted || 0), accepted: Number(c.stats?.channelStats?.in_app?.accepted || 0), delivered: Number(c.stats?.channelStats?.in_app?.delivered || 0), failed: Number(c.stats?.channelStats?.in_app?.failed || 0) },
    email: { ...(c.stats?.channelStats?.email || {}), attempted: Number(c.stats?.channelStats?.email?.attempted || 0), accepted: Number(c.stats?.channelStats?.email?.accepted || 0), delivered: Number(c.stats?.channelStats?.email?.delivered || 0), failed: Number(c.stats?.channelStats?.email?.failed || 0) },
    push: { ...(c.stats?.channelStats?.push || {}), attempted: Number(c.stats?.channelStats?.push?.attempted || 0), accepted: Number(c.stats?.channelStats?.push?.accepted || 0), delivered: Number(c.stats?.channelStats?.push?.delivered || 0), failed: Number(c.stats?.channelStats?.push?.failed || 0) },
    whatsapp: { ...(c.stats?.channelStats?.whatsapp || {}), attempted: Number(c.stats?.channelStats?.whatsapp?.attempted || 0), accepted: Number(c.stats?.channelStats?.whatsapp?.accepted || 0), delivered: Number(c.stats?.channelStats?.whatsapp?.delivered || 0), failed: Number(c.stats?.channelStats?.whatsapp?.failed || 0) }
  };

  let snap;
  if (aud === 'specific' && c.targetUserId) {
    const target = await database.collection('users').doc(String(c.targetUserId)).get();
    snap = { empty: !target.exists, size: target.exists ? 1 : 0, docs: target.exists ? [target] : [] };
  } else {
    let q = database.collection('users').orderBy(FieldPath.documentId()).limit(BATCH);
    if (c.workerCursor) q = q.startAfter(c.workerCursor);
    snap = await q.get();
  }

  if (snap.empty) {
    await ref.ref.update({
      status: 'processed',
      workerCursor: FieldValue.delete(),
      completedAt: FieldValue.serverTimestamp(),
      stats: campaignStats(c, accepted, delivered, failed, Number(c.stats?.processed || 0), channelStats)
    });
    return { id, status: 'sent', processed: 0 };
  }

  let cursor = snap.docs[snap.docs.length - 1].id;
  let processed = Number(c.stats?.processed || 0);

  for (const d of snap.docs) {
    const u = d.data() || {};
    cursor = d.id;
    processed++;
    if (!audience(u, aud)) continue;

    const title = vars(c.title || c.subject || 'PayGo', u);
    const body = vars(c.message || c.body || '', u);
    let successfulChannels = 0;
    let failedChannels = 0;

    if (channels.includes('in_app')) {
      channelStats.in_app.attempted++;
      try {
        await database.collection('notifications').add({
          userId: d.id, uid: d.id, type: 'marketing', campaignId: id,
          title, body, message: body, read: false,
          createdAt: FieldValue.serverTimestamp(),
          metadata: { audience: aud, channels }
        });
        successfulChannels++;
        accepted++;
        delivered++;
        channelStats.in_app.accepted++;
        channelStats.in_app.delivered++;
      } catch { failedChannels++; channelStats.in_app.failed++; }
    }

    if (channels.includes('push')) {
      channelStats.push.attempted++;
      try {
        const tokenSnap = await database.collection('users').doc(d.id).collection('pushTokens').where('enabled', '==', true).limit(500).get();
        const tokens = tokenSnap.docs.map(x => String(x.data()?.token || '')).filter(Boolean);
        const result = await push(tokens, title, body, 'https://www.paygo.co.mz/dashboard.html', id);
        accepted += result.accepted;
        failedChannels += result.failed;
        channelStats.push.accepted += result.accepted;
        channelStats.push.failed += result.failed;
        for (const invalidToken of result.invalid) {
          const tokenDoc = tokenSnap.docs.find(x => x.data()?.token === invalidToken);
          if (tokenDoc) await tokenDoc.ref.delete().catch(() => {});
        }
      } catch (error) {
        console.error('[marketing-push]', d.id, error);
        failedChannels++;
        channelStats.push.failed++;
      }
    }

    if (channels.includes('email')) {
      channelStats.email.attempted++;
      const to = u.email || u.emailAddress;
      if (to && await email(to, vars(c.subject || c.title || 'Notificação PayGo', u), body, id)) {
        successfulChannels++;
        accepted++;
        channelStats.email.accepted++;
      } else {
        failedChannels++;
        channelStats.email.failed++;
      }
    }

    for (const unsupported of ['whatsapp']) {
      if (!channels.includes(unsupported)) continue;
      channelStats[unsupported].attempted++;
      channelStats[unsupported].failed++;
      failedChannels++;
    }

    failed += failedChannels;
  }

  const more = snap.size === BATCH;
  await ref.ref.update({
    status: more ? 'queued' : 'processed',
    workerCursor: more ? cursor : FieldValue.delete(),
    completedAt: more ? FieldValue.delete() : FieldValue.serverTimestamp(),
    stats: campaignStats(c, accepted, delivered, failed, processed, channelStats),
    lastProcessedAt: FieldValue.serverTimestamp()
  });

  return { id, status: more ? 'queued' : 'processed', processed: snap.size, accepted, delivered, failed };
}

function isDue(value, now) {
  if (!value) return false;
  if (typeof value.toDate === 'function') return value.toDate().getTime() <= now.toDate().getTime();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() <= now.toDate().getTime();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const database = db();
    if (!await authorized(req, database)) return res.status(401).json({ error: 'Unauthorized' });
    const campaignId = String(req.body?.campaignId || '');
    const now = Timestamp.now();
    const results = [];

    const queued = campaignId
      ? await database.collection('marketingCampaigns').doc(campaignId).get().then(d => ({ docs: d.exists && d.data()?.status === 'queued' ? [d] : [] }))
      : await database.collection('marketingCampaigns').where('status', '==', 'queued').limit(10).get();
    for (const d of queued.docs) results.push(await runCampaign(database, d));

    // Avoid a Firestore composite index for status + scheduleAt.
    const scheduled = await database.collection('marketingCampaigns').where('status', '==', 'scheduled').limit(100).get();
    for (const d of scheduled.docs) {
      const data = d.data() || {};
      if (!isDue(data.scheduleAt, now)) continue;
      await d.ref.update({ status: 'queued', queuedAt: FieldValue.serverTimestamp() });
      results.push(await runCampaign(database, d));
    }

    return res.status(200).json({ ok: true, worker: 'marketing', providers: { in_app: true, email: EMAIL_PROVIDER === 'resend' && Boolean(resend), push: true, whatsapp: false }, processed: results.length, results, at: new Date().toISOString() });
  } catch (e) {
    console.error('[marketing-worker]', e);
    return res.status(500).json({ error: 'Marketing worker failed', message: e.message });
  }
}
