// ==========================================
// 🚀 PAYGO MASTER API - ROTEADOR BLINDADO
// ==========================================
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

// 🛡️ CARREGAMENTO SEGURO DO RESEND (Evita Crash 500 se o pacote não existir)
let resend = null;
try {
  const { Resend } = require("resend");
  if (process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
} catch (e) {
  console.warn("⚠️ Pacote 'resend' não instalado ou chave ausente. Emails desativados.");
}

// ==========================================
// 1. CONFIGURAÇÕES GLOBAIS
// ==========================================
const app = express();
const PORT = process.env.PORT || 3000;

// Configuração Avançada de CORS
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'https://paygo.co.mz', 'https://www.paygo.co.mz', 'https://paygo-14311.web.app'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Intercetador obrigatório para Vercel
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Headers de Segurança
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || "258871002255";
const FROM_EMAIL = `PayGo Moçambique <${process.env.FROM_EMAIL || 'noreply@paygo.co.mz'}>`;
const SITE_URL = process.env.SITE_URL || 'https://paygo.co.mz';

// ==========================================
// 2. INICIALIZAÇÃO FIREBASE ADMIN
// ==========================================
let db = null;
let auth = null;

try {
  if (!getApps().length) {
    const envVar = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (envVar) {
      let serviceAccount = JSON.parse(envVar);
      if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      }
      initializeApp({ 
        credential: cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
      });
      console.log("✅ Firebase Admin inicializado com sucesso");
    }
  }

  const adminApp = getApps()[0];
  try {
    db = getFirestore(adminApp, "paygodb"); // Força a base de dados paygodb
  } catch(e) {
    db = getFirestore(adminApp); // Fallback
  }
  auth = getAuth(adminApp);
} catch (firebaseError) {
  console.error("❌ Falha na inicialização do Firebase:", firebaseError.message);
}

// ==========================================
// 3. MIDDLEWARE DE AUTENTICAÇÃO ADMIN
// ==========================================
const requireAdminAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token não fornecido' });
    
    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await auth.verifyIdToken(token);
    
    const userDoc = await db.collection('users').doc(decodedToken.uid).get();
    if (!userDoc.exists) return res.status(403).json({ error: 'Usuário não encontrado' });
    
    const userData = userDoc.data();
    if (userData.role !== 'admin' && userData.role !== 'superadmin') {
      return res.status(403).json({ error: 'Acesso restrito a administradores' });
    }
    
    req.admin = { uid: decodedToken.uid, email: decodedToken.email, name: userData.name, role: userData.role };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido' });
  }
};

// ==========================================
// 4. ROTAS DA API
// ==========================================

// 🔵 Health Check
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "PayGo Master API Online 🚀", version: '1.2.0 (Blindada)' });
});

// 🟤 PAYSUITE PAYMENT (Criar checkout B2B) - BLINDADO CONTRA ERRO 500
app.post("/api/paysuite-payment", async (req, res) => {
  try {
    // 1. Verificação de versão do Node (Evita Crash 500 por falta do Fetch)
    if (typeof fetch === 'undefined') {
      return res.status(400).json({ success: false, error: "A versão Node.js na Vercel está desatualizada. Altere para 18.x nas definições." });
    }

    // 2. Verificação de Chaves (Evita Crash 500 por Undefined)
    if (!process.env.PAYSUITE_API_KEY) {
      return res.status(400).json({ success: false, error: "Chave PAYSUITE_API_KEY não configurada na Vercel." });
    }

    // Verificar se PaySuite está ativa no Firestore
    let paysuiteActive = true;
    if (db) {
      try {
        const settingsDoc = await db.collection('settings').doc('global').get();
        if (settingsDoc.exists) paysuiteActive = settingsDoc.data().paysuiteActive !== false;
      } catch (e) {}
    }

    if (!paysuiteActive) {
      return res.status(400).json({ success: false, error: "Os pagamentos automáticos estão temporariamente em manutenção." });
    }

    const { orderId, amount, method, description, phone, email, name } = req.body;
    
    if (!orderId || !amount || !method) return res.status(400).json({ success: false, error: 'Dados da requisição incompletos.' });
    if (isNaN(amount) || amount < 1) return res.status(400).json({ success: false, error: 'Valor mínimo: 1 MT' });

    const cleanMethod = ['mpesa', 'm-pesa'].includes(method.toLowerCase()) ? 'mpesa' : 'emola';
    const cleanReference = String(orderId).replace(/[^a-zA-Z0-9\-]/g, '').substring(0, 50);

    const paysuitePayload = {
      amount: parseFloat(amount),
      method: cleanMethod,
      reference: cleanReference,
      description: description || `Pedido PayGo #${orderId}`,
      callback_url: `${SITE_URL}/api/paysuite-webhook`,
      return_url: `${SITE_URL}/index.html?payment=${cleanReference}`,
      customer: {
        name: name || 'Cliente',
        email: email || 'cliente@paygo.co.mz',
        phone: phone ? phone.replace(/\D/g, '') : '258840000000'
      }
    };

    // Chamada à PaySuite (Sem AbortController para garantir compatibilidade)
    const response = await fetch('https://paysuite.tech/api/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${process.env.PAYSUITE_API_KEY}`
      },
      body: JSON.stringify(paysuitePayload)
    });

    const textData = await response.text();
    let result;
    
    try {
      result = JSON.parse(textData);
    } catch (parseError) {
      console.error("PaySuite Devolveu HTML Inválido:", textData);
      return res.status(400).json({ success: false, error: "Gateway de pagamentos indisponível. A Operadora está offline." });
    }

    if (!response.ok || result.status === 'error') {
      return res.status(400).json({ success: false, error: result.message || result.error || "Operação recusada pela operadora." });
    }

    return res.status(200).json({
      success: true,
      data: { paymentId: result.data?.id, checkoutUrl: result.data?.checkout_url, method: cleanMethod },
      message: 'Checkout criado'
    });

  } catch (err) {
    // Transforma erros do Vercel num Erro 400 legível para o Toast do Frontend
    console.error("CRASH NO PAGAMENTO:", err);
    return res.status(400).json({ success: false, error: `Falha no Servidor: ${err.message}` });
  }
});

// ⚫ PAYSUITE WEBHOOK
app.post("/api/paysuite-webhook", async (req, res) => {
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
      if (!snap || snap.empty) return res.status(200).json({ warning: `Top-up não encontrado` });
      
      const doc = snap.docs[0];
      const currentStatus = doc.data().status;
      
      if (isSuccess && currentStatus !== 'completed') {
        const amount = parseFloat(doc.data().amount) || 0;
        await doc.ref.update({ status: 'completed', paidAt: agora, paysuitePaymentId: paymentData.id || payload.id, updatedAt: agora });
        if (doc.data().userId && amount > 0) {
          await db.collection('users').doc(doc.data().userId).update({ walletBalance: FieldValue.increment(amount), updatedAt: agora });
        }
      } else if (isFailed && currentStatus === 'pending') {
        await doc.ref.update({ status: 'failed', failedAt: agora, failureReason: paymentData.failure_reason || 'Falha no processamento', updatedAt: agora });
      }
    } 
    else if (ref.startsWith('PG-')) {
      const snap = await db?.collection('orders').where('orderId', '==', ref).limit(1).get();
      if (!snap || snap.empty) return res.status(200).json({ warning: `Pedido não encontrado` });
      
      const doc = snap.docs[0];
      if (isSuccess && !doc.data().isPaid) {
        await doc.ref.update({ status: 'processing', isPaid: true, paidAt: agora, paysuitePaymentId: paymentData.id || payload.id, updatedAt: agora });
      } else if (isFailed && doc.data().status === 'pending') {
        await doc.ref.update({ status: 'payment_failed', failedAt: agora, failureReason: paymentData.failure_reason || 'Pagamento não confirmado', updatedAt: agora });
      }
    }
    return res.status(200).json({ success: true, processed: true });
  } catch (err) {
    return res.status(200).json({ success: false, error: err.message, logged: true });
  }
});

// ⚪ RECOVER PASSWORD
app.post("/api/recover-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email válido é obrigatório' });

    const link = await auth.generatePasswordResetLink(email);
    const oobCode = new URL(link).searchParams.get('oobCode');
    const customResetLink = `${SITE_URL}/seguranca.html?mode=resetPassword&oobCode=${oobCode}`;

    if (resend) {
      await resend.emails.send({
        from: FROM_EMAIL, to: [email], subject: '🔐 Redefinir Senha - PayGo',
        html: `<h2>🔐 Recuperação de Senha</h2><p><a href="${customResetLink}">Redefinir Senha</a></p>`
      });
    }
    return res.status(200).json({ success: true, message: 'Enviado.' });
  } catch (error) {
    if (error.code === 'auth/user-not-found') return res.status(200).json({ success: true });
    return res.status(400).json({ error: error.message });
  }
});

// 🟠 P2P TRANSFER
app.post("/api/p2p-transfer", requireAdminAuth, async (req, res) => {
  try {
    const { senderId, receiverEmail, amount, description } = req.body;
    const transferAmount = parseFloat(amount);

    if (!senderId || !receiverEmail || isNaN(transferAmount) || transferAmount <= 0) {
      return res.status(400).json({ error: 'Dados inválidos' });
    }

    const usersRef = db.collection('users');
    const receiverSnap = await usersRef.where('email', '==', receiverEmail.trim().toLowerCase()).limit(1).get();
    if (receiverSnap.empty) return res.status(404).json({ error: 'Usuário não encontrado' });

    const receiverDoc = receiverSnap.docs[0];
    if (senderId === receiverDoc.id) return res.status(400).json({ error: 'Ação inválida' });

    const senderRef = usersRef.doc(senderId);
    const senderDoc = await senderRef.get();
    const senderBalance = parseFloat(senderDoc.data().walletBalance) || 0;
    if (senderBalance < transferAmount) return res.status(400).json({ error: `Saldo insuficiente.` });

    const batch = db.batch();
    const transactionId = `P2P-${Date.now()}`;
    const agora = Timestamp.now();
    
    batch.update(senderRef, { walletBalance: FieldValue.increment(-transferAmount), updatedAt: agora });
    batch.update(receiverDoc.ref, { walletBalance: FieldValue.increment(transferAmount), updatedAt: agora });
    batch.set(db.collection('wallet_transactions').doc(), { userId: senderId, type: 'debit', amount: transferAmount, description: description || `Transferência P2P`, reference: transactionId, relatedUserId: receiverDoc.id, createdAt: agora, metadata: { type: 'p2p', direction: 'sent' } });
    batch.set(db.collection('wallet_transactions').doc(), { userId: receiverDoc.id, type: 'credit', amount: transferAmount, description: description || `Recebido de ${senderDoc.data().email}`, reference: transactionId, relatedUserId: senderId, createdAt: agora, metadata: { type: 'p2p', direction: 'received' } });

    await batch.commit();
    return res.status(200).json({ success: true, transactionId });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// 💸 PAYOUTS AUTOMATIZADOS
app.post("/api/paysuite-payout", requireAdminAuth, async (req, res) => {
  try {
    const { withdrawalId, targetPhone, targetAmount, targetMethod, reason } = req.body;
    if (!withdrawalId || !targetPhone || !targetAmount || !targetMethod) return res.status(400).json({ success: false, error: "Campos obrigatórios em falta" });

    const finalAmount = parseFloat(targetAmount);
    if (isNaN(finalAmount) || finalAmount < 100) return res.status(400).json({ success: false, error: "Valor incorreto" });

    const cleanPhone = targetPhone.replace(/\D/g, '');
    const method = targetMethod.toLowerCase() === 'emola' ? 'emola' : 'mpesa';
    const reference = withdrawalId === "MANUAL_PAYOUT" ? `MAN-${Date.now()}` : withdrawalId;

    const response = await fetch('https://paysuite.tech/api/v1/payouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${process.env.PAYSUITE_API_KEY}` },
      body: JSON.stringify({ amount: finalAmount, phone: cleanPhone, method: method, reference: reference, description: reason || `Payout PayGo` })
    });

    const textData = await response.text();
    let result;
    try { result = JSON.parse(textData); } 
    catch (e) { return res.status(400).json({ success: false, error: "Gateway de payouts indisponível" }); }

    if (!response.ok || result?.status === 'error') {
      return res.status(400).json({ success: false, error: result?.message || "Recusado pela operadora" });
    }

    if (withdrawalId !== "MANUAL_PAYOUT") {
      await db.collection("withdrawals").doc(withdrawalId).update({ status: 'approved', paysuitePayoutId: result.data?.id || `PROC`, amountPaid: finalAmount, phonePaid: cleanPhone, processedAt: Timestamp.now(), processedBy: req.admin.uid });
    }

    return res.status(200).json({ success: true, message: "Transferência executada!" });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
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
  } catch (err) {
    return res.status(200).json({ success: true, rate: 88.00 });
  }
});

// Evitar bloqueios caso tentem correr localmente sem crashar no Vercel (Não usar app.listen no Vercel)
if (process.env.NODE_ENV === 'development') {
  app.listen(PORT, () => {
    console.log(`🚀 Ambiente Local na porta ${PORT}`);
  });
}

module.exports = app;
