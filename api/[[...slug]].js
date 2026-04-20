import crypto from 'crypto';
import axios from 'axios';
import { Resend } from 'resend';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// =========================================================
// 📦 CONFIGURAÇÕES GLOBAIS & INICIALIZAÇÃO
// =========================================================
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const WHATSAPP_NUMBER = process.env.WHATSAPP_SUPPORT_NUMBER || '258871002255';
const SITE_URL = process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://paygo.co.mz';
const FROM_EMAIL = process.env.FROM_EMAIL || 'PayGo Moçambique <noreply@paygo.co.mz>';
const BRAND_COLORS = {
  primary: '#2563eb',
  primaryDark: '#1d4ed8',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  purple: '#8b5cf6',
  dark: '#0f172a',
  light: '#f8fafc',
  border: '#e2e8f0'
};

// =========================================================
// 🌐 CORE ROUTER & FIREBASE
// =========================================================
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-paysuite-signature, x-webhook-signature');
}

function normalizeBody(req) {
  let body = req.body;
  if (!body || (typeof body === 'object' && Object.keys(body).length === 0)) {
    body = req.query || {};
  }
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = { raw: body }; }
  }
  return body || {};
}

function getRoute(req) {
  const slug = req.query?.slug;
  if (Array.isArray(slug) && slug.length) return slug.join('/');
  if (typeof slug === 'string' && slug.trim()) return slug.trim();
  const path = (req.url || '').split('?')[0];
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'api' && parts.length > 1) return parts.slice(1).join('/');
  return '';
}

function getFirebase() {
  if (!getApps().length) {
    const envVar = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!envVar) throw new Error('FIREBASE_SERVICE_ACCOUNT em falta.');
    const serviceAccount = JSON.parse(envVar);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    initializeApp({ credential: cert(serviceAccount) });
  }

  const app = getApps()[0];
  let db;
  try {
    db = getFirestore(app, 'paygodb');
  } catch (e) {
    db = getFirestore(app);
  }

  return { db, auth: getAuth(app) };
}

function purificarDados(obj) {
  if (obj === undefined) return null;
  if (typeof obj !== 'object' || obj === null) return obj;
  return JSON.parse(JSON.stringify(obj));
}

function verifyPaySuiteSignature(rawBody, signatureHeader) {
  const secret = process.env.PAYSUITE_WEBHOOK_SECRET;
  if (!secret) return true;
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
}

function buildBaseUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  const host = req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

async function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    throw new Error('Token de autenticação ausente.');
  }

  const idToken = authHeader.slice(7).trim();
  if (!idToken) {
    throw new Error('Token inválido.');
  }

  const { auth, db } = getFirebase();
  const decoded = await auth.verifyIdToken(idToken);

  const userDoc = await db.collection('users').doc(decoded.uid).get();
  const userData = userDoc.exists ? (userDoc.data() || {}) : {};

  return {
    uid: decoded.uid,
    email: decoded.email || userData.email || '',
    name: userData.name || decoded.name || ''
  };
}

async function getAuthenticatedAdmin(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    throw new Error('Token de autenticação ausente.');
  }

  const idToken = authHeader.slice(7).trim();
  if (!idToken) {
    throw new Error('Token inválido.');
  }

  const { auth, db } = getFirebase();
  const decoded = await auth.verifyIdToken(idToken);

  const userDoc = await db.collection('users').doc(decoded.uid).get();
  if (!userDoc.exists) {
    throw new Error('Perfil do utilizador não encontrado.');
  }

  const userData = userDoc.data() || {};
  const role = String(userData.role || '').toLowerCase();

  if (!['admin', 'superadmin'].includes(role)) {
    throw new Error('Acesso negado. Utilizador não é admin.');
  }

  return {
    uid: decoded.uid,
    email: decoded.email || '',
    name: userData.name || decoded.name || decoded.email || 'Admin PayGo',
    role
  };
}

// =========================================================
// ✨ EMAIL TEMPLATES - HYPER ULTRA PROFESSIONAL
// =========================================================

function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getWhatsAppLink(order) {
  const id = order.orderId || order.topupId || order.order_id || 'N/A';
  const name = order.name || order.customer_name || 'Cliente';
  const total = order.total || order.amount || order.total_amount || '0';
  const method = order.paymentMethod || order.payment_method || '';
  const isTransfer = String(method).includes('transferencia') || method === 'bank';
  const actionText = isTransfer ? 'enviar o comprovativo do meu pagamento' : 'finalizar o meu pedido';
  const msg = `*OLÁ PAYGO!* 👋\n\nGostaria de ${actionText}.\n\n*DADOS DO PEDIDO:*\n🆔 ID: #${id}\n👤 Cliente: ${name}\n💰 Valor: ${total} MT\n💳 Método: ${String(method || 'N/A').toUpperCase()}\n\n_Aguardo instruções._`;
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;
}

async function sendLarkNotification(title, templateColor = 'blue', fields = [], actions = []) {
  if (!process.env.LARK_WEBHOOK_URL) return { success: false, error: 'Lark não configurado' };
  const payload = {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { template: templateColor, title: { content: title, tag: 'plain_text' } },
      elements: [
        { tag: 'div', fields },
        ...(actions.length ? [{ tag: 'action', actions }] : []),
        { tag: 'note', elements: [{ tag: 'plain_text', content: `🕐 ${new Date().toLocaleString('pt-MZ')}` }] }
      ]
    }
  };
  try {
    const res = await fetch(process.env.LARK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    let result;
    try { result = JSON.parse(text); } catch { result = { raw: text }; }
    if (result.code === 0 || result.StatusCode === 0 || (!result.code && res.ok)) return { success: true };
    return { success: false, error: 'Lark API error', data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

const getBaseStyles = () => `
  @media screen {
    @font-face { font-family: 'Inter'; font-style: normal; font-weight: 400; src: url(https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap) format('woff2'); }
  }
  body { margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #f0f9ff 0%, #f8fafc 50%, #fefefe 100%); }
  .wrapper { width: 100%; table-layout: fixed; background: linear-gradient(135deg, #f0f9ff 0%, #f8fafc 100%); padding: 24px 16px; }
  .container { max-width: 640px; margin: 0 auto; background: #ffffff; border-radius: 24px; overflow: hidden; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(255,255,255,0.1) inset; border: 1px solid ${BRAND_COLORS.border}; }
  .header { background: linear-gradient(135deg, ${BRAND_COLORS.primary} 0%, ${BRAND_COLORS.primaryDark} 50%, #1e40af 100%); padding: 32px 24px; text-align: center; position: relative; overflow: hidden; }
  .header::before { content: ''; position: absolute; inset: 0; background: radial-gradient(circle at 30% 20%, rgba(255,255,255,0.15) 0%, transparent 50%), radial-gradient(circle at 80% 80%, rgba(255,255,255,0.1) 0%, transparent 40%); }
  .header-content { position: relative; z-index: 1; }
  .logo { font-size: 24px; font-weight: 800; color: #fff; letter-spacing: -0.5px; display: flex; align-items: center; justify-content: center; gap: 8px; }
  .logo-badge { background: rgba(255,255,255,0.2); padding: 4px 12px; border-radius: 99px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .content { padding: 32px 28px; color: ${BRAND_COLORS.dark}; line-height: 1.7; }
  .greeting { font-size: 18px; font-weight: 600; margin-bottom: 16px; color: ${BRAND_COLORS.dark}; }
  .message { font-size: 16px; color: #475569; margin-bottom: 24px; }
  .card { background: linear-gradient(145deg, #ffffff 0%, #f8fafc 100%); border: 1px solid ${BRAND_COLORS.border}; border-radius: 16px; padding: 20px; margin: 20px 0; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
  .card-title { font-size: 14px; font-weight: 700; color: ${BRAND_COLORS.primary}; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }
  .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed ${BRAND_COLORS.border}; font-size: 15px; }
  .detail-row:last-child { border-bottom: none; }
  .detail-label { color: #64748b; font-weight: 500; }
  .detail-value { color: ${BRAND_COLORS.dark}; font-weight: 600; }
  .alert { background: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%); border: 1px solid #fde68a; border-left: 4px solid ${BRAND_COLORS.warning}; padding: 16px; border-radius: 12px; margin: 20px 0; }
  .alert.success { background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border-color: #bbf7d0; border-left-color: ${BRAND_COLORS.success}; }
  .alert.danger { background: linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%); border-color: #fecaca; border-left-color: ${BRAND_COLORS.danger}; }
  .alert-title { font-weight: 700; color: #92400e; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
  .alert.success .alert-title { color: #166534; }
  .alert.danger .alert-title { color: #b91c1c; }
  .btn { display: inline-block; background: linear-gradient(135deg, ${BRAND_COLORS.primary} 0%, ${BRAND_COLORS.primaryDark} 100%); color: #fff !important; padding: 14px 32px; border-radius: 14px; text-decoration: none; font-weight: 700; font-size: 15px; text-align: center; box-shadow: 0 10px 15px -3px rgba(37, 99, 235, 0.3), 0 4px 6px -2px rgba(37, 99, 235, 0.1); transition: all 0.2s; }
  .btn:hover { transform: translateY(-2px); box-shadow: 0 20px 25px -5px rgba(37, 99, 235, 0.4), 0 10px 10px -5px rgba(37, 99, 235, 0.2); }
  .btn-whatsapp { background: linear-gradient(135deg, #25D366 0%, #128C7E 100%); box-shadow: 0 10px 15px -3px rgba(37, 211, 102, 0.3); }
  .footer { background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); padding: 24px; text-align: center; color: #64748b; font-size: 13px; border-top: 1px solid ${BRAND_COLORS.border}; }
  .footer-brand { font-weight: 700; color: ${BRAND_COLORS.primary}; margin-bottom: 8px; }
  .footer-links { margin-top: 12px; }
  .footer-links a { color: ${BRAND_COLORS.primary}; text-decoration: none; margin: 0 8px; }
  .divider { height: 1px; background: linear-gradient(90deg, transparent, ${BRAND_COLORS.border}, transparent); margin: 24px 0; }
  .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 99px; font-size: 13px; font-weight: 600; }
  .status-badge.processing { background: #dbeafe; color: #1e40af; }
  .status-badge.completed { background: #dcfce7; color: #166534; }
  .status-badge.pending { background: #fef3c7; color: #92400e; }
  .hero-icon { font-size: 48px; margin-bottom: 16px; display: block; }
  .amount-highlight { font-size: 28px; font-weight: 800; color: ${BRAND_COLORS.primary}; text-align: center; margin: 16px 0; }
  .order-id { font-family: 'SF Mono', 'Fira Code', monospace; background: #f1f5f9; padding: 4px 12px; border-radius: 6px; font-weight: 600; color: ${BRAND_COLORS.dark}; }
`;

function generateEmailHTML(template, vars) {
  const baseUrl = SITE_URL;
  const waLink = getWhatsAppLink(vars);
  const totalFormatted = vars.total_amount ? Number(vars.total_amount).toLocaleString('pt-MZ', { minimumFractionDigits: 2 }) : '0.00';
  const isBank = String(vars.payment_method || '').includes('transferencia');

  switch (template) {
    case 'order-confirmation':
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PayGo - Pedido Registado</title><style>${getBaseStyles()}</style></head><body><div class="wrapper"><table class="container" cellpadding="0" cellspacing="0"><tr><td class="header"><div class="header-content"><div class="logo">🚀 PayGo <span class="logo-badge">Moçambique</span></div></div></td></tr><tr><td class="content"><span class="hero-icon">🛒</span><h1 style="font-size:24px;font-weight:800;color:${BRAND_COLORS.dark};margin:0 0 8px;">Pedido Registado!</h1><p class="greeting">Olá, ${escapeHTML(vars.customer_name || 'Cliente')}.</p><p class="message">O seu pedido <span class="order-id">#${escapeHTML(vars.order_id)}</span> foi recebido com sucesso e está na nossa fila de processamento.</p><div class="card"><div class="card-title">💰 Resumo da Operação</div><div class="detail-row"><span class="detail-label">Total a Pagar</span><span class="detail-value" style="color:${BRAND_COLORS.primary};font-size:18px;">${totalFormatted} MT</span></div><div class="detail-row"><span class="detail-label">Método</span><span class="detail-value">${escapeHTML(vars.payment_method || 'N/A').toUpperCase()}</span></div><div class="detail-row"><span class="detail-label">Categoria</span><span class="detail-value">${vars.type === 'compra' ? '🛍️ Compras' : '🎮 Serviços'}</span></div>${vars.usd_amount ? `<div class="detail-row"><span class="detail-label">Valor USD</span><span class="detail-value">$${escapeHTML(vars.usd_amount)}</span></div>` : ''}</div>${isBank ? `<div class="alert"><div class="alert-title">⚠️ Atenção</div><div style="color:#78350f;font-size:14px;">Como escolheu transferência bancária, envie o comprovativo via WhatsApp para validação imediata.</div></div>` : `<div class="alert success"><div class="alert-title">🔔 Próximo Passo</div><div style="color:#166534;font-size:14px;">Receberá em breve o pedido de PIN no seu telemóvel para autorizar via M-Pesa/e-Mola.</div></div>`}<div style="text-align:center;margin:28px 0;"><a href="${waLink}" class="btn btn-whatsapp">💬 Finalizar via WhatsApp</a></div></td></tr><tr><td class="footer"><div class="footer-brand">PayGo Moçambique 🇲🇿</div><div>Simples. Seguro. Moçambicano.</div><div class="footer-links"><a href="${baseUrl}">Site</a>•<a href="${baseUrl}/suporte">Suporte</a>•<a href="${baseUrl}/termos">Termos</a></div><div style="margin-top:12px;font-size:11px;color:#94a3b8;">© ${new Date().getFullYear()} PayGo Serviços Digitais</div></td></tr></table></div></body></html>`;

    case 'payment-confirmed':
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PayGo - Pagamento Confirmado</title><style>${getBaseStyles()}</style></head><body><div class="wrapper"><table class="container" cellpadding="0" cellspacing="0"><tr><td class="header" style="background:linear-gradient(135deg,${BRAND_COLORS.success} 0%,#059669 100%);"><div class="header-content"><div class="logo">✅ PayGo <span class="logo-badge">Confirmado</span></div></div></td></tr><tr><td class="content"><span class="hero-icon">🎉</span><h1 style="font-size:24px;font-weight:800;color:${BRAND_COLORS.dark};margin:0 0 8px;">Pagamento Recebido!</h1><p class="greeting">Olá, ${escapeHTML(vars.customer_name || 'Cliente')}.</p><p class="message">Recebemos o seu pagamento do pedido <span class="order-id">#${escapeHTML(vars.order_id)}</span>.</p><div class="card" style="border-color:#bbf7d0;background:linear-gradient(145deg,#f0fdf4,#dcfce7);"><div class="card-title" style="color:${BRAND_COLORS.success};">💸 Confirmação de Pagamento</div><div class="amount-highlight">${totalFormatted} MT</div><div class="detail-row"><span class="detail-label">Status</span><span class="status-badge completed">🔄 Em Processamento</span></div><div class="detail-row"><span class="detail-label">Pedido</span><span class="detail-value order-id">#${escapeHTML(vars.order_id)}</span></div></div><p style="text-align:center;color:#64748b;font-size:14px;margin:20px 0;">A nossa equipa irá processar o seu pedido e notificar-lhe em breve.</p><div style="text-align:center;"><a href="${waLink}" class="btn">📊 Acompanhar no WhatsApp</a></div></td></tr><tr><td class="footer"><div class="footer-brand">PayGo Moçambique 🇲🇿</div><div>O mundo no seu bolso.</div><div class="footer-links"><a href="${baseUrl}">Dashboard</a>•<a href="${baseUrl}/suporte">Ajuda</a></div></td></tr></table></div></body></html>`;

    case 'order-processing':
    case 'order-completed': {
      const status = template === 'order-processing' ? '🔄 Em Processamento' : '✅ Concluído';
      const statusColor = template === 'order-processing' ? BRAND_COLORS.warning : BRAND_COLORS.success;
      const statusBg = template === 'order-processing' ? '#fef3c7' : '#f0fdf4';
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PayGo - ${status}</title><style>${getBaseStyles()}</style></head><body><div class="wrapper"><table class="container" cellpadding="0" cellspacing="0"><tr><td class="header" style="background:linear-gradient(135deg,${statusColor} 0%,${statusColor === BRAND_COLORS.warning ? '#d97706' : '#059669'} 100%);"><div class="header-content"><div class="logo">${template === 'order-processing' ? '⏳' : '🎉'} PayGo <span class="logo-badge">${template === 'order-processing' ? 'Processando' : 'Concluído'}</span></div></div></td></tr><tr><td class="content"><span class="hero-icon">${template === 'order-processing' ? '🔄' : '✨'}</span><h1 style="font-size:24px;font-weight:800;color:${BRAND_COLORS.dark};margin:0 0 8px;">${status}</h1><p class="greeting">Olá, ${escapeHTML(vars.customer_name || 'Cliente')}.</p><p class="message">O seu pedido <span class="order-id">#${escapeHTML(vars.order_id)}</span> está <strong style="color:${statusColor};">${status.toLowerCase()}</strong>.</p><div class="card" style="background:${statusBg};border-color:${statusColor === BRAND_COLORS.warning ? '#fde68a' : '#bbf7d0'};"><div class="card-title" style="color:${statusColor};">📋 Estado Atual</div><div class="detail-row"><span class="detail-label">Fase</span><span class="detail-value">${template === 'order-processing' ? 'Processamento Internacional' : 'Despachado / Finalizado'}</span></div><div class="detail-row"><span class="detail-label">Atualizado</span><span class="detail-value">${new Date().toLocaleDateString('pt-MZ')}</span></div></div>${template === 'order-completed' ? `<p style="color:#64748b;font-size:14px;">Se a sua compra incluiu produtos físicos, verifique o código de rastreio na sua conta PayGo.</p>` : ''}<div style="text-align:center;margin:24px 0;"><a href="${baseUrl}/login.html" class="btn">🔐 Aceder à Minha Conta</a></div></td></tr><tr><td class="footer"><div class="footer-brand">PayGo Moçambique 🇲🇿</div><div>Suporte 24/7: <a href="https://wa.me/${WHATSAPP_NUMBER}" style="color:${BRAND_COLORS.primary};">WhatsApp</a></div></td></tr></table></div></body></html>`;
    }

    case 'password-reset':
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PayGo - Recuperação de Senha</title><style>${getBaseStyles()}</style></head><body><div class="wrapper"><table class="container" cellpadding="0" cellspacing="0"><tr><td class="header" style="background:linear-gradient(135deg,${BRAND_COLORS.purple} 0%,#7c3aed 100%);"><div class="header-content"><div class="logo">🔐 PayGo <span class="logo-badge">Segurança</span></div></div></td></tr><tr><td class="content"><span class="hero-icon">🛡️</span><h1 style="font-size:24px;font-weight:800;color:${BRAND_COLORS.dark};margin:0 0 8px;">Recuperação de Senha</h1><p class="message">Recebemos um pedido para redefinir a palavra-passe da sua conta PayGo. Se não foi você, ignore este email.</p><div class="alert"><div class="alert-title">⏱️ Este link expira em 1 hora</div><div style="color:#78350f;font-size:14px;">Por segurança, o link de recuperação é válido apenas por 60 minutos.</div></div><div style="text-align:center;margin:28px 0;"><a href="${escapeHTML(vars.reset_link || '#')}" class="btn" style="background:linear-gradient(135deg,${BRAND_COLORS.purple},#7c3aed);">🔄 Redefinir Palavra-passe</a></div><p style="color:#64748b;font-size:13px;text-align:center;">Ou copie este link manualmente:<br><span style="font-family:monospace;background:#f1f5f9;padding:4px 8px;border-radius:4px;">${escapeHTML(vars.reset_link || '#')}</span></p></td></tr><tr><td class="footer"><div class="footer-brand">PayGo Moçambique 🇲🇿</div><div>Este email foi enviado automaticamente. Não responda.</div></td></tr></table></div></body></html>`;

    case 'email-verification':
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PayGo - Verificar Email</title><style>${getBaseStyles()}</style></head><body><div class="wrapper"><table class="container" cellpadding="0" cellspacing="0"><tr><td class="header"><div class="header-content"><div class="logo">🛡️ PayGo <span class="logo-badge">Verificação</span></div></div></td></tr><tr><td class="content"><span class="hero-icon">✉️</span><h1 style="font-size:24px;font-weight:800;color:${BRAND_COLORS.dark};margin:0 0 8px;">Verifique o seu E-mail</h1><p class="greeting">Olá, ${escapeHTML(vars.customer_name || 'Parceiro')}!</p><p class="message">Confirme a sua conta para desbloquear todas as funcionalidades da PayGo e começar a explorar o mundo digital.</p><div class="card"><div class="card-title">🎁 Benefícios de Verificar</div><div class="detail-row"><span class="detail-label">✓</span><span class="detail-value">Acesso a promoções exclusivas</span></div><div class="detail-row"><span class="detail-label">✓</span><span class="detail-value">Programa de afiliados ativado</span></div><div class="detail-row"><span class="detail-label">✓</span><span class="detail-value">Suporte prioritário</span></div></div><div style="text-align:center;margin:28px 0;"><a href="${baseUrl}/seguranca.html?mode=verifyEmail&oobCode=${escapeHTML(vars.verificationToken || '')}" class="btn">✅ Verificar E-mail Agora</a></div><p style="color:#64748b;font-size:13px;text-align:center;">Link não funciona? Copie: <span style="font-family:monospace;">${baseUrl}/seguranca.html?mode=verifyEmail&oobCode=${escapeHTML(vars.verificationToken || '')}</span></p></td></tr><tr><td class="footer"><div class="footer-brand">PayGo Moçambique 🇲🇿</div><div>Bem-vindo à revolução digital.</div></td></tr></table></div></body></html>`;

    case 'welcome':
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PayGo - Bem-vindo!</title><style>${getBaseStyles()}</style></head><body><div class="wrapper"><table class="container" cellpadding="0" cellspacing="0"><tr><td class="header" style="background:linear-gradient(135deg,#8b5cf6 0%,#7c3aed 50%,#6d28d9 100%);"><div class="header-content"><div class="logo">🚀 PayGo <span class="logo-badge">Bem-vindo</span></div></div></td></tr><tr><td class="content"><span class="hero-icon">✨</span><h1 style="font-size:24px;font-weight:800;color:${BRAND_COLORS.dark};margin:0 0 8px;">Bem-vindo à PayGo!</h1><p class="greeting">Olá, ${escapeHTML(vars.customer_name || 'Cliente')}.</p><p class="message">A sua conta está ativa e pronta para usar. Explore o mundo dos pagamentos digitais com segurança e simplicidade.</p>${vars.affiliate_code ? `<div class="card" style="background:linear-gradient(135deg,#f0fdf4,#dcfce7);border-color:#22c55e;"><div class="card-title" style="color:#16a34a;">🎁 Código Promocional</div><div style="text-align:center;font-size:24px;font-weight:800;color:#166534;font-family:monospace;letter-spacing:2px;margin:12px 0;">${escapeHTML(vars.affiliate_code)}</div><div style="text-align:center;color:#166534;font-size:14px;">Use este código para ganhar recompensas!</div></div>` : ''}<div style="text-align:center;margin:28px 0;"><a href="${baseUrl}/login.html" class="btn" style="background:linear-gradient(135deg,#8b5cf6,#7c3aed);">🔐 Aceder à Conta</a></div><div class="divider"></div><p style="color:#64748b;font-size:14px;text-align:center;"><strong>Próximos passos:</strong><br>1️⃣ Complete o seu perfil<br>2️⃣ Adicione um método de pagamento<br>3️⃣ Comece a explorar!</p></td></tr><tr><td class="footer"><div class="footer-brand">PayGo Moçambique 🇲🇿</div><div>O futuro dos pagamentos começa aqui.</div><div class="footer-links"><a href="${baseUrl}">Explorar</a>•<a href="${baseUrl}/suporte">Ajuda</a>•<a href="${baseUrl}/afiliados">Afiliados</a></div></td></tr></table></div></body></html>`;

    default:
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PayGo - Notificação</title><style>${getBaseStyles()}</style></head><body><div class="wrapper"><table class="container" cellpadding="0" cellspacing="0"><tr><td class="header"><div class="header-content"><div class="logo">🔔 PayGo</div></div></td></tr><tr><td class="content"><h1 style="font-size:24px;font-weight:800;color:${BRAND_COLORS.dark};margin:0 0 16px;">Notificação PayGo</h1><p class="message">${escapeHTML(vars.message || 'Mensagem indisponível.')}</p><div style="text-align:center;margin:24px 0;"><a href="${baseUrl}" class="btn">🏠 Ir para Dashboard</a></div></td></tr><tr><td class="footer"><div class="footer-brand">PayGo Moçambique 🇲🇿</div><div>contact@paygo.co.mz | WhatsApp: +258 87 100 2255</div></td></tr></table></div></body></html>`;
  }
}

function generateEmailText(template, vars) {
  const footer = `\n\n---\nPayGo Moçambique 🇲🇿\nWhatsApp: +258 87 100 2255\n${SITE_URL}`;
  switch (template) {
    case 'order-confirmation': return `PEDIDO #${vars.order_id} REGISTADO ✅\n\nOlá ${vars.customer_name || 'Cliente'},\nO seu pedido foi recebido.\n\n💰 Total: ${vars.total_amount} MT\n💳 Método: ${(vars.payment_method || 'N/A').toUpperCase()}\n\n${String(vars.payment_method || '').includes('transferencia') ? '⚠️ Envie o comprovativo via WhatsApp.' : '🔔 Aguarde instruções de pagamento.'}${footer}`;
    case 'payment-confirmed': return `PAGAMENTO RECEBIDO 💸\n\nOlá ${vars.customer_name || 'Cliente'},\nRecebemos ${vars.total_amount} MT para o pedido #${vars.order_id}.\nStatus: 🔄 Em Processamento${footer}`;
    case 'order-processing': return `PEDIDO EM PROCESSAMENTO 🔄\n\nOlá ${vars.customer_name || 'Cliente'},\nO pedido #${vars.order_id} está a ser processado.${footer}`;
    case 'order-completed': return `PEDIDO CONCLUÍDO 🎉\n\nOlá ${vars.customer_name || 'Cliente'},\nO pedido #${vars.order_id} foi finalizado com sucesso.${footer}`;
    case 'password-reset': return `RECUPERAÇÃO DE SENHA 🔐\n\nRedefina a sua palavra-passe: ${vars.reset_link}\n\n⚠️ Link válido por 1 hora.${footer}`;
    case 'email-verification': return `VERIFIQUE O SEU E-MAIL 🛡️\n\nConfirme a sua conta: ${SITE_URL}/seguranca.html?mode=verifyEmail&oobCode=${vars.verificationToken}${footer}`;
    case 'welcome': return `BEM-VINDO À PAYGO! 🚀\n\nOlá ${vars.customer_name || 'Cliente'},\nA sua conta está ativa.${vars.affiliate_code ? `\n\n🎁 Código: ${vars.affiliate_code}` : ''}${footer}`;
    default: return `${String(vars.message || '').replace(/<[^>]*>?/gm, '')}${footer}`;
  }
}

function getFallbackSubject(template, vars) {
  switch (template) {
    case 'order-confirmation': return `🛒 Pedido #${vars.order_id || ''} Registado - PayGo`;
    case 'payment-confirmed': return `✅ Pagamento Confirmado - Pedido #${vars.order_id || ''}`;
    case 'order-processing': return `🔄 Pedido #${vars.order_id || ''} em Processamento`;
    case 'order-completed': return `🎉 Pedido #${vars.order_id || ''} Concluído - PayGo`;
    case 'password-reset': return '🔐 Recuperação de Senha - PayGo';
    case 'email-verification': return '🛡️ Verifique o seu e-mail - PayGo';
    case 'welcome': return '🚀 Bem-vindo à PayGo Moçambique!';
    default: return 'Notificação PayGo';
  }
}

// 🎨 GENERATE NOTIFY HTML (Admin Notifications)
function generateNotifyHTML(action, order, reason, extraAmount, mediaUrl) {
  const total = Number(order.total || order.amount || 0).toLocaleString('pt-MZ', { minimumFractionDigits: 2 });
  const orderId = order.orderId || order.topupId || 'N/A';

  const base = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${getBaseStyles()}</style></head><body><div class="wrapper"><table class="container" cellpadding="0" cellspacing="0">`;
  const foot = `<tr><td class="footer"><div class="footer-brand">PayGo Admin 🎛️</div><div>Painel de Controlo Interno</div></td></tr></table></div></body></html>`;

  switch(action) {
    case 'payment_confirmed':
      return `${base}<tr><td class="header" style="background:linear-gradient(135deg,${BRAND_COLORS.success},#059669);"><div class="header-content"><div class="logo">✅ PayGo <span class="logo-badge">Pago</span></div></div></td></tr><tr><td class="content"><span class="hero-icon">💸</span><h1 style="font-size:24px;font-weight:800;margin:0 0 8px;">Pagamento Recebido!</h1><p class="greeting">Olá, ${escapeHTML(order.name || 'Cliente')}.</p><div class="card" style="background:linear-gradient(145deg,#f0fdf4,#dcfce7);border-color:#bbf7d0;"><div class="card-title" style="color:${BRAND_COLORS.success};">🎉 Confirmação</div><div class="amount-highlight">${total} MT</div><div class="detail-row"><span class="detail-label">Pedido</span><span class="detail-value order-id">#${orderId}</span></div><div class="detail-row"><span class="detail-label">Status</span><span class="status-badge completed">🔄 Processando</span></div></div><p style="text-align:center;color:#64748b;">A equipa PayGo irá processar o seu pedido.</p></td></tr>${foot}`;

    case 'order_refunded':
      return `${base}<tr><td class="header" style="background:linear-gradient(135deg,${BRAND_COLORS.purple},#7c3aed);"><div class="header-content"><div class="logo">🟣 PayGo <span class="logo-badge">Reembolso</span></div></div></td></tr><tr><td class="content"><span class="hero-icon">↩️</span><h1 style="font-size:24px;font-weight:800;margin:0 0 8px;">Reembolso Emitido</h1><p class="greeting">Olá, ${escapeHTML(order.name || 'Cliente')}.</p><div class="card" style="background:linear-gradient(145deg,#faf5ff,#f3e8ff);border-color:#ddd6fe;"><div class="card-title" style="color:${BRAND_COLORS.purple};">💰 Valor Devolvido</div><div class="amount-highlight" style="color:${BRAND_COLORS.purple};">${total} MT</div><div class="detail-row"><span class="detail-label">Motivo</span><span class="detail-value">${escapeHTML(reason || 'Processado pela equipa.')}</span></div></div>${mediaUrl ? `<div style="text-align:center;margin:20px 0;"><a href="${mediaUrl}" class="btn" style="background:linear-gradient(135deg,${BRAND_COLORS.purple},#7c3aed);">📄 Ver Comprovativo</a></div>` : ''}</td></tr>${foot}`;

    case 'insufficient_funds':
      return `${base}<tr><td class="header" style="background:linear-gradient(135deg,${BRAND_COLORS.warning},#d97706);"><div class="header-content"><div class="logo">⚠️ PayGo <span class="logo-badge">Ação</span></div></div></td></tr><tr><td class="content"><span class="hero-icon">🔔</span><h1 style="font-size:24px;font-weight:800;margin:0 0 8px;">Ação Necessária</h1><p class="greeting">Olá, ${escapeHTML(order.name || 'Cliente')}.</p><p class="message">Houve uma alteração de custos no pedido <span class="order-id">#${orderId}</span>.</p><div class="alert"><div class="alert-title">💰 Valor em Falta</div><div style="font-size:24px;font-weight:800;color:#b45309;text-align:center;margin:8px 0;">${Number(extraAmount || 0).toLocaleString('pt-MZ', { minimumFractionDigits: 2 })} MT</div></div><div class="card"><div class="card-title" style="color:${BRAND_COLORS.warning};">📝 Justificação</div><p style="margin:0;color:#78350e;">${escapeHTML(reason || 'Subida de câmbio ou taxa extra de transporte.')}</p></div><div style="text-align:center;margin:24px 0;"><a href="${SITE_URL}/dashboard.html" class="btn">💳 Depositar Fundos</a></div></td></tr>${foot}`;

    default: {
      const waLink = getWhatsAppLink(order);
      const isBank = String(order.paymentMethod || '').includes('transferencia');
      return `${base}<tr><td class="header"><div class="header-content"><div class="logo">🛒 PayGo <span class="logo-badge">Novo</span></div></div></td></tr><tr><td class="content"><span class="hero-icon">📦</span><h1 style="font-size:24px;font-weight:800;margin:0 0 8px;">Pedido Registado!</h1><p class="greeting">Olá, ${escapeHTML(order.name || 'Cliente')}.</p><p class="message">O pedido <span class="order-id">#${orderId}</span> foi registado com sucesso.</p><div class="card"><div class="card-title">💰 Detalhes</div><div class="detail-row"><span class="detail-label">Total</span><span class="detail-value" style="color:${BRAND_COLORS.primary};font-size:18px;">${total} MT</span></div><div class="detail-row"><span class="detail-label">Método</span><span class="detail-value">${(order.paymentMethod || 'N/A').toUpperCase()}</span></div><div class="detail-row"><span class="detail-label">Cliente</span><span class="detail-value">${escapeHTML(order.name || 'N/A')}</span></div></div>${isBank ? `<div class="alert"><div class="alert-title">⚠️ Transferência Bancária</div><div style="color:#78350e;font-size:14px;">Envie o comprovativo via WhatsApp para validação.</div></div>` : `<div class="alert success"><div class="alert-title">🔔 Próximo Passo</div><div style="color:#166534;font-size:14px;">Aguarde instruções de pagamento no seu telemóvel.</div></div>`}<div style="text-align:center;margin:24px 0;"><a href="${waLink}" class="btn btn-whatsapp">💬 Falar no WhatsApp</a></div></td></tr>${foot}`;
    }
  }
}

// =========================================================
// 🎓 GROUP APPLICATIONS HELPERS
// =========================================================
const GROUP_APPLICATIONS_COLLECTION = 'group_applications';
const GROUP_APPLICATION_PRICE = 1200;

function normalizePhone(value = '') {
  return String(value || '').replace(/[^\d+]/g, '').trim();
}

function sanitizeText(value = '') {
  return String(value || '').trim();
}

function generateApplicationShortId() {
  const n = Math.floor(100000 + Math.random() * 900000);
  return `APL-${n}`;
}

function resolveApplicationCardProvider(cardProvider, cardProviderOther) {
  const provider = sanitizeText(cardProvider);
  const other = sanitizeText(cardProviderOther);
  if (provider === 'Outro') return other || 'Outro';
  return provider;
}

function mapApplicationStatus(status) {
  const clean = sanitizeText(status || 'pending');
  if (['pending', 'paid', 'confirmed', 'added_to_group'].includes(clean)) return clean;
  return 'pending';
}

async function generateUniqueApplicationShortId(db) {
  for (let i = 0; i < 10; i++) {
    const shortId = generateApplicationShortId();
    const existing = await db
      .collection(GROUP_APPLICATIONS_COLLECTION)
      .where('shortId', '==', shortId)
      .limit(1)
      .get();

    if (existing.empty) return shortId;
  }

  return `APL-${Date.now().toString().slice(-6)}`;
}

function buildApplicationPaymentReference(shortId) {
  return String(shortId || '').replace(/[^a-zA-Z0-9]/g, '');
}

async function createPaySuitePaymentLink(req, {
  orderId,
  amount,
  method = 'mpesa',
  description
}) {
  const cleanMethod = ['mpesa', 'm-pesa'].includes(method) ? 'mpesa' : method === 'card' ? 'card' : 'emola';
  const baseUrl = buildBaseUrl(req);

  const payload = {
    amount: parseFloat(amount),
    method: cleanMethod,
    reference: buildApplicationPaymentReference(orderId),
    description: description || `Candidatura PayGo ${orderId}`,
    callback_url: `${baseUrl}/api/paysuite-webhook`,
    return_url: `${baseUrl}/candidatura-cartao.html`
  };

  const response = await fetch(`${(process.env.PAYSUITE_API_URL || 'https://paysuite.tech/api/v1').replace(/\/+$/, '')}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${process.env.PAYSUITE_API_KEY || process.env.PAYSUITE_API_TOKEN}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });

  const textResponse = await response.text();

  let result;
  try {
    result = JSON.parse(textResponse);
  } catch {
    throw new Error('Resposta inválida da Paysuite.');
  }

  if (!response.ok || result.status === 'error') {
    throw new Error(result.message || 'Falha ao criar pagamento na Paysuite.');
  }

  return {
    paymentId: result.data?.id || null,
    reference: result.data?.reference || payload.reference,
    status: result.data?.status || 'pending',
    checkoutUrl: result.data?.checkout_url || null,
    amount: result.data?.amount || amount,
    method: cleanMethod,
    raw: result
  };
}

// =========================================================
// 🛠️ HANDLERS DE ROTAS
// =========================================================
async function handlePaySuitePayment(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Método não permitido' });
  const { orderId, amount, method, description } = body;
  if (!orderId || !amount || !method) return res.status(400).json({ success: false, error: 'Faltam campos obrigatórios (orderId, amount, method)' });
  if (isNaN(amount) || Number(amount) < 1) return res.status(400).json({ success: false, error: 'O valor mínimo é 1 MT' });

  const cleanMethod = ['mpesa', 'm-pesa'].includes(method) ? 'mpesa' : method === 'card' ? 'card' : 'emola';
  const cleanReference = String(orderId).replace(/[^a-zA-Z0-9]/g, '');
  const baseUrl = buildBaseUrl(req);
  const payload = {
    amount: parseFloat(amount),
    method: cleanMethod,
    reference: cleanReference,
    description: description || `Pedido PayGo #${orderId}`,
    callback_url: `${baseUrl}/api/paysuite-webhook`,
    return_url: `${baseUrl}/index.html`,
  };

  const response = await fetch(`${(process.env.PAYSUITE_API_URL || 'https://paysuite.tech/api/v1').replace(/\/+$/, '')}/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${process.env.PAYSUITE_API_KEY || process.env.PAYSUITE_API_TOKEN}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });

  const textResponse = await response.text();
  let result;
  try { result = JSON.parse(textResponse); } catch { return res.status(502).json({ success: false, error: `Serviço ${cleanMethod.toUpperCase()} indisponível.`, raw: textResponse.substring(0, 300) }); }
  if (!response.ok || result.status === 'error') return res.status(400).json({ success: false, error: result.message || 'Servidor rejeitou.', data: result });

  return res.status(200).json({ success: true, data: { paymentId: result.data?.id, status: result.data?.status, reference: result.data?.reference, checkoutUrl: result.data?.checkout_url, method: cleanMethod, amount: result.data?.amount }, message: 'Redirecione o cliente para o checkoutUrl' });
}

async function handlePaySuiteWebhook(req, res, body) {
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || body || {});
  const signature = req.headers['x-webhook-signature'] || req.headers['x-paysuite-signature'] || '';
  if (!verifyPaySuiteSignature(rawBody, String(signature))) {
    console.warn('Assinatura do webhook inválida, mas a execução continua (Debug Mode).');
  }

  const { db } = getFirebase();
  const agora = new Date().toISOString();
  await db.collection('webhook_logs').add({ source: 'paysuite', rawPayload: body, status: 'received', createdAt: agora, receivedAt: agora });

  if (!body || !body.event) return res.status(200).json({ warning: 'Payload sem event.' });
  const evento = body.event;
  const isSuccess = evento === 'payment.completed' || evento === 'payment.success';
  const isFailed = evento === 'payment.failed';
  const paymentData = body.data || body;
  let merchantReference = paymentData.reference || body.reference;

  if (merchantReference) {
    if (merchantReference.startsWith('PG') && !merchantReference.startsWith('PG-')) merchantReference = merchantReference.replace('PG', 'PG-');
    else if (merchantReference.startsWith('TOP') && !merchantReference.startsWith('TOP-')) merchantReference = merchantReference.replace('TOP', 'TOP-');
  }

  if (!merchantReference) return res.status(200).json({ warning: 'Sem Referência para processar' });

  if (merchantReference.startsWith('APL')) {
    const normalizedShortId = merchantReference.includes('-')
      ? merchantReference
      : merchantReference.replace(/^APL/, 'APL-');

    const snap = await db
      .collection(GROUP_APPLICATIONS_COLLECTION)
      .where('shortId', '==', normalizedShortId)
      .limit(1)
      .get();

    if (!snap.empty) {
      const docApp = snap.docs[0];
      const appData = docApp.data();

      if (isSuccess) {
        await docApp.ref.update({
          status: appData.status === 'added_to_group' ? 'added_to_group' : 'paid',
          isPaid: true,
          paymentStatus: 'paid',
          paysuitePaymentId: paymentData.payment_id || paymentData.id || appData.paysuitePaymentId || null,
          paysuiteReference: paymentData.reference || normalizedShortId,
          updatedAt: agora
        });

        await db.collection('admin_audit_logs').add({
          adminId: 'system_bot',
          adminName: '🤖 Sistema Automático',
          action: 'GROUP_APPLICATION_PAYMENT_CONFIRMED',
          targetId: docApp.id,
          targetType: 'group_application',
          details: {
            shortId: normalizedShortId,
            updated: {
              status: appData.status === 'added_to_group' ? 'added_to_group' : 'paid',
              isPaid: true,
              paymentStatus: 'paid'
            }
          },
          createdAt: agora
        });

        return res.status(200).json({ success: true, operation: 'group_application_paid' });
      }

      if (isFailed) {
        await docApp.ref.update({
          paymentStatus: 'failed',
          updatedAt: agora
        });

        return res.status(200).json({ success: true, operation: 'group_application_failed' });
      }
    }
  }

  if (merchantReference.startsWith('TOP-')) {
    const snap = await db.collection('topups').where('topupId', '==', merchantReference).get();
    if (snap.empty) return res.status(200).json({ warning: `Depósito ${merchantReference} não encontrado.` });

    const docTopup = snap.docs[0];
    const topupData = docTopup.data();

    if (isSuccess) {
      if (topupData.status === 'completed') return res.status(200).json({ message: 'Depósito já processado.' });

      const userId = topupData.userId;
      const amountToCredit = parseFloat(topupData.amount);

      await docTopup.ref.update({ status: 'completed', paysuiteId: paymentData.payment_id || paymentData.id || 'N/A', updatedAt: agora });
      await db.collection('users').doc(userId).update({ walletBalance: FieldValue.increment(amountToCredit) });
      await db.collection('wallet_transactions').add({ userId, type: 'credit', amount: amountToCredit, description: `Depósito via ${paymentData.method || 'M-Pesa/e-Mola'}`, reference: merchantReference, createdAt: agora });

      return res.status(200).json({ success: true, operation: 'wallet_funded' });
    }

    if (isFailed) {
      await docTopup.ref.update({ status: 'failed', updatedAt: agora });
      return res.status(200).json({ message: 'Depósito falhou.' });
    }
  }

  if (merchantReference.startsWith('PG-')) {
    const snap = await db.collection('orders').where('orderId', '==', merchantReference).get();
    if (snap.empty) return res.status(200).json({ warning: `Pedido ${merchantReference} não encontrado.` });

    const docOrder = snap.docs[0];
    const orderData = docOrder.data();

    if (isSuccess) {
      if (orderData.isPaid) return res.status(200).json({ message: 'Já pago.' });

      await docOrder.ref.update({ status: 'processing', isPaid: true, paysuitePaymentId: paymentData.payment_id || paymentData.id || 'N/A', updatedAt: agora });
      await db.collection('admin_audit_logs').add({ adminId: 'system_bot', adminName: '🤖 Sistema Automático', action: 'PAGAMENTO_CONFIRMADO', targetId: String(merchantReference), targetType: 'order', details: { updated: { status: 'processing', isPaid: true } }, createdAt: agora });

      return res.status(200).json({ success: true, operation: 'order_paid' });
    }

    if (isFailed && !orderData.isPaid) {
      await docOrder.ref.update({ status: 'cancelled', updatedAt: agora });
      return res.status(200).json({ message: 'Pedido cancelado por falha no pagamento.' });
    }
  }

  return res.status(200).json({ success: true, message: 'Referência processada.' });
}

async function handleDeleteUser(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { uid } = body;
  if (!uid) return res.status(400).json({ error: 'UID do utilizador não fornecido' });
  const { db, auth } = getFirebase();
  try { await auth.deleteUser(uid); } catch {}
  await db.collection('users').doc(uid).delete();
  return res.status(200).json({ success: true, message: 'Utilizador erradicado com sucesso.' });
}

async function handleGetReferrals(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
  const { affiliateCode } = body;
  if (!affiliateCode) return res.status(400).json({ error: 'Código de afiliado não fornecido.' });
  const { db } = getFirebase();
  const qUsers = await db.collection('users').where('referredBy', '==', affiliateCode).get();
  const referrals = [];
  qUsers.forEach((doc) => {
    const data = doc.data();
    let dateStr = null;
    if (data.createdAt) dateStr = typeof data.createdAt.toDate === 'function' ? data.createdAt.toDate().toISOString() : new Date(data.createdAt).toISOString();
    referrals.push({ id: doc.id, name: data.name || 'Cliente PayGo', email: data.email || '', status: data.status || 'pending', emailVerified: data.emailVerified || false, firstPurchaseProcessed: data.firstPurchaseProcessed || false, createdAt: dateStr });
  });
  return res.status(200).json({ success: true, referrals });
}

async function handleLogAction(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
  const { adminId, adminName, action, targetId, targetType, previousData, newData } = body || {};
  if (!adminId || !action || !targetId) return res.status(400).json({ error: 'DADOS_INCOMPLETOS', dados_recebidos: body });
  const { db } = getFirebase();
  const logData = { adminId: String(adminId), adminName: adminName ? String(adminName) : 'Admin Oculto', action: String(action), targetId: String(targetId), targetType: targetType ? String(targetType) : 'order', details: { previous: purificarDados(previousData), updated: purificarDados(newData) }, ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'Desconhecido', createdAt: new Date().toISOString() };
  const logRef = await db.collection('admin_audit_logs').add(logData);
  return res.status(200).json({ success: true, logId: logRef.id });
}

async function handleP2PTransfer(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
  const { senderId, receiverEmail, amount } = body;
  const transferAmount = parseFloat(amount);
  if (!senderId || !receiverEmail || isNaN(transferAmount) || transferAmount <= 0) return res.status(400).json({ error: 'Dados inválidos para transferência.' });
  const { db } = getFirebase();
  const agora = new Date().toISOString();
  const usersRef = db.collection('users');
  const receiverSnap = await usersRef.where('email', '==', receiverEmail).get();
  if (receiverSnap.empty) return res.status(404).json({ error: 'Atenção: Nenhum cliente PayGo encontrado com este e-mail.' });
  const receiverDoc = receiverSnap.docs[0];
  const receiverId = receiverDoc.id;
  if (senderId === receiverId) return res.status(400).json({ error: 'Não pode enviar dinheiro para si mesmo.' });
  const senderRef = usersRef.doc(senderId);
  const senderDoc = await senderRef.get();
  const senderBalance = parseFloat(senderDoc.data().walletBalance) || 0;
  if (senderBalance < transferAmount) return res.status(400).json({ error: 'Saldo insuficiente.' });
  const batch = db.batch();
  batch.update(senderRef, { walletBalance: FieldValue.increment(-transferAmount) });
  batch.update(receiverDoc.ref, { walletBalance: FieldValue.increment(transferAmount) });
  batch.set(db.collection('wallet_transactions').doc(), { userId: senderId, type: 'debit', amount: transferAmount, description: `Transferência para ${receiverEmail}`, reference: 'P2P', createdAt: agora });
  batch.set(db.collection('wallet_transactions').doc(), { userId: receiverId, type: 'credit', amount: transferAmount, description: `Recebido de ${senderDoc.data().email}`, reference: 'P2P', createdAt: agora });
  await batch.commit();
  return res.status(200).json({ success: true });
}

async function handleSendWhatsAppInvoice(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Método não permitido.' });
  const { orderId, clientName, phone, pdfData } = body;
  if (!orderId || !clientName || !phone || !pdfData) return res.status(400).json({ success: false, error: 'Dados incompletos.' });
  const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
  const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
  const INSTANCE_NAME = process.env.INSTANCE_NAME;
  let cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length <= 9) cleanPhone = '258' + cleanPhone;
  const base64Pure = pdfData.split('base64,')[1];
  const messageText = `Olá ${clientName}! 👋\nA tua compra foi processada com sucesso pela PayGo.\n📄 Abaixo segue o teu comprovativo oficial (Pedido: ${orderId}).\nObrigado por confiares em nós! 🇲🇿`;
  const response = await axios.post(`${EVOLUTION_API_URL}/message/sendMedia/${INSTANCE_NAME}`, { number: cleanPhone, options: { delay: 1200, presence: 'composing' }, mediaMessage: { mediatype: 'document', fileName: `Fatura_${orderId}.pdf`, caption: messageText, media: base64Pure } }, { headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY } });
  if (response.status === 200 || response.status === 201) return res.status(200).json({ success: true, message: 'Fatura enviada no WhatsApp!' });
  throw new Error('Falha de comunicação com a API do WhatsApp.');
}

async function handleRecoverPassword(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email } = body;
  if (!email) return res.status(400).json({ error: 'Email missing' });
  const { auth } = getFirebase();
  const firebaseLink = await auth.generatePasswordResetLink(email);
  const urlObj = new URL(firebaseLink);
  const oobCode = urlObj.searchParams.get('oobCode');
  const customResetLink = `${SITE_URL}/seguranca.html?mode=resetPassword&oobCode=${oobCode}`;
  if (!resend) return res.status(500).json({ error: 'Sem API KEY da Resend' });
  await resend.emails.send({ from: FROM_EMAIL, to: email, subject: '🔐 Recuperação de Senha - PayGo', html: generateEmailHTML('password-reset', { reset_link: customResetLink }) });
  return res.status(200).json({ success: true, message: 'Link de segurança enviado.' });
}

async function handleVerifyEmail(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
  const { email, name } = body;
  if (!email) return res.status(400).json({ error: 'Email não fornecido.' });
  const { auth } = getFirebase();
  const firebaseLink = await auth.generateEmailVerificationLink(email);
  const urlObj = new URL(firebaseLink);
  const oobCode = urlObj.searchParams.get('oobCode');
  const customVerifyLink = `${SITE_URL}/seguranca.html?mode=verifyEmail&oobCode=${oobCode}`;
  if (!resend) return res.status(500).json({ error: 'Sem API KEY da Resend' });
  await resend.emails.send({ from: FROM_EMAIL, to: email, subject: '🛡️ Verifique a sua conta PayGo', html: generateEmailHTML('email-verification', { verificationToken: oobCode, customer_name: name }) });
  return res.status(200).json({ success: true, message: 'Email de verificação enviado.' });
}

async function handleSendEmail(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { to, subject, template, variables, type, sendLark = false } = body;
  if (!to || !template) return res.status(400).json({ error: 'Faltam campos obrigatórios: to, template' });
  if (!resend) return res.status(500).json({ error: 'Sem API KEY da Resend' });

  const html = generateEmailHTML(template, variables || {});
  const text = generateEmailText(template, variables || {});
  const results = { email: null, lark: null };

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: subject || getFallbackSubject(template, variables || {}),
    html,
    text,
    headers: { 'X-PayGo-Template': template, 'X-PayGo-Type': type || 'transactional', 'X-PayGo-Version': '3.0-HYPER' }
  });

  if (error) {
    results.email = { success: false, error: error.message };
  } else {
    results.email = { success: true, id: data?.id };
  }

  if (sendLark) {
    results.lark = await sendLarkNotification(`📧 Email Enviado: ${template}`, 'blue', [
      { is_short: true, text: { tag: 'lark_md', content: `**Para:**\n${to}` } },
      { is_short: true, text: { tag: 'lark_md', content: `**Template:**\n${template}` } }
    ]);
  }

  return res.status(200).json({ success: true, results, template });
}

async function handleNotifyOrder(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { orderData, sendEmail = true, sendLark = true, action = 'new_order', reason, extraAmount, mediaUrl } = body;
  if (!orderData) return res.status(400).json({ error: 'Payload não reconhecido.' });

  const results = { email: null, lark: null };
  const orderId = orderData.orderId || orderData.topupId || 'N/A';
  let emailSubject, emailHTML, emailText;
  let larkColor = 'blue', larkTitle = '🛒 Novo Pedido PayGo';

  switch (action) {
    case 'payment_confirmed':
      emailSubject = `✅ Pagamento Recebido - Pedido ${orderId} - PayGo`;
      emailHTML = generateNotifyHTML('payment_confirmed', orderData, reason, extraAmount, mediaUrl);
      emailText = `PAGAMENTO RECEBIDO - PAYGO\nOlá ${orderData.name || 'Cliente'},\nRecebemos o seu pagamento referente ao pedido #${orderId}.\nO pedido encontra-se agora em processamento.`;
      larkColor = 'green'; larkTitle = '✅ PAGAMENTO RECEBIDO';
      break;
    case 'order_refunded':
      emailSubject = `🟣 Reembolso Emitido - Pedido ${orderId} - PayGo`;
      emailHTML = generateNotifyHTML('order_refunded', orderData, reason, extraAmount, mediaUrl);
      emailText = `REEMBOLSO EMITIDO - PAYGO\nOlá ${orderData.name || 'Cliente'},\nO valor de ${orderData.total || orderData.amount || 0} MT foi reembolsado.\nMotivo: ${reason || 'Reembolso processado pela equipa.'}`;
      larkColor = 'purple'; larkTitle = '🟣 REEMBOLSO EMITIDO';
      break;
    case 'insufficient_funds':
      emailSubject = `⚠️ Ação Necessária: Ajuste de Valor - Pedido ${orderId}`;
      emailHTML = generateNotifyHTML('insufficient_funds', orderData, reason, extraAmount, mediaUrl);
      emailText = `ATENÇÃO: FALTA DE FUNDOS - PAYGO\nOlá ${orderData.name || 'Cliente'},\nFalta o valor de ${extraAmount || 0} MT para processar o seu pedido #${orderId}.\nMotivo: ${reason || 'Alteração de custos.'}`;
      larkColor = 'orange'; larkTitle = '⚠️ ALERTA: FALTA DE FUNDOS';
      break;
    default:
      emailSubject = `🛒 Pedido ${orderId} Registado - PayGo`;
      emailHTML = generateNotifyHTML('new_order', orderData, reason, extraAmount, mediaUrl);
      emailText = `PEDIDO REGISTADO - PAYGO\nOlá ${orderData.name || 'Cliente'},\nO pedido #${orderId} foi registado.\nTotal: ${orderData.total || orderData.amount || 0} MT\nMétodo: ${(orderData.paymentMethod || 'N/A').toUpperCase()}`;
  }

  if (sendEmail && orderData.email && orderData.email.includes('@') && resend) {
    try {
      const { data, error } = await resend.emails.send({ from: FROM_EMAIL, to: [orderData.email], subject: emailSubject, html: emailHTML, text: emailText });
      if (error) { results.email = { success: false, error: error.message }; }
      else { results.email = { success: true, id: data?.id }; }
    } catch (err) { results.email = { success: false, error: err.message }; }
  } else {
    results.email = { success: false, error: 'Email inválido ou Resend não configurado.' };
  }

  if (sendLark && process.env.LARK_WEBHOOK_URL) {
    const fields = [
      { is_short: true, text: { tag: 'lark_md', content: `**ID:**\n#${orderId}` } },
      { is_short: true, text: { tag: 'lark_md', content: `**Cliente:**\n${orderData.name || 'N/A'}` } },
      { is_short: true, text: { tag: 'lark_md', content: `**Total:**\n${orderData.total || orderData.amount || 0} MT` } },
      { is_short: true, text: { tag: 'lark_md', content: `**Método:**\n${(orderData.paymentMethod || 'N/A').toUpperCase()}` } }
    ];
    if (reason) fields.push({ is_short: false, text: { tag: 'lark_md', content: `**Motivo / Nota:**\n${reason}` } });
    if (extraAmount) fields.push({ is_short: false, text: { tag: 'lark_md', content: `**Valor em Falta:**\n${extraAmount} MT` } });
    if (orderData.paysuitePaymentId) fields.push({ is_short: false, text: { tag: 'lark_md', content: `**Ref PaySuite:**\n${orderData.paysuitePaymentId}` } });
    fields.push({ is_short: false, text: { tag: 'lark_md', content: `**Detalhe:**\n${String(orderData.detail || '').substring(0, 150)}` } });

    results.lark = await sendLarkNotification(larkTitle, larkColor, fields, [
      { tag: 'button', text: { tag: 'plain_text', content: 'Ver no Admin' }, type: 'primary', url: `${SITE_URL}/admin/` }
    ]);
  }

  return res.status(200).json({ success: true, message: 'Processado com sucesso', results });
}

// =========================================================
// 🎓 GROUP APPLICATIONS HANDLERS
// =========================================================
async function handleCreateGroupApplication(req, res, body) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método não permitido' });
  }

  try {
    const authUser = await getAuthenticatedUser(req);
    const { db } = getFirebase();

    const fullName = sanitizeText(body.fullName || authUser.name);
    const email = sanitizeText(body.email || authUser.email).toLowerCase();
    const whatsapp = normalizePhone(body.whatsapp);
    const city = sanitizeText(body.city);
    const goal = sanitizeText(body.goal);
    const paymentName = sanitizeText(body.paymentName);
    const notes = sanitizeText(body.notes);
    const cardOption = sanitizeText(body.cardOption) || 'no_card';
    const paymentMethod = sanitizeText(body.paymentMethod) || 'mpesa';
    const createPayment = Boolean(body.createPayment);
    const cardProvider = resolveApplicationCardProvider(body.cardProvider, body.cardProviderOther);

    if (!fullName || fullName.length < 3) {
      return res.status(400).json({ success: false, error: 'Nome completo inválido.' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'Email inválido.' });
    }
    if (!whatsapp || whatsapp.replace(/\D/g, '').length < 8) {
      return res.status(400).json({ success: false, error: 'WhatsApp inválido.' });
    }
    if (!goal || goal.length < 10) {
      return res.status(400).json({ success: false, error: 'Objetivo inválido.' });
    }
    if (!paymentName || paymentName.length < 3) {
      return res.status(400).json({ success: false, error: 'Nome de pagamento inválido.' });
    }
    if (!['no_card', 'have_card_recharge'].includes(cardOption)) {
      return res.status(400).json({ success: false, error: 'Opção de cartão inválida.' });
    }
    if (!['mpesa', 'emola'].includes(paymentMethod)) {
      return res.status(400).json({ success: false, error: 'Método de pagamento inválido.' });
    }
    if (cardOption === 'have_card_recharge' && !cardProvider) {
      return res.status(400).json({ success: false, error: 'Provedor do cartão é obrigatório.' });
    }

    const now = new Date().toISOString();

    const existingSnap = await db
      .collection(GROUP_APPLICATIONS_COLLECTION)
      .where('userId', '==', authUser.uid)
      .limit(1)
      .get();

    let docRef;
    let shortId;
    let existingData = null;

    if (!existingSnap.empty) {
      const existingDoc = existingSnap.docs[0];
      docRef = existingDoc.ref;
      existingData = existingDoc.data();
      shortId = existingData.shortId;

      await docRef.update({
        fullName,
        email,
        whatsapp,
        city,
        goal,
        paymentName,
        notes,
        cardOption,
        cardProvider: cardOption === 'have_card_recharge' ? cardProvider : '',
        paymentMethod,
        updatedAt: now
      });
    } else {
      shortId = await generateUniqueApplicationShortId(db);

      const applicationData = {
        userId: authUser.uid,
        shortId,
        fullName,
        email,
        whatsapp,
        city,
        goal,
        paymentName,
        notes,
        cardOption,
        cardProvider: cardOption === 'have_card_recharge' ? cardProvider : '',
        amount: GROUP_APPLICATION_PRICE,
        currency: 'MZN',
        status: 'pending',
        paymentMethod,
        paymentStatus: 'pending',
        isPaid: false,
        paysuiteCheckoutUrl: null,
        paysuitePaymentId: null,
        paysuiteReference: null,
        createdAt: now,
        updatedAt: now,
        source: 'landing_page',
        adminNotes: []
      };

      docRef = await db.collection(GROUP_APPLICATIONS_COLLECTION).add(applicationData);
    }

    let checkoutData = null;

    if (createPayment) {
      try {
        checkoutData = await createPaySuitePaymentLink(req, {
          orderId: shortId,
          amount: GROUP_APPLICATION_PRICE,
          method: paymentMethod,
          description: `Candidatura para aulas de cartão virtual - ${shortId}`
        });

        await docRef.update({
          paymentMethod,
          paysuiteCheckoutUrl: checkoutData.checkoutUrl || null,
          paysuitePaymentId: checkoutData.paymentId || null,
          paysuiteReference: checkoutData.reference || null,
          paymentStatus: checkoutData.status || 'pending',
          paymentError: null,
          updatedAt: new Date().toISOString()
        });
      } catch (error) {
        await docRef.update({
          paymentMethod,
          paymentError: error.message || 'Falha ao gerar checkout',
          updatedAt: new Date().toISOString()
        });
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        id: docRef.id,
        shortId,
        status: existingData?.status || 'pending',
        amount: GROUP_APPLICATION_PRICE,
        paymentMethod,
        checkoutUrl: checkoutData?.checkoutUrl || existingData?.paysuiteCheckoutUrl || null,
        paymentId: checkoutData?.paymentId || existingData?.paysuitePaymentId || null,
        paymentStatus: checkoutData?.status || existingData?.paymentStatus || 'pending',
        alreadyExists: Boolean(existingData)
      }
    });
  } catch (error) {
    return res.status(403).json({
      success: false,
      error: error.message || 'Acesso negado.'
    });
  }
}

async function handleGetMyGroupApplication(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método não permitido' });
  }

  try {
    const authUser = await getAuthenticatedUser(req);
    const { db } = getFirebase();

    const snap = await db
      .collection(GROUP_APPLICATIONS_COLLECTION)
      .where('userId', '==', authUser.uid)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(200).json({
        success: true,
        application: null
      });
    }

    const doc = snap.docs[0];
    return res.status(200).json({
      success: true,
      application: {
        id: doc.id,
        ...doc.data()
      }
    });
  } catch (error) {
    return res.status(403).json({
      success: false,
      error: error.message || 'Acesso negado.'
    });
  }
}

async function handleGetGroupApplication(req, res, body) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método não permitido' });
  }

  const { db } = getFirebase();
  const shortId = sanitizeText(body.shortId);

  if (!shortId) {
    return res.status(400).json({ success: false, error: 'shortId é obrigatório.' });
  }

  const snap = await db
    .collection(GROUP_APPLICATIONS_COLLECTION)
    .where('shortId', '==', shortId)
    .limit(1)
    .get();

  if (snap.empty) {
    return res.status(404).json({ success: false, error: 'Candidatura não encontrada.' });
  }

  const doc = snap.docs[0];
  const data = doc.data();

  return res.status(200).json({
    success: true,
    application: {
      id: doc.id,
      ...data
    }
  });
}

async function handleGetGroupApplications(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Método não permitido' });
  }

  try {
    await getAuthenticatedAdmin(req);
    const { db } = getFirebase();

    const snap = await db
      .collection(GROUP_APPLICATIONS_COLLECTION)
      .orderBy('createdAt', 'desc')
      .get();

    const applications = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    }));

    return res.status(200).json({
      success: true,
      applications
    });
  } catch (error) {
    return res.status(403).json({
      success: false,
      error: error.message || 'Acesso negado.'
    });
  }
}

async function handleUpdateGroupApplicationStatus(req, res, body) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método não permitido' });
  }

  try {
    const adminUser = await getAuthenticatedAdmin(req);
    const { db } = getFirebase();

    const applicationId = sanitizeText(body.applicationId);
    const status = mapApplicationStatus(body.status);
    const adminNote = sanitizeText(body.adminNote);

    if (!applicationId) {
      return res.status(400).json({ success: false, error: 'applicationId é obrigatório.' });
    }

    const docRef = db.collection(GROUP_APPLICATIONS_COLLECTION).doc(applicationId);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({ success: false, error: 'Candidatura não encontrada.' });
    }

    const currentData = docSnap.data() || {};
    const now = new Date().toISOString();

    const updateData = {
      status,
      updatedAt: now
    };

    if (['paid', 'confirmed', 'added_to_group'].includes(status)) {
      updateData.isPaid = true;
      updateData.paymentStatus = 'paid';
    }

    if (status === 'pending' && currentData.isPaid !== true) {
      updateData.paymentStatus = 'pending';
    }

    if (adminNote) {
      updateData.adminNotes = FieldValue.arrayUnion({
        text: adminNote,
        adminName: adminUser.name,
        adminId: adminUser.uid,
        createdAt: now
      });
    }

    await docRef.update(updateData);

    await db.collection('admin_audit_logs').add({
      adminId: adminUser.uid,
      adminName: adminUser.name,
      action: 'UPDATE_GROUP_APPLICATION_STATUS',
      targetId: applicationId,
      targetType: 'group_application',
      details: {
        previous: {
          status: currentData.status || 'pending',
          isPaid: Boolean(currentData.isPaid),
          paymentStatus: currentData.paymentStatus || 'pending'
        },
        updated: updateData
      },
      createdAt: now
    });

    return res.status(200).json({
      success: true,
      message: 'Estado atualizado com sucesso.'
    });
  } catch (error) {
    return res.status(403).json({
      success: false,
      error: error.message || 'Acesso negado.'
    });
  }
}

// =========================================================
// 🗺️ MAPA DE ROTAS & EXPORT
// =========================================================
const routes = {
  'paysuite-payment': handlePaySuitePayment,
  'paysuite-webhook': handlePaySuiteWebhook,
  'delete-user': handleDeleteUser,
  'get-referrals': handleGetReferrals,
  'log-action': handleLogAction,
  'p2p-transfer': handleP2PTransfer,
  'send-whatsapp-invoice': handleSendWhatsAppInvoice,
  'send-email': handleSendEmail,
  'recover-password': handleRecoverPassword,
  'verify-email': handleVerifyEmail,
  'notify-order': handleNotifyOrder,

  'create-group-application': handleCreateGroupApplication,
  'get-my-group-application': handleGetMyGroupApplication,
  'get-group-application': handleGetGroupApplication,
  'get-group-applications': handleGetGroupApplications,
  'update-group-application-status': handleUpdateGroupApplicationStatus,
};

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const route = getRoute(req);
    const body = normalizeBody(req);
    const endpoint = routes[route];

    if (!endpoint) {
      return res.status(404).json({
        success: false,
        error: 'Endpoint não encontrado',
        route,
        available: Object.keys(routes)
      });
    }

    return await endpoint(req, res, body);
  } catch (error) {
    console.error('❌ [api/[...slug]] Erro crítico:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno do servidor'
    });
  }
}
