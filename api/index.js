// ==========================================
// 🚀 PAYGO MASTER API - ROTEADOR UNIFICADO
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

// Configuração Avançada de CORS (Resolve Erro 405)
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'https://paygo.co.mz', 'https://paygo-14311.web.app'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Intercetador explícito de Preflight para todas as rotas

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Headers de Segurança Profissionais
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// Logger de Requisições (Auditoria Interna)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Variáveis Globais PayGo
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || "258871002255";
const FROM_EMAIL = `PayGo Moçambique <${process.env.FROM_EMAIL || 'noreply@paygo.co.mz'}>`;
const SITE_URL = process.env.SITE_URL || 'https://paygo.co.mz';

// Inicialização Resend
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
if (!resend) console.warn("⚠️ RESEND_API_KEY não configurada. Emails não serão enviados.");

// ==========================================
// 2. INICIALIZAÇÃO FIREBASE ADMIN
// ==========================================
let db = null;
let auth = null;

try {
  if (!getApps().length) {
    const envVar = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!envVar) throw new Error("FIREBASE_SERVICE_ACCOUNT não definida nas variáveis de ambiente");

    let serviceAccount;
    try {
      serviceAccount = JSON.parse(envVar);
      if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
        throw new Error("Service Account incompleta - faltam campos obrigatórios");
      }
      initializeApp({ 
        credential: cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
      });
      console.log("✅ Firebase Admin inicializado com sucesso");
    } catch (parseError) {
      console.error("❌ Erro ao processar FIREBASE_SERVICE_ACCOUNT:", parseError.message);
      throw parseError;
    }
  }

  const adminApp = getApps()[0];
  db = getFirestore(adminApp, "paygodb"); // Ligação forçada à DB correta
  auth = getAuth(adminApp);
  
} catch (firebaseError) {
  console.error("❌ Falha crítica na inicialização do Firebase:", firebaseError.message);
}

// ==========================================
// 3. MIDDLEWARE DE AUTENTICAÇÃO ADMIN
// ==========================================
const requireAdminAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token de autenticação não fornecido' });
    
    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await auth.verifyIdToken(token);
    
    const userDoc = await db.collection('users').doc(decodedToken.uid).get();
    if (!userDoc.exists) return res.status(403).json({ error: 'Usuário não encontrado na base de dados' });
    
    const userData = userDoc.data();
    if (userData.role !== 'admin' && userData.role !== 'superadmin') {
      return res.status(403).json({ error: 'Acesso restrito a administradores' });
    }
    
    req.admin = { uid: decodedToken.uid, email: decodedToken.email, name: userData.name, role: userData.role };
    next();
  } catch (error) {
    console.error('Erro na autenticação admin:', error);
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
};

// ==========================================
// 4. ROTAS DA API
// ==========================================

// 🔵 Health Check
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "PayGo Master API Online 🚀", timestamp: new Date().toISOString(), environment: process.env.NODE_ENV || 'development', version: '1.1.0' });
});

// 🔴 DELETE USER (Admin Only)
app.post("/api/delete-user", requireAdminAuth, async (req, res, next) => {
  try {
    const { uid, reason } = req.body;
    if (!uid) return res.status(400).json({ error: 'UID do usuário é obrigatório' });
    
    await db.collection('admin_audit_logs').add({
      adminId: req.admin.uid, adminName: req.admin.name, action: 'DELETE_USER', targetId: uid, targetType: 'user', details: { reason: reason || 'Não especificado' }, ip: req.ip, createdAt: Timestamp.now()
    });
    
    try { await auth.deleteUser(uid); } catch (authError) { console.warn(`⚠️ Usuário ${uid} não encontrado no Auth`); }
    await db.collection('users').doc(uid).delete();
    
    const batch = db.batch();
    const collections = ['orders', 'wallet_transactions', 'withdrawals', 'support_tickets'];
    for (const collection of collections) {
      const snapshot = await db.collection(collection).where('userId', '==', uid).limit(100).get();
      snapshot.forEach(doc => batch.delete(doc.ref));
    }
    if (batch._operations && batch._operations.length > 0) await batch.commit();
    
    return res.status(200).json({ success: true, message: 'Usuário e dados relacionados apagados com sucesso' });
  } catch (error) { next(error); }
});

// 🟢 GET REFERRALS (Admin Only)
app.post("/api/get-referrals", requireAdminAuth, async (req, res, next) => {
  try {
    const { affiliateCode, limit = 100 } = req.body;
    if (!affiliateCode) return res.status(400).json({ error: 'Código de afiliado é obrigatório' });
    
    const qUsers = await db.collection("users").where("referredBy", "==", affiliateCode).orderBy("createdAt", "desc").limit(limit).get();
    const referrals = [];
    
    qUsers.forEach(doc => {
      const data = doc.data();
      let dateStr = null;
      if (data.createdAt) {
        if (data.createdAt instanceof Timestamp) dateStr = data.createdAt.toDate().toISOString();
        else if (typeof data.createdAt?.toDate === 'function') dateStr = data.createdAt.toDate().toISOString();
        else dateStr = new Date(data.createdAt).toISOString();
      }
      referrals.push({
        id: doc.id, name: data.name || 'Cliente PayGo', email: data.email || '', phone: data.phone || '', status: data.status || 'pending', emailVerified: data.emailVerified || false, firstPurchaseProcessed: data.firstPurchaseProcessed || false, totalPurchases: data.totalPurchases || 0, walletBalance: data.walletBalance || 0, createdAt: dateStr, lastLogin: data.lastLogin || null
      });
    });
    
    return res.status(200).json({ success: true, count: referrals.length, referrals });
  } catch (err) { next(err); }
});

// 🔵 LOG ACTION (Auditoria - Admin Only)
app.post("/api/log-action", requireAdminAuth, async (req, res, next) => {
  try {
    const { action, targetId, targetType, previousData, newData, reason } = req.body;
    if (!action || !targetId) return res.status(400).json({ error: 'action e targetId são obrigatórios' });
    
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

    const logRef = await db.collection('admin_audit_logs').add({
      adminId: req.admin.uid, adminName: req.admin.name || 'Admin', adminRole: req.admin.role, action: String(action), targetId: String(targetId), targetType: targetType ? String(targetType) : 'unknown', reason: reason || null,
      details: { previous: sanitizeData(previousData), updated: sanitizeData(newData) },
      metadata: { ip: req.headers['x-forwarded-for']?.split(',')[0] || req.ip, userAgent: req.headers['user-agent'] || 'unknown', timestamp: new Date().toISOString() },
      createdAt: Timestamp.now()
    });
    
    return res.status(200).json({ success: true, logId: logRef.id, message: 'Ação registrada com sucesso' });
  } catch (err) { next(err); }
});

// 🟣 NOTIFY ORDER (Emails e Notificações)
app.post("/api/notify-order", async (req, res, next) => {
  try {
    const body = req.body;
    if (body.type && body.data) return res.status(200).json({ success: true, message: "Webhook recebido. Use /api/paysuite-webhook." });

    const { orderData, sendEmail = true, sendLark = true, action = 'new_order', reason, extraAmount, mediaUrl } = body;
    if (!orderData) return res.status(400).json({ error: 'Dados do pedido são obrigatórios' });

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
          body: JSON.stringify({
            msg_type: "post", content: { post: { "pt-MZ": { title: `🔔 ${action === 'new_order' ? 'Novo Pedido' : 'Atualização'}: ${orderId}`, content: [[ { tag: "text", text: `Cliente: ${orderData.name}\n` }, { tag: "text", text: `Valor: ${orderData.total?.toFixed(2) || 'N/A'} MT\n` }, { tag: "a", text: "Ver no Painel", href: `${SITE_URL}/admin/pedidos.html?id=${orderId}` } ]] } } }
          })
        });
        results.lark = { success: true };
      } catch (larkError) { results.lark = { success: false, error: larkError.message }; }
    }
    return res.status(200).json({ success: true, results, message: 'Notificações processadas' });
  } catch (err) { next(err); }
});

// 🟠 P2P TRANSFER (Entre usuários)
app.post("/api/p2p-transfer", requireAdminAuth, async (req, res, next) => {
  try {
    const { senderId, receiverEmail, amount, description } = req.body;
    const transferAmount = parseFloat(amount);

    if (!senderId || !receiverEmail) return res.status(400).json({ error: 'senderId e receiverEmail são obrigatórios' });
    if (isNaN(transferAmount) || transferAmount <= 0) return res.status(400).json({ error: 'Valor deve ser um número positivo' });
    if (transferAmount > 50000) return res.status(400).json({ error: 'Valor excede o limite permitido (50.000 MT)' });

    const usersRef = db.collection('users');
    const receiverSnap = await usersRef.where('email', '==', receiverEmail.trim().toLowerCase()).limit(1).get();
    if (receiverSnap.empty) return res.status(404).json({ error: 'Nenhum usuário encontrado com este e-mail' });

    const receiverDoc = receiverSnap.docs[0];
    if (senderId === receiverDoc.id) return res.status(400).json({ error: 'Não é possível enviar dinheiro para si mesmo' });

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
    
    batch.set(db.collection('wallet_transactions').doc(), { userId: senderId, type: 'debit', amount: transferAmount, description: description || `Transferência P2P para ${receiverEmail}`, reference: transactionId, relatedUserId: receiverDoc.id, createdAt: agora, metadata: { type: 'p2p', direction: 'sent' } });
    batch.set(db.collection('wallet_transactions').doc(), { userId: receiverDoc.id, type: 'credit', amount: transferAmount, description: description || `Recebido de ${senderDoc.data().email}`, reference: transactionId, relatedUserId: senderId, createdAt: agora, metadata: { type: 'p2p', direction: 'received' } });

    await batch.commit();
    await db.collection('admin_audit_logs').add({ adminId: req.admin.uid, adminName: req.admin.name, action: 'P2P_TRANSFER', targetId: transactionId, targetType: 'transaction', details: { from: senderId, to: receiverDoc.id, amount: transferAmount, description: description }, createdAt: agora });

    return res.status(200).json({ success: true, transactionId, message: 'Transferência realizada com sucesso' });
  } catch (err) { next(err); }
});

// 🟤 PAYSUITE PAYMENT (Criar checkout Seguro contra 405 e 500)
app.post("/api/paysuite-payment", async (req, res, next) => {
  try {
    let paysuiteActive = true;
    if (db) {
      try {
        const settingsDoc = await db.collection('settings').doc('global').get();
        if (settingsDoc.exists) paysuiteActive = settingsDoc.data().paysuiteActive !== false;
      } catch (e) { console.warn('⚠️ Erro status PaySuite:', e.message); }
    }

    if (!paysuiteActive) {
      return res.status(503).json({ success: false, error: "⚠️ Pagamentos automáticos em manutenção.", fallback: `https://wa.me/${WHATSAPP_NUMBER}` });
    }

    const { orderId, amount, method, description, phone, email, name } = req.body;
    if (!orderId || !amount || !method) return res.status(400).json({ success: false, error: 'orderId, amount e method são obrigatórios' });
    if (isNaN(amount) || amount < 1) return res.status(400).json({ success: false, error: 'Valor mínimo: 1 MT' });

    const cleanMethod = ['mpesa', 'm-pesa'].includes(method.toLowerCase()) ? 'mpesa' : 'emola';
    const cleanReference = String(orderId).replace(/[^a-zA-Z0-9\-]/g, '').substring(0, 50);

    const paysuitePayload = {
      amount: parseFloat(amount), method: cleanMethod, reference: cleanReference, description: description || `Pedido PayGo #${orderId}`, callback_url: `${SITE_URL}/api/paysuite-webhook`, return_url: `${SITE_URL}/index.html?payment=${cleanReference}`,
      customer: { name: name || '', email: email || '', phone: phone ? phone.replace(/\D/g, '') : '' }
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000); // Fail-safe de 25s para Vercel não estourar os 30s

    let response;
    try {
      response = await fetch('https://paysuite.tech/api/v1/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${process.env.PAYSUITE_API_KEY}`, 'User-Agent': 'PayGo-API/1.1' },
        body: JSON.stringify(paysuitePayload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const textData = await response.text();
    let result;
    try {
      result = JSON.parse(textData);
    } catch (parseError) {
      return res.status(502).json({ success: false, error: "A operadora (PaySuite) não está a responder corretamente. Tente Transferência Bancária." });
    }

    if (!response.ok || result.status === 'error') {
      return res.status(400).json({ success: false, error: result.message || result.error || `A operadora recusou a transação.` });
    }

    return res.status(200).json({
      success: true,
      data: { paymentId: result.data?.id, checkoutUrl: result.data?.checkout_url, method: cleanMethod, reference: cleanReference },
      message: 'Checkout criado com sucesso'
    });

  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ success: false, error: "A operadora demorou demasiado tempo a responder." });
    next(err);
  }
});

// ⚫ PAYSUITE WEBHOOK (Processar pagamentos recebidos)
app.post("/api/paysuite-webhook", async (req, res, next) => {
  try {
    let payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) {} }
    
    const agora = Timestamp.now();
    await db?.collection('webhook_logs').add({ source: 'paysuite', event: payload?.event || 'unknown', reference: payload?.data?.reference || payload?.reference, status: payload?.status, rawPayload: payload, receivedAt: agora }).catch(()=>{});

    if (!payload?.event) return res.status(200).json({ warning: 'Evento não especificado' });

    const isSuccess = ['payment.completed', 'payment.success', 'transaction.completed'].includes(payload.event);
    const isFailed = ['payment.failed', 'payment.cancelled', 'transaction.failed'].includes(payload.event);
    const paymentData = payload.data || payload;
    let ref = paymentData.reference || payload.reference;
    
    if (ref) {
      ref = String(ref).toUpperCase();
      if (ref.startsWith('PG') && !ref.startsWith('PG-')) ref = `PG-${ref.slice(2)}`;
      if (ref.startsWith('TOP') && !ref.startsWith('TOP-')) ref = `TOP-${ref.slice(3)}`;
    }
    if (!ref) return res.status(200).json({ warning: 'Referência não encontrada' });

    if (ref.startsWith('TOP-')) {
      const snap = await db?.collection('topups').where('topupId', '==', ref).limit(1).get();
      if (!snap || snap.empty) return res.status(200).json({ warning: `Top-up ${ref} não encontrado` });
      
      const doc = snap.docs[0];
      if (isSuccess && doc.data().status !== 'completed') {
        const amount = parseFloat(doc.data().amount) || 0;
        await doc.ref.update({ status: 'completed', paidAt: agora, paysuitePaymentId: paymentData.id || payload.id, updatedAt: agora });
        if (doc.data().userId && amount > 0) await db.collection('users').doc(doc.data().userId).update({ walletBalance: FieldValue.increment(amount), updatedAt: agora });
      } else if (isFailed && doc.data().status === 'pending') {
        await doc.ref.update({ status: 'failed', failedAt: agora, failureReason: paymentData.failure_reason || 'Falha', updatedAt: agora });
      }
    } 
    else if (ref.startsWith('PG-')) {
      const snap = await db?.collection('orders').where('orderId', '==', ref).limit(1).get();
      if (!snap || snap.empty) return res.status(200).json({ warning: `Pedido ${ref} não encontrado` });
      
      const doc = snap.docs[0];
      if (isSuccess && !doc.data().isPaid) {
        await doc.ref.update({ status: 'processing', isPaid: true, paidAt: agora, paysuitePaymentId: paymentData.id || payload.id, updatedAt: agora });
      } else if (isFailed && doc.data().status === 'pending') {
        await doc.ref.update({ status: 'payment_failed', failedAt: agora, failureReason: paymentData.failure_reason || 'Falha', updatedAt: agora });
      }
    }

    return res.status(200).json({ success: true, processed: true });
  } catch (err) {
    console.error("Erro webhook:", err);
    return res.status(200).json({ success: false, error: "Erro interno", logged: true }); // 200 evita retries desnecessários
  }
});

// ⚪ RECOVER PASSWORD
app.post("/api/recover-password", async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email válido é obrigatório' });

    const link = await auth.generatePasswordResetLink(email);
    const oobCode = new URL(link).searchParams.get('oobCode');
    const customResetLink = `${SITE_URL}/seguranca.html?mode=resetPassword&oobCode=${oobCode}`;

    const html = `<h2>🔐 Recuperação de Senha</h2><p><a href="${customResetLink}">Redefinir Senha</a></p><p>Este link expira em 1 hora.</p>`;
    if (resend) await resend.emails.send({ from: FROM_EMAIL, to: [email], subject: '🔐 Redefinir Senha - PayGo', html: html });

    return res.status(200).json({ success: true, message: 'Instruções enviadas para o email.' });
  } catch (error) {
    if (error.code === 'auth/user-not-found') return res.status(200).json({ success: true });
    next(error);
  }
});

// 🟨 SEND EMAIL (Genérico)
app.post("/api/send-email", async (req, res, next) => {
  try {
    const { to, subject, template, variables, sendLark = false } = req.body;
    if (!to || !template) return res.status(400).json({ error: 'Campos obrigatórios: to, template' });
    
    const validRecipients = (Array.isArray(to) ? to : [to]).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (validRecipients.length === 0) return res.status(400).json({ error: 'Nenhum email válido' });

    const html = generateEmailHTML(template, variables || {});
    if (resend) await resend.emails.send({ from: FROM_EMAIL, to: validRecipients, subject: subject || "Notificação PayGo", html: html });
    
    if (sendLark && process.env.LARK_WEBHOOK_URL) {
      fetch(process.env.LARK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg_type: "text", content: { text: `📧 Email Enviado: ${template} para ${validRecipients.join(', ')}` } }) }).catch(()=>{});
    }
    
    return res.status(200).json({ success: true, sent: validRecipients.length });
  } catch (err) { next(err); }
});

// 🟧 SEND WHATSAPP INVOICE
app.post("/api/send-whatsapp-invoice", async (req, res, next) => {
  try {
    const { orderId, clientName, phone, pdfData, message } = req.body;
    if (!orderId || !phone || !pdfData) return res.status(400).json({ error: 'Dados incompletos' });

    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length === 9) cleanPhone = '258' + cleanPhone;
    if (!cleanPhone.startsWith('258') || cleanPhone.length !== 12) return res.status(400).json({ error: 'Número inválido' });

    const base64Pure = pdfData.match(/^application\/pdf;base64,(.+)$/) ? pdfData.match(/^application\/pdf;base64,(.+)$/)[1] : pdfData;
    const messageText = message || `Olá *${clientName || 'Cliente'}*! 👋\n\n✅ Sua compra foi processada!\n📄 Segue a fatura do pedido *#${orderId}*.`;

    if (!process.env.EVOLUTION_API_URL || !process.env.EVOLUTION_API_KEY) throw new Error('Evolution API não configurada');

    const response = await fetch(`${process.env.EVOLUTION_API_URL}/message/sendMedia/${process.env.INSTANCE_NAME}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': process.env.EVOLUTION_API_KEY },
      body: JSON.stringify({ number: cleanPhone, options: { delay: 1200, presence: 'composing' }, mediaMessage: { mediatype: 'document', fileName: `Fatura_${orderId}.pdf`, caption: messageText, media: base64Pure } }),
      signal: AbortSignal.timeout(30000)
    });

    const result = await response.json();
    if (!response.ok || result?.error) throw new Error(result?.message || result?.error);

    return res.status(200).json({ success: true, messageId: result?.messageId });
  } catch (error) { next(error); }
});

// 🟩 VERIFY EMAIL
app.post("/api/verify-email", async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obrigatório' });

    const link = await auth.generateEmailVerificationLink(email);
    const oobCode = new URL(link).searchParams.get('oobCode');
    const customVerifyLink = `${SITE_URL}/seguranca.html?mode=verifyEmail&oobCode=${oobCode}`;

    if (resend) await resend.emails.send({ from: FROM_EMAIL, to: [email], subject: '⚡ Verifique seu Email - PayGo', html: `<h2>🛡️ Verifique seu Email</h2><p><a href="${customVerifyLink}">✅ Validar Conta</a></p>` });

    return res.status(200).json({ success: true });
  } catch (error) { next(error); }
});

// 💸 PAYOUTS AUTOMATIZADOS (Admin Only)
app.post("/api/paysuite-payout", requireAdminAuth, async (req, res, next) => {
  try {
    const { withdrawalId, targetPhone, targetAmount, targetMethod, reason } = req.body;
    if (!withdrawalId || !targetPhone || !targetAmount || !targetMethod) return res.status(400).json({ success: false, error: "Dados incompletos" });

    const finalAmount = parseFloat(targetAmount);
    if (isNaN(finalAmount) || finalAmount < 100 || finalAmount > 50000) return res.status(400).json({ success: false, error: "Valor deve estar entre 100 MT e 50.000 MT" });

    let withdrawalData = null;
    let previousDataLog = { status: 'pending', amount: finalAmount };
    
    if (withdrawalId !== "MANUAL_PAYOUT") {
      const wDoc = await db.collection("withdrawals").doc(withdrawalId).get();
      if (!wDoc.exists) return res.status(404).json({ success: false, error: "Saque não encontrado" });
      withdrawalData = wDoc.data();
      if (withdrawalData.status !== 'pending') return res.status(400).json({ success: false, error: `Status atual: ${withdrawalData.status}` });
      previousDataLog = { status: withdrawalData.status, amount: withdrawalData.amount };
    }

    const cleanPhone = targetPhone.replace(/\D/g, '');
    const method = targetMethod.toLowerCase() === 'emola' ? 'emola' : 'mpesa';
    const reference = withdrawalId === "MANUAL_PAYOUT" ? `MAN-${Date.now().toString().slice(-6)}` : withdrawalId;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 40000);

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
    try { result = JSON.parse(textData); } catch (e) { return res.status(502).json({ success: false, error: "Gateway indisponível." }); }

    if (!response.ok || result?.status === 'error') {
      if (withdrawalData && withdrawalId !== "MANUAL_PAYOUT") {
        await db.collection("withdrawals").doc(withdrawalId).update({ status: 'failed', failureReason: result?.message || 'Falha', updatedAt: Timestamp.now() });
      }
      return res.status(400).json({ success: false, error: result?.message || "Recusado." });
    }

    if (withdrawalId !== "MANUAL_PAYOUT" && withdrawalData) {
      await db.collection("withdrawals").doc(withdrawalId).update({ status: 'approved', paysuitePayoutId: result.data?.id, amountPaid: finalAmount, phonePaid: cleanPhone, methodPaid: method, processedAt: Timestamp.now(), processedBy: req.admin.uid, updatedAt: Timestamp.now() });
    }

    await db.collection("admin_audit_logs").add({ adminId: req.admin.uid, adminName: req.admin.name, action: withdrawalId === "MANUAL_PAYOUT" ? "PAYOUT_MANUAL" : "PAYOUT_AFILIADO", targetId: reference, targetType: "payout", details: { previous: previousDataLog, updated: { status: 'approved', amountPaid: finalAmount, phone: cleanPhone, paysuiteId: result.data?.id, method: method } }, createdAt: Timestamp.now() });

    return res.status(200).json({ success: true, message: "Executado!", payoutId: result.data?.id });
  } catch (err) { 
    if (err.name === 'AbortError') return res.status(504).json({ success: false, error: "Timeout" });
    next(err); 
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
    return res.status(200).json({ success: true, rate: rate, timestamp: new Date().toISOString() });
  } catch (err) { return res.status(200).json({ success: true, rate: 88.00, timestamp: new Date().toISOString() }); }
});

// 📦 TRACK ORDER
app.post("/api/track-order", async (req, res, next) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId obrigatório' });
    
    const snap = await db?.collection('orders').where('orderId', '==', orderId.toUpperCase()).limit(1).get();
    if (!snap || snap.empty) return res.status(404).json({ error: 'Não encontrado' });
    
    const order = snap.docs[0].data();
    return res.status(200).json({ success: true, order: { orderId: order.orderId, status: order.status, isPaid: order.isPaid, total: order.total, createdAt: order.createdAt?.toDate ? order.createdAt.toDate().toISOString() : order.createdAt, trackingCode: order.trackingCode || null } });
  } catch (err) { next(err); }
});

// ==========================================
// 5. FUNÇÕES AUXILIARES DE HTML E TRATAMENTO DE ERROS
// ==========================================
function getWhatsAppLink(orderId, name, total, method) {
  const isBankTransfer = String(method||'').toLowerCase().includes('transferencia') || String(method||'').toLowerCase().includes('bank');
  const action = isBankTransfer ? 'enviar o comprovativo' : 'finalizar pedido';
  const msg = `*OLÁ PAYGO!* 👋\n\nGostaria de ${action}.\n\n📋 *Dados do Pedido:*\n• ID: #${orderId}\n• Cliente: ${name}\n• Valor: ${total?.toFixed(2) || 'N/A'} MT\n• Método: ${method || 'N/A'}\n\n_Aguardo instruções da equipa._`;
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;
}

function generateOrderConfirmationHTML(order) { return `<h2>🛒 Pedido Registado! #${order.orderId}</h2><p>Total: ${order.total} MT</p><a href="${getWhatsAppLink(order.orderId, order.name, order.total, order.paymentMethod)}">Finalizar no WhatsApp</a>`; }
function generatePaymentSuccessHTML(order) { return `<h2>✅ Pagamento Confirmado! #${order.orderId}</h2><p>Valor: ${order.total} MT</p>`; }
function generateRefundHTML(order, reason) { return `<h2>🟣 Reembolso Processado #${order.orderId}</h2><p>Motivo: ${reason || 'N/A'}</p>`; }
function generateInsufficientFundsHTML(order, extra, reason) { return `<h2>⚠️ Ação Necessária #${order.orderId}</h2><p>Falta: ${extra} MT. Motivo: ${reason}</p>`; }
function generateOrderCompletedHTML(order) { return `<h2>🎉 Pedido Concluído! #${order.orderId}</h2>`; }

function generateEmailHTML(template, vars) {
  const templates = { 'order-completed': generateOrderCompletedHTML, 'payment-confirmed': generatePaymentSuccessHTML };
  return templates[template] ? templates[template](vars) : `<h2>Notificação PayGo</h2><p>${vars.message || ''}</p>`;
}

// Middleware Global de Tratamento de Erros (Fall-back para evitar crash do servidor)
app.use((err, req, res, next) => {
  console.error("🔥 Erro Global Capturado:", err);
  res.status(500).json({ success: false, error: "Erro interno no servidor.", details: process.env.NODE_ENV === 'development' ? err.message : undefined });
});

// Captura rotas inexistentes (Resolve hangs de requisição)
app.use('*', (req, res) => { res.status(404).json({ error: "Endpoint não encontrado." }); });

// ==========================================
// 6. INICIALIZAÇÃO DO SERVIDOR
// ==========================================
app.listen(PORT, () => {
  console.log(`🚀 PayGo API rodando na porta ${PORT} | Env: ${process.env.NODE_ENV || 'development'}`);
});

process.on('SIGTERM', () => { console.log('🔄 Encerrando...'); process.exit(0); });
process.on('SIGINT', () => { console.log('🔄 Encerrando...'); process.exit(0); });

module.exports = app;
