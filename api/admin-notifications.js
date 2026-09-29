import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const DEFAULTS = [
  ['payment_success', 'Pagamento concluído', 'email', 'push', 'in_app'],
  ['payment_failed', 'Falha de pagamento', 'email', 'push', 'in_app'],
  ['payout_success', 'Payout concluído', 'push', 'whatsapp', 'in_app'],
  ['payout_failed', 'Payout falhou', 'push', 'whatsapp', 'in_app'],
  ['kyc_update', 'Atualização KYC/KYB', 'email', 'in_app'],
  ['low_balance', 'Saldo baixo', 'push', 'whatsapp']
];

const CHANNELS = new Set(['email', 'whatsapp', 'push', 'in_app']);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function firebase() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT em falta.');
    let serviceAccount;
    try {
      serviceAccount = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT inválido: JSON não pode ser lido.');
    }
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    initializeApp({ credential: cert(serviceAccount) });
  }
  const app = getApps()[0];
  let db;
  try { db = getFirestore(app, 'paygodb'); } catch { db = getFirestore(app); }
  return { auth: getAuth(app), db };
}

async function requireAdmin(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  if (!header.startsWith('Bearer ')) {
    const e = new Error('Token de autenticação ausente.'); e.status = 401; throw e;
  }
  const token = header.slice(7).trim();
  if (!token) {
    const e = new Error('Token inválido.'); e.status = 401; throw e;
  }

  const { auth, db } = firebase();
  let decoded;
  try {
    decoded = await auth.verifyIdToken(token);
  } catch {
    const e = new Error('Sessão inválida ou expirada.'); e.status = 401; throw e;
  }

  const userSnap = await db.collection('users').doc(decoded.uid).get();
  if (!userSnap.exists) {
    const e = new Error('Perfil do utilizador não encontrado.'); e.status = 403; throw e;
  }

  const user = userSnap.data() || {};
  const role = String(user.role || '').toLowerCase();
  if (!['admin', 'superadmin'].includes(role)) {
    const e = new Error('Acesso negado. Utilizador não é admin.'); e.status = 403; throw e;
  }

  return { uid: decoded.uid, role, email: decoded.email || user.email || '' };
}

function dateValue(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function serialize(doc) {
  const d = doc.data() || {};
  return {
    id: doc.id,
    event: d.event || '',
    channel: d.channel || 'in_app',
    title: d.title || '',
    body: d.body || '',
    active: d.active !== false,
    systemDefault: Boolean(d.systemDefault),
    createdAt: dateValue(d.createdAt),
    updatedAt: dateValue(d.updatedAt)
  };
}

async function seed(db, uid) {
  const existing = await db.collection('notificationTemplates').limit(1).get();
  if (!existing.empty) return;

  const seeds = [
    ['payment_success','email','Pagamento concluído','Olá {{firstName}}, o seu pagamento foi concluído com sucesso.'],
    ['payment_success','push','Pagamento concluído','O seu pagamento foi concluído com sucesso.'],
    ['payment_failed','email','Pagamento falhou','Não foi possível concluir o seu pagamento.'],
    ['payment_failed','push','Pagamento falhou','O seu pagamento não foi concluído.'],
    ['payout_success','in_app','Payout concluído','O seu payout foi concluído com sucesso.'],
    ['payout_failed','in_app','Payout falhou','O seu payout não foi concluído.'],
    ['kyc_update','email','Atualização KYC/KYB','O estado da sua verificação foi atualizado.'],
    ['kyc_update','in_app','Atualização KYC/KYB','O estado da sua verificação foi atualizado.'],
    ['low_balance','push','Saldo baixo','O seu saldo PayGo está baixo.']
  ];

  const batch = db.batch();
  const now = new Date();
  for (const [event, channel, title, body] of seeds) {
    const ref = db.collection('notificationTemplates').doc();
    batch.set(ref, {
      event, channel, title, body, active: true, systemDefault: true,
      createdBy: uid, createdAt: now, updatedAt: now
    });
  }
  await batch.commit();
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const admin = await requireAdmin(req);
    const { db } = firebase();

    if (req.method === 'GET') {
      await seed(db, admin.uid);
      const settingsSnap = await db.collection('settings').doc('notifications').get();
      const settings = settingsSnap.exists ? (settingsSnap.data() || {}) : {};
      const templatesSnap = await db.collection('notificationTemplates').get();
      const templates = templatesSnap.docs
        .map(serialize)
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

      return res.status(200).json({
        success: true,
        settings: {
          routing: settings.routing || {},
          prefemail: settings.prefemail !== false,
          prefwhatsapp: settings.prefwhatsapp !== false,
          prefpush: settings.prefpush !== false,
          prefinapp: settings.prefinapp !== false
        },
        templates,
        stats: {
          templates: templates.length,
          events: new Set(templates.map(t => t.event)).size,
          unread: 0,
          failures: 0
        },
        defaults: DEFAULTS
      });
    }

    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    if (req.method === 'PUT') {
      const action = String(body.action || 'settings');

      if (action === 'settings') {
        const routing = {};
        for (const entry of DEFAULTS) {
          const event = entry[0];
          const values = body.routing?.[event];
          routing[event] = Array.isArray(values)
            ? values.filter(v => CHANNELS.has(v))
            : entry.slice(2);
        }

        await db.collection('settings').doc('notifications').set({
          routing,
          prefemail: body.prefemail !== false,
          prefwhatsapp: body.prefwhatsapp !== false,
          prefpush: body.prefpush !== false,
          prefinapp: body.prefinapp !== false,
          updatedAt: new Date(),
          updatedBy: admin.uid
        }, { merge: true });

        return res.status(200).json({ success: true, message: 'Configuração guardada.' });
      }

      if (action === 'template') {
        const event = String(body.event || '').trim();
        const channel = String(body.channel || '').trim();
        const title = String(body.title || '').trim();
        const templateBody = String(body.templateBody || body.body || '').trim();

        if (!event || !channel || !title || !templateBody) {
          return res.status(400).json({ success: false, error: 'Evento, canal, título e mensagem são obrigatórios.' });
        }
        if (!CHANNELS.has(channel)) {
          return res.status(400).json({ success: false, error: 'Canal inválido.' });
        }

        const data = {
          event, channel, title, body: templateBody,
          active: body.active !== false,
          updatedAt: new Date(),
          updatedBy: admin.uid
        };

        if (body.id) {
          const ref = db.collection('notificationTemplates').doc(String(body.id));
          await ref.set(data, { merge: true });
          return res.status(200).json({ success: true, template: serialize(await ref.get()) });
        }

        data.createdBy = admin.uid;
        data.createdAt = new Date();
        const ref = await db.collection('notificationTemplates').add(data);
        return res.status(201).json({ success: true, template: serialize(await ref.get()) });
      }

      return res.status(400).json({ success: false, error: 'Ação inválida.' });
    }

    if (req.method === 'DELETE') {
      const id = String(body.id || req.query?.id || '').trim();
      if (!id) return res.status(400).json({ success: false, error: 'ID do template em falta.' });
      await db.collection('notificationTemplates').doc(id).delete();
      return res.status(200).json({ success: true, message: 'Template apagado.' });
    }

    return res.status(405).json({ success: false, error: 'Método não permitido.' });
  } catch (error) {
    console.error('[admin-notifications]', error);
    const status = Number(error?.status) >= 400 && Number(error?.status) < 500 ? Number(error.status) : 500;
    return res.status(status).json({
      success: false,
      error: error?.message || 'Erro interno do servidor'
    });
  }
}
