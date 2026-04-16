// ==========================================
// 🚀 PAYGO MASTER API - ROTEADOR UNIFICADO (PRODUÇÃO)
// ==========================================
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Resend } = require("resend");
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

// ==========================================
// 1. CONFIGURAÇÕES GLOBAIS E SEGURANÇA
// ==========================================
const app = express();
const PORT = process.env.PORT || 3000;

// Configuração Avançada de CORS com Intercetador Preflight
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'https://paygo.co.mz', 'https://www.paygo.co.mz', 'https://paygo-14311.web.app'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Proteção vital contra Erro 405

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || "258871002255";
const FROM_EMAIL = `PayGo Moçambique <${process.env.FROM_EMAIL || 'noreply@paygo.co.mz'}>`;
const SITE_URL = process.env.SITE_URL || 'https://paygo.co.mz';

let resend = null;
if (process.env.RESEND_API_KEY) {
  try { resend = new Resend(process.env.RESEND_API_KEY); } 
  catch(e) { console.warn("⚠️ Falha ao inicializar Resend."); }
}

// ==========================================
// 2. INICIALIZAÇÃO FIREBASE ADMIN SEGURA
// ==========================================
let db = null;
let auth = null;

try {
  if (!getApps().length) {
    const envVar = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!envVar) throw new Error("FIREBASE_SERVICE_ACCOUNT em falta.");

    let serviceAccount = JSON.parse(envVar);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    
    initializeApp({ 
      credential: cert(serviceAccount),
      databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
    console.log("✅ Firebase Admin inicializado.");
  }

  const adminApp = getApps()[0];
  // Fallback dinâmico para garantir que a Base de Dados é encontrada
  try { db = getFirestore(adminApp, "paygodb"); } 
  catch (e) { db = getFirestore(adminApp); }
  auth = getAuth(adminApp);
  
} catch (firebaseError) {
  console.error("❌ Falha crítica Firebase:", firebaseError.message);
}

// ==========================================
// 3. MIDDLEWARE DE AUTENTICAÇÃO ADMIN
// ==========================================
const requireAdminAuth = async (req, res, next) => {
  try {
    if (!db) return res.status(500).json({ error: 'Base de dados indisponível.' });
    
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token não fornecido' });
    
    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await auth.verifyIdToken(token);
    
    const userDoc = await db.collection('users').doc(decodedToken.uid).get();
    if (!userDoc.exists) return res.status(403).json({ error: 'Usuário não encontrado' });
    
    const userData = userDoc.data();
    if (userData.role !== 'admin' && userData.role !== 'superadmin') {
      return res.status(403).json({ error: 'Acesso restrito' });
    }
    
    req.admin = { uid: decodedToken.uid, email: decodedToken.email, name: userData.name, role: userData.role };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido/expirado' });
  }
};

// ==========================================
// 4. ROTAS DA API
// ==========================================

app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "PayGo Master API Online 🚀", environment: process.env.NODE_ENV || 'development' });
});

app.post("/api/delete-user", requireAdminAuth, async (req, res) => {
  try {
    const { uid, reason } = req.body;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    
    await db.collection('admin_audit_logs').add({ adminId: req.admin.uid, adminName: req.admin.name, action: 'DELETE_USER', targetId: uid, targetType: 'user', details: { reason: reason || 'Não especificado' }, ip: req.ip || '0.0.0.0', createdAt: Timestamp.now() });
    
    try { await auth.deleteUser(uid); } catch (e) { console.warn(`⚠️ Auth: ${e.message}`); }
    await db.collection('users').doc(uid).delete();
    
    const batch = db.batch();
    for (const coll of ['orders', 'wallet_transactions', 'withdrawals', 'support_tickets']) {
      const snapshot = await db.collection(coll).where('userId', '==', uid).limit(100).get();
      snapshot.forEach(doc => batch.delete(doc.ref));
    }
    if (batch._operations && batch._operations.length > 0) await batch.commit();
    
    return res.status(200).json({ success: true, message: 'Usuário apagado' });
  } catch (error) {
    return res.status(500).json({ error: 'Erro interno', details: error.message });
  }
});

app.post("/api/get-referrals", requireAdminAuth, async (req, res) => {
  try {
    const { affiliateCode, limit = 100 } = req.body;
    if (!affiliateCode) return res.status(400).json({ error: 'Código em falta' });
    
    const qUsers = await db.collection("users").where("referredBy", "==", affiliateCode).orderBy("createdAt", "desc").limit(limit).get();
    const referrals = [];
    
    qUsers.forEach(doc => {
      const data = doc.data();
      let dateStr = null;
      if (data.createdAt) dateStr = (data.createdAt instanceof Timestamp || typeof data.createdAt.toDate === 'function') ? data.createdAt.toDate().toISOString() : new Date(data.createdAt).toISOString();
      referrals.push({ id: doc.id, name: data.name || 'Cliente PayGo', email: data.email || '', phone: data.phone || '', status: data.status || 'pending', emailVerified: data.emailVerified || false, firstPurchaseProcessed: data.firstPurchaseProcessed || false, totalPurchases: data.totalPurchases || 0, walletBalance: data.walletBalance || 0, createdAt: dateStr, lastLogin: data.lastLogin || null });
    });
    
    return res.status(200).json({ success: true, count: referrals.length, referrals });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao carregar', details: err.message });
  }
});

app.post("/api/log-action", requireAdminAuth, async (req, res) => {
  try {
    const { action, targetId, targetType, previousData, newData, reason } = req.body;
    if (!action || !targetId) return res.status(400).json({ error: 'Dados obrigatórios em falta' });
    
    const sanitizeData = (obj) => {
      if (obj === null || obj === undefined) return null;
      if (typeof obj !== 'object') return obj;
      const sensitive = ['password', 'token', 'apiKey', 'private_key', 'secret'];
      const cleaned = {};
      for (const [key, value] of Object.entries(obj)) {
        if (sensitive.some(s => key.toLowerCase().includes(s))) cleaned[key] = '[REDACTED]';
        else if (typeof value === 'object' && value !== null) cleaned[key] = sanitizeData(value);
        else cleaned[key] = value;
      }
      return cleaned;
    };

    const logRef = await db.collection('admin_audit_logs').add({ adminId: req.admin.uid, adminName: req.admin.name || 'Admin', adminRole: req.admin.role, action: String(action), targetId: String(targetId), targetType: targetType ? String(targetType) : 'unknown', reason: reason || null, details: { previous: sanitizeData(previousData), updated: sanitizeData(newData) }, metadata: { ip: req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '0.0.0.0', timestamp: new Date().toISOString() }, createdAt: Timestamp.now() });
    
    return res.status(200).json({ success: true, logId: logRef.id });
  } catch (err) {
    return res.status(500).json({ error: 'Falha de auditoria', details: err.message });
  }
});

app.post("/api/notify-order", async (req, res) => {
  try {
    const body = req.body;
    if (body.type && body.data) return res.status(200).json({ success: true, message: "Use /api/paysuite-webhook." });
    const { orderData, sendEmail = true, sendLark = true, action = 'new_order', reason, extraAmount, mediaUrl } = body;
    if (!orderData) return res.status(400).json({ error: 'Dados do pedido obrigatórios' });

    const results = { email: null, lark: null };
    const orderId = orderData.orderId || orderData.topupId || orderData.id || 'N/A';
    const userEmail = orderData.email;

    let emailSubject, emailHTML;
    switch (action) {
      case 'payment_confirmed': emailSubject = `✅ Pagamento Recebido - Pedido ${orderId} - PayGo`; emailHTML = generatePaymentSuccessHTML(orderData); break;
      case 'order_refunded': emailSubject = `🟣 Reembolso Emitido - Pedido ${orderId} - PayGo`; emailHTML = generateRefundHTML(orderData, reason, mediaUrl); break;
      case 'insufficient_funds': emailSubject = `⚠️ Ação Necessária - Pedido ${orderId}`; emailHTML = generateInsufficientFundsHTML(orderData, extraAmount, reason); break;
      case 'order_completed': emailSubject = `🎉 Pedido Concluído - #${orderId} - PayGo`; emailHTML = generateOrderCompletedHTML(orderData); break;
      default: emailSubject = `🛒 Pedido ${orderId} Registado - PayGo`; emailHTML = generateOrderConfirmationHTML(orderData);
    }

    if (sendEmail && userEmail && resend) {
      try {
        const { data, error } = await resend.emails.send({ from: FROM_EMAIL, to: [userEmail], subject: emailSubject, html: emailHTML, text: emailHTML.replace(/<[^>]*>/g, '') });
        results.email = error ? { success: false, error: error.message } : { success: true, id: data?.id };
      } catch (emailError) { results.email = { success: false, error: emailError.message }; }
    }

    if (sendLark && process.env.LARK_WEBHOOK_URL) {
      try {
        await fetch(process.env.LARK_WEBHOOK_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msg_type: "post", content: { post: { "pt-MZ": { title: `🔔 ${action === 'new_order' ? 'Novo Pedido' : 'Atualização'}: ${orderId}`, content: [[ { tag: "text", text: `Cliente: ${orderData.name}\n` }, { tag: "text", text: `Valor: ${orderData.total?.toFixed(2) || 'N/A'} MT\n` }, { tag: "a", text: "Ver no Painel", href: `${SITE_URL}/admin/pedidos.html?id=${orderId}` } ]] } } } })
        });
        results.lark = { success: true };
      } catch (larkError) { results.lark = { success: false, error: larkError.message }; }
    }
    return res.status(200).json({ success: true, results });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno nas notificações', details: err.message });
  }
});

app.post("/api/p2p-transfer", requireAdminAuth, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Base de dados offline' });
    const { senderId, receiverEmail, amount, description } = req.body;
    const transferAmount = parseFloat(amount);

    if (!senderId || !receiverEmail) return res.status(400).json({ error: 'senderId e receiverEmail obrigatórios' });
    if (isNaN(transferAmount) || transferAmount <= 0 || transferAmount > 50000) return res.status(400).json({ error: 'Valor inválido ou excede 50.000 MT' });

    const usersRef = db.collection('users');
    const receiverSnap = await usersRef.where('email', '==', receiverEmail.trim().toLowerCase()).limit(1).get();
    if (receiverSnap.empty) return res.status(404).json({ error: 'Destinatário não encontrado' });
    
    const receiverDoc = receiverSnap.docs[0];
    if (senderId === receiverDoc.id) return res.status(400).json({ error: 'Transação inválida' });

    const senderRef = usersRef.doc(senderId);
    const senderDoc = await senderRef.get();
    if (!senderDoc.exists) return res.status(404).json({ error: 'Remetente não encontrado' });
    
    const senderBalance = parseFloat(senderDoc.data().walletBalance) || 0;
    if (senderBalance < transferAmount) return res.status(400).json({ error: `Saldo insuficiente. Disponível: ${senderBalance.toFixed(2)} MT` });

    const batch = db.batch();
    const transactionId = `P2P-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    const agora = Timestamp.now();
    
    batch.update(senderRef, { walletBalance: FieldValue.increment(-transferAmount), updatedAt: agora });
    batch.update(receiverDoc.ref, { walletBalance: FieldValue.increment(transferAmount), updatedAt: agora });
    batch.set(db.collection('wallet_transactions').doc(), { userId: senderId, type: 'debit', amount: transferAmount, description: description || `P2P para ${receiverEmail}`, reference: transactionId, relatedUserId: receiverDoc.id, createdAt: agora, metadata: { type: 'p2p', direction: 'sent' } });
    batch.set(db.collection('wallet_transactions').doc(), { userId: receiverDoc.id, type: 'credit', amount: transferAmount, description: description || `Recebido de ${senderDoc.data().email}`, reference: transactionId, relatedUserId: senderId, createdAt: agora, metadata: { type: 'p2p', direction: 'received' } });

    await batch.commit();
    await db.collection('admin_audit_logs').add({ adminId: req.admin.uid, adminName: req.admin.name, action: 'P2P_TRANSFER', targetId: transactionId, targetType: 'transaction', details: { from: senderId, to: receiverDoc.id, amount: transferAmount }, createdAt: agora });

    return res.status(200).json({ success: true, transactionId, message: 'Sucesso' });
  } catch (err) {
    return res.status(500).json({ error: 'Erro no P2P', details: err.message });
  }
});

// 🟤 PAYSUITE PAYMENT (BLINDADO CONTRA TIMEOUT DA VERCEL)
app.post("/api/paysuite-payment", async (req, res) => {
  try {
    if (typeof fetch === 'undefined') {
      return res.status(500).json({ success: false, error: "Servidor desatualizado (Requer Node 18+). Verifique a Vercel." });
    }

    let paysuiteActive = true;
    if (db) {
      try {
        const settingsDoc = await db.collection('settings').doc('global').get();
        if (settingsDoc.exists) paysuiteActive = settingsDoc.data().paysuiteActive !== false;
      } catch (e) { console.warn('Aviso DB PaySuite:', e.message); }
    }

    if (!paysuiteActive) {
      return res.status(503).json({ success: false, error: "Pagamentos em manutenção.", fallback: `https://wa.me/${WHATSAPP_NUMBER}` });
    }

    const { orderId, amount, method, description, phone, email, name } = req.body;
    if (!orderId || !amount || !method) return res.status(400).json({ success: false, error: 'Dados incompletos' });
    if (isNaN(amount) || amount < 1) return res.status(400).json({ success: false, error: 'Mínimo: 1 MT' });

    const cleanMethod = ['mpesa', 'm-pesa'].includes(method.toLowerCase()) ? 'mpesa' : 'emola';
    const cleanReference = String(orderId).replace(/[^a-zA-Z0-9\-]/g, '').substring(0, 50);

    const paysuitePayload = {
      amount: parseFloat(amount), method: cleanMethod, reference: cleanReference, description: description || `Pedido #${orderId}`, callback_url: `${SITE_URL}/api/paysuite-webhook`, return_url: `${SITE_URL}/index.html?payment=${cleanReference}`,
      customer: { name: name || '', email: email || '', phone: phone ? phone.replace(/\D/g, '') : '' }
    };

    // Timeout Seguro: Corta a execução aos 8 segundos antes que a Vercel mate o processo aos 10s (Gerando o Erro 500 HTML)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); 

    let response;
    try {
      response = await fetch('https://paysuite.tech/api/v1/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${process.env.PAYSUITE_API_KEY}`, 'User-Agent': 'PayGo-API/1.0' },
        body: JSON.stringify(paysuitePayload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const textData = await response.text();
    let result;
    try { result = JSON.parse(textData); } 
    catch (e) { return res.status(502).json({ success: false, error: "A operadora não devolveu dados válidos." }); }

    if (!response.ok || result.status === 'error') return res.status(400).json({ success: false, error: result.message || result.error || `A operadora recusou a comunicação.` });

    return res.status(200).json({ success: true, data: { paymentId: result.data?.id, checkoutUrl: result.data?.checkout_url, method: cleanMethod, reference: cleanReference } });

  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ success: false, error: "A operadora de pagamentos demorou a responder. Tente novamente." });
    
    // Tratamento de Erro Limpo (Converte erro de código em JSON legível)
    return res.status(500).json({ success: false, error: `Erro Interno: ${err.message}` });
  }
});

// ⚫ PAYSUITE WEBHOOK
app.post("/api/paysuite-webhook", async (req, res) => {
  try {
    let payload = req.body;
    if (typeof payload === 'string') try { payload = JSON.parse(payload); } catch (e) {}
    
    const agora = Timestamp.now();
    await db?.collection('webhook_logs').add({ source: 'paysuite', event: payload?.event || 'unknown', reference: payload?.data?.reference || payload?.reference, status: payload?.status, rawPayload: payload, receivedAt: agora }).catch(()=>{});

    if (!payload?.event) return res.status(200).json({ warning: 'Sem evento' });

    const isSuccess = ['payment.completed', 'payment.success', 'transaction.completed'].includes(payload.event);
    const isFailed = ['payment.failed', 'payment.cancelled', 'transaction.failed'].includes(payload.event);
    const paymentData = payload.data || payload;
    let ref = paymentData.reference || payload.reference;
    
    if (ref) {
      ref = String(ref).toUpperCase();
      if (ref.startsWith('PG') && !ref.startsWith('PG-')) ref = `PG-${ref.slice(2)}`;
      if (ref.startsWith('TOP') && !ref.startsWith('TOP-')) ref = `TOP-${ref.slice(3)}`;
    }
    if (!ref) return res.status(200).json({ warning: 'Sem Referência' });

    if (ref.startsWith('TOP-')) {
      const snap = await db?.collection('topups').where('topupId', '==', ref).limit(1).get();
      if (snap && !snap.empty) {
        const doc = snap.docs[0];
        if (isSuccess && doc.data().status !== 'completed') {
          const amount = parseFloat(doc.data().amount) || 0;
          await doc.ref.update({ status: 'completed', paidAt: agora, paysuitePaymentId: paymentData.id || payload.id, updatedAt: agora });
          if (doc.data().userId && amount > 0) await db.collection('users').doc(doc.data().userId).update({ walletBalance: FieldValue.increment(amount), updatedAt: agora });
        } else if (isFailed && doc.data().status === 'pending') {
          await doc.ref.update({ status: 'failed', failedAt: agora, failureReason: paymentData.failure_reason || 'Falha', updatedAt: agora });
        }
      }
    } else if (ref.startsWith('PG-')) {
      const snap = await db?.collection('orders').where('orderId', '==', ref).limit(1).get();
      if (snap && !snap.empty) {
        const doc = snap.docs[0];
        if (isSuccess && !doc.data().isPaid) {
          await doc.ref.update({ status: 'processing', isPaid: true, paidAt: agora, paysuitePaymentId: paymentData.id || payload.id, updatedAt: agora });
        } else if (isFailed && doc.data().status === 'pending') {
          await doc.ref.update({ status: 'payment_failed', failedAt: agora, failureReason: paymentData.failure_reason || 'Falha', updatedAt: agora });
        }
      }
    }
    return res.status(200).json({ success: true, processed: true });
  } catch (err) {
    return res.status(200).json({ success: false, error: err.message, logged: true }); // Previne retries infinitos
  }
});

// ⚪ RECOVER PASSWORD
app.post("/api/recover-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obrigatório' });

    const link = await auth.generatePasswordResetLink(email);
    const oobCode = new URL(link).searchParams.get('oobCode');
    const customResetLink = `${SITE_URL}/seguranca.html?mode=resetPassword&oobCode=${oobCode}`;

    if (resend) await resend.emails.send({ from: FROM_EMAIL, to: [email], subject: '🔐 Redefinir Senha', html: `<p><a href="${customResetLink}">Redefinir Senha</a></p>` });
    return res.status(200).json({ success: true, message: 'Instruções enviadas' });
  } catch (error) {
    if (error.code === 'auth/user-not-found') return res.status(200).json({ success: true });
    return res.status(500).json({ error: error.message });
  }
});

// 🟨 SEND EMAIL
app.post("/api/send-email", async (req, res) => {
  try {
    const { to, subject, template, variables } = req.body;
    if (!to || !template) return res.status(400).json({ error: 'Faltam campos' });
    
    const validRecipients = (Array.isArray(to) ? to : [to]).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (validRecipients.length === 0) return res.status(400).json({ error: 'Sem emails válidos' });

    const html = generateEmailHTML(template, variables || {});
    if (resend) await resend.emails.send({ from: FROM_EMAIL, to: validRecipients, subject: subject || "Notificação PayGo", html: html });
    return res.status(200).json({ success: true, sent: validRecipients.length });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// 🟧 SEND WHATSAPP INVOICE
app.post("/api/send-whatsapp-invoice", async (req, res) => {
  try {
    const { orderId, clientName, phone, pdfData, message } = req.body;
    if (!orderId || !phone || !pdfData) return res.status(400).json({ error: 'Dados incompletos' });

    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length === 9) cleanPhone = '258' + cleanPhone;
    if (!cleanPhone.startsWith('258') || cleanPhone.length !== 12) return res.status(400).json({ error: 'Número inválido' });

    const base64Pure = pdfData.match(/^application\/pdf;base64,(.+)$/) ? pdfData.match(/^application\/pdf;base64,(.+)$/)[1] : pdfData;
    const messageText = message || `Olá *${clientName || 'Cliente'}*! ✅ Compra processada!\n📄 Segue a fatura #${orderId}.`;

    if (!process.env.EVOLUTION_API_URL || !process.env.EVOLUTION_API_KEY) throw new Error('API não configurada');

    const response = await fetch(`${process.env.EVOLUTION_API_URL}/message/sendMedia/${process.env.INSTANCE_NAME}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': process.env.EVOLUTION_API_KEY },
      body: JSON.stringify({ number: cleanPhone, options: { delay: 1200, presence: 'composing' }, mediaMessage: { mediatype: 'document', fileName: `Fatura_PayGo_${orderId}.pdf`, caption: messageText, media: base64Pure } }),
      signal: AbortSignal.timeout(15000)
    });

    const result = await response.json();
    if (!response.ok || result?.error) throw new Error(result?.message || result?.error);
    return res.status(200).json({ success: true, messageId: result?.messageId });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

// 🟩 VERIFY EMAIL
app.post("/api/verify-email", async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obrigatório' });

    const link = await auth.generateEmailVerificationLink(email);
    const oobCode = new URL(link).searchParams.get('oobCode');
    if (resend) await resend.emails.send({ from: FROM_EMAIL, to: [email], subject: '⚡ Verifique seu Email - PayGo', html: `<p><a href="${SITE_URL}/seguranca.html?mode=verifyEmail&oobCode=${oobCode}">✅ Validar Conta</a></p>` });
    return res.status(200).json({ success: true });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

// 💸 PAYOUTS AUTOMATIZADOS (Admin Only) - COM BLINDAGEM TIMEOUT
app.post("/api/paysuite-payout", requireAdminAuth, async (req, res) => {
  try {
    const { withdrawalId, targetPhone, targetAmount, targetMethod, reason } = req.body;
    if (!withdrawalId || !targetPhone || !targetAmount || !targetMethod) return res.status(400).json({ success: false, error: "Dados incompletos" });

    const finalAmount = parseFloat(targetAmount);
    if (isNaN(finalAmount) || finalAmount < 100 || finalAmount > 50000) return res.status(400).json({ success: false, error: "Valor fora do limite" });

    let withdrawalData = null;
    let previousDataLog = { status: 'pending', amount: finalAmount };
    
    if (withdrawalId !== "MANUAL_PAYOUT") {
      const wDoc = await db.collection("withdrawals").doc(withdrawalId).get();
      if (!wDoc.exists) return res.status(404).json({ success: false, error: "Saque não encontrado" });
      withdrawalData = wDoc.data();
      if (withdrawalData.status !== 'pending') return res.status(400).json({ success: false, error: `Saque em status: ${withdrawalData.status}` });
      previousDataLog = { status: withdrawalData.status, amount: withdrawalData.amount };
    }

    const cleanPhone = targetPhone.replace(/\D/g, '');
    const method = targetMethod.toLowerCase() === 'emola' ? 'emola' : 'mpesa';
    const reference = withdrawalId === "MANUAL_PAYOUT" ? `MAN-${Date.now().toString().slice(-6)}` : withdrawalId;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8s Fail-safe Vercel

    let response;
    try {
      response = await fetch('https://paysuite.tech/api/v1/payouts', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${process.env.PAYSUITE_API_KEY}` },
        body: JSON.stringify({ amount: finalAmount, phone: cleanPhone, method: method, reference: reference, description: reason || `Payout PayGo - Ref: ${reference}` }),
        signal: controller.signal
      });
    } finally { clearTimeout(timeout); }

    const textData = await response.text();
    let result;
    try { result = JSON.parse(textData); } catch (e) { return res.status(502).json({ success: false, error: "Operadora indisponível." }); }

    if (!response.ok || result?.status === 'error') {
      if (withdrawalData && withdrawalId !== "MANUAL_PAYOUT") await db.collection("withdrawals").doc(withdrawalId).update({ status: 'failed', failureReason: result?.message || 'Falha operadora', updatedAt: Timestamp.now() });
      return res.status(400).json({ success: false, error: result?.message || "Recusado." });
    }

    if (withdrawalId !== "MANUAL_PAYOUT" && withdrawalData) {
      await db.collection("withdrawals").doc(withdrawalId).update({ status: 'approved', paysuitePayoutId: result.data?.id || `PROC-${Date.now()}`, amountPaid: finalAmount, phonePaid: cleanPhone, methodPaid: method, processedAt: Timestamp.now(), processedBy: req.admin.uid, updatedAt: Timestamp.now() });
    }
    await db.collection("admin_audit_logs").add({ adminId: req.admin.uid, adminName: req.admin.name, action: withdrawalId === "MANUAL_PAYOUT" ? "PAYOUT_MANUAL" : "PAYOUT_AFILIADO", targetId: reference, targetType: "payout", details: { previous: previousDataLog, updated: { status: 'approved', amountPaid: finalAmount, phone: cleanPhone, paysuiteId: result.data?.id } }, createdAt: Timestamp.now() });

    return res.status(200).json({ success: true, message: "Sucesso!", payoutId: result.data?.id });
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ success: false, error: "A operadora não respondeu a tempo." });
    return res.status(500).json({ success: false, error: `Erro: ${err.message}` });
  }
});

// 📊 GET EXCHANGE RATE
app.get("/api/exchange-rate", async (req, res) => {
  try {
    let rate = 88.00;
    if (db) {
      const settingsDoc = await db.collection('settings').doc('global').get();
      if (settingsDoc.exists && settingsDoc.data().exchangeRate) rate = parseFloat(settingsDoc.data().exchangeRate);
    }
    return res.status(200).json({ success: true, rate: rate });
  } catch (err) { return res.status(200).json({ success: true, rate: 88.00 }); }
});

// 📦 TRACK ORDER
app.post("/api/track-order", async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId obrigatório' });
    const snap = await db?.collection('orders').where('orderId', '==', orderId.toUpperCase()).limit(1).get();
    if (!snap || snap.empty) return res.status(404).json({ error: 'Pedido não encontrado' });
    const order = snap.docs[0].data();
    return res.status(200).json({ success: true, order: { orderId: order.orderId, status: order.status, isPaid: order.isPaid, total: order.total, createdAt: order.createdAt?.toDate ? order.createdAt.toDate().toISOString() : order.createdAt } });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ==========================================
// 5. FUNÇÕES AUXILIARES DE HTML
// ==========================================
function getWhatsAppLink(orderId, name, total, method) {
  const isBankTransfer = String(method||'').toLowerCase().includes('transferencia') || String(method||'').toLowerCase().includes('bank');
  const action = isBankTransfer ? 'enviar o comprovativo' : 'finalizar pedido';
  const msg = `*OLÁ PAYGO!* 👋\n\nGostaria de ${action}.\n\n📋 *Dados do Pedido:*\n• ID: #${orderId}\n• Cliente: ${name}\n• Valor: ${total?.toFixed(2) || 'N/A'} MT\n• Método: ${method || 'N/A'}\n\n_Aguardo instruções._`;
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;
}
function generateOrderConfirmationHTML(order) { return `<h2>🛒 Pedido #${order.orderId}</h2><p>Total: ${order.total} MT</p><a href="${getWhatsAppLink(order.orderId, order.name, order.total, order.paymentMethod)}">Finalizar no WhatsApp</a>`; }
function generatePaymentSuccessHTML(order) { return `<h2>✅ Pagamento #${order.orderId}</h2><p>Confirmado: ${order.total} MT</p>`; }
function generateRefundHTML(order, reason) { return `<h2>🟣 Reembolso #${order.orderId}</h2><p>Motivo: ${reason || 'N/A'}</p>`; }
function generateInsufficientFundsHTML(order, extra, reason) { return `<h2>⚠️ Faltam ${extra} MT</h2><p>Motivo: ${reason}</p>`; }
function generateOrderCompletedHTML(order) { return `<h2>🎉 Pedido Concluído! #${order.orderId}</h2>`; }
function generateEmailHTML(template, vars) {
  const templates = { 'order-completed': generateOrderCompletedHTML, 'payment-confirmed': generatePaymentSuccessHTML };
  return templates[template] ? templates[template](vars) : `<h2>PayGo</h2><p>${vars.message || ''}</p>`;
}

// ==========================================
// 6. INICIALIZAÇÃO DO SERVIDOR 
// ==========================================
// Proteção: A Vercel cuida do port binding dinamicamente. Executar app.listen força alocação estática e dá 500.
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`🚀 API Local na porta ${PORT}`));
}

module.exports = app;
