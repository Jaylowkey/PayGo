import crypto from 'crypto';
import axios from 'axios';
import { Resend } from 'resend';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-paysuite-signature, x-webhook-signature'
  );
}

function normalizeBody(req) {
  let body = req.body;
  if (!body || (typeof body === 'object' && Object.keys(body).length === 0)) {
    body = req.query || {};
  }
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = { raw: body };
    }
  }
  return body || {};
}

function getRoute(req) {
  const slug = req.query?.slug;

  if (Array.isArray(slug) && slug.length) {
    return slug.join('/');
  }

  if (typeof slug === 'string' && slug.trim()) {
    return slug.trim();
  }

  const rawUrl = req.url || '';
  const path = rawUrl.split('?')[0];
  const parts = path.split('/').filter(Boolean);

  if (parts[0] === 'api' && parts.length > 1) {
    return parts.slice(1).join('/');
  }

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

  return {
    db: getFirestore('paygodb'),
    auth: getAuth(),
  };
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

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice(7)
    : signatureHeader;

  if (expected.length !== provided.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(provided, 'utf8')
  );
}

function buildBaseUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  const host = req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

async function handlePaySuitePayment(req, res, body) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método não permitido' });
  }

  const { orderId, amount, method, description } = body;

  if (!orderId || !amount || !method) {
    return res.status(400).json({
      success: false,
      error: 'Faltam campos obrigatórios (orderId, amount, method)',
    });
  }

  if (isNaN(amount) || Number(amount) < 1) {
    return res.status(400).json({
      success: false,
      error: 'O valor mínimo é 1 MT',
    });
  }

  const cleanMethod =
    method === 'mpesa' || method === 'm-pesa'
      ? 'mpesa'
      : method === 'card'
      ? 'card'
      : 'emola';

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

  const response = await fetch(
    `${(process.env.PAYSUITE_API_URL || 'https://paysuite.tech/api/v1').replace(/\/+$/, '')}/payments`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${process.env.PAYSUITE_API_KEY || process.env.PAYSUITE_API_TOKEN}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    }
  );

  const textResponse = await response.text();
  let result;

  try {
    result = JSON.parse(textResponse);
  } catch {
    return res.status(502).json({
      success: false,
      error: `O serviço ${cleanMethod.toUpperCase()} na PaySuite está temporariamente indisponível.`,
      raw: textResponse.substring(0, 300),
    });
  }

  if (!response.ok || result.status === 'error') {
    return res.status(400).json({
      success: false,
      error: result.message || 'O servidor da PaySuite rejeitou o pagamento.',
      data: result,
    });
  }

  return res.status(200).json({
    success: true,
    data: {
      paymentId: result.data?.id,
      status: result.data?.status,
      reference: result.data?.reference,
      checkoutUrl: result.data?.checkout_url,
      method: cleanMethod,
      amount: result.data?.amount,
    },
    message: 'Redirecione o cliente para o checkoutUrl',
  });
}

async function handlePaySuiteWebhook(req, res, body) {
  const rawBody =
    typeof req.body === 'string' ? req.body : JSON.stringify(req.body || body || {});
  const signature =
    req.headers['x-webhook-signature'] || req.headers['x-paysuite-signature'] || '';

  if (!verifyPaySuiteSignature(rawBody, String(signature))) {
    return res.status(401).json({ error: 'Assinatura inválida.' });
  }

  const { db } = getFirebase();
  const agora = new Date().toISOString();

  await db.collection('webhook_logs').add({
    source: 'paysuite',
    rawPayload: body,
    status: 'received',
    createdAt: agora,
    receivedAt: agora,
  });

  if (!body || !body.event) {
    return res.status(200).json({ warning: 'Payload sem event.' });
  }

  const evento = body.event;
  const isSuccess = evento === 'payment.completed' || evento === 'payment.success';
  const isFailed = evento === 'payment.failed';

  const paymentData = body.data || body;
  let merchantReference = paymentData.reference || body.reference;

  if (merchantReference) {
    if (merchantReference.startsWith('PG') && !merchantReference.startsWith('PG-')) {
      merchantReference = merchantReference.replace('PG', 'PG-');
    } else if (
      merchantReference.startsWith('TOP') &&
      !merchantReference.startsWith('TOP-')
    ) {
      merchantReference = merchantReference.replace('TOP', 'TOP-');
    }
  }

  if (!merchantReference) {
    return res.status(200).json({ warning: 'Sem Referência para processar' });
  }

  if (merchantReference.startsWith('TOP-')) {
    const topupsRef = db.collection('topups');
    const snap = await topupsRef.where('topupId', '==', merchantReference).get();

    if (snap.empty) {
      return res.status(200).json({ warning: `Depósito ${merchantReference} não encontrado.` });
    }

    const docTopup = snap.docs[0];
    const topupData = docTopup.data();

    if (isSuccess) {
      if (topupData.status === 'completed') {
        return res.status(200).json({ message: 'Depósito já processado.' });
      }

      const userId = topupData.userId;
      const amountToCredit = parseFloat(topupData.amount);

      await docTopup.ref.update({
        status: 'completed',
        paysuiteId: paymentData.payment_id || paymentData.id || 'N/A',
        updatedAt: agora,
      });

      const userRef = db.collection('users').doc(userId);
      await userRef.update({
        walletBalance: FieldValue.increment(amountToCredit),
      });

      await db.collection('wallet_transactions').add({
        userId,
        type: 'credit',
        amount: amountToCredit,
        description: `Depósito via ${paymentData.method || 'M-Pesa/e-Mola'}`,
        reference: merchantReference,
        createdAt: agora,
      });

      return res.status(200).json({ success: true, operation: 'wallet_funded' });
    }

    if (isFailed) {
      await docTopup.ref.update({ status: 'failed', updatedAt: agora });
      return res.status(200).json({ message: 'Depósito falhou.' });
    }
  }

  if (merchantReference.startsWith('PG-')) {
    const ordersRef = db.collection('orders');
    const snap = await ordersRef.where('orderId', '==', merchantReference).get();

    if (snap.empty) {
      return res.status(200).json({ warning: `Pedido ${merchantReference} não encontrado.` });
    }

    const docOrder = snap.docs[0];
    const orderData = docOrder.data();

    if (isSuccess) {
      if (orderData.isPaid) {
        return res.status(200).json({ message: 'Já pago.' });
      }

      await docOrder.ref.update({
        status: 'processing',
        isPaid: true,
        paysuitePaymentId: paymentData.payment_id || paymentData.id || 'N/A',
        updatedAt: agora,
      });

      await db.collection('admin_audit_logs').add({
        adminId: 'system_bot',
        adminName: '🤖 Sistema Automático',
        action: 'PAGAMENTO_CONFIRMADO',
        targetId: String(merchantReference),
        targetType: 'order',
        details: { updated: { status: 'processing', isPaid: true } },
        createdAt: agora,
      });

      return res.status(200).json({ success: true, operation: 'order_paid' });
    }

    if (isFailed && !orderData.isPaid) {
      await docOrder.ref.update({ status: 'cancelled', updatedAt: agora });
      return res.status(200).json({ message: 'Pedido cancelado por falha no pagamento.' });
    }
  }

  return res.status(200).json({ success: true, message: 'Referência ignorada.' });
}

async function handleDeleteUser(req, res, body) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { uid } = body;
  if (!uid) {
    return res.status(400).json({ error: 'UID do utilizador não fornecido' });
  }

  const { db, auth } = getFirebase();

  try {
    await auth.deleteUser(uid);
  } catch {}

  await db.collection('users').doc(uid).delete();

  return res.status(200).json({
    success: true,
    message: 'Utilizador erradicado com sucesso.',
  });
}

async function handleGetReferrals(req, res, body) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { affiliateCode } = body;
  if (!affiliateCode) {
    return res.status(400).json({ error: 'Código de afiliado não fornecido pelo painel.' });
  }

  const { db } = getFirebase();
  const qUsers = await db.collection('users').where('referredBy', '==', affiliateCode).get();

  const referrals = [];
  qUsers.forEach((doc) => {
    const data = doc.data();
    let dateStr = null;

    if (data.createdAt) {
      if (typeof data.createdAt.toDate === 'function') {
        dateStr = data.createdAt.toDate().toISOString();
      } else {
        dateStr = new Date(data.createdAt).toISOString();
      }
    }

    referrals.push({
      id: doc.id,
      name: data.name || 'Cliente PayGo',
      email: data.email || '',
      status: data.status || 'pending',
      emailVerified: data.emailVerified || false,
      firstPurchaseProcessed: data.firstPurchaseProcessed || false,
      createdAt: dateStr,
    });
  });

  return res.status(200).json({ success: true, referrals });
}

async function handleLogAction(req, res, body) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { adminId, adminName, action, targetId, targetType, previousData, newData } =
    body || {};

  if (!adminId || !action || !targetId) {
    return res.status(400).json({ error: 'DADOS_INCOMPLETOS', dados_recebidos: body });
  }

  const { db } = getFirebase();

  const logData = {
    adminId: String(adminId),
    adminName: adminName ? String(adminName) : 'Admin Oculto',
    action: String(action),
    targetId: String(targetId),
    targetType: targetType ? String(targetType) : 'order',
    details: {
      previous: purificarDados(previousData),
      updated: purificarDados(newData),
    },
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'Desconhecido',
    createdAt: new Date().toISOString(),
  };

  const logRef = await db.collection('admin_audit_logs').add(logData);
  return res.status(200).json({ success: true, logId: logRef.id });
}

async function handleP2PTransfer(req, res, body) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { senderId, receiverEmail, amount } = body;
  const transferAmount = parseFloat(amount);

  if (!senderId || !receiverEmail || isNaN(transferAmount) || transferAmount <= 0) {
    return res.status(400).json({ error: 'Dados inválidos para transferência.' });
  }

  const { db } = getFirebase();
  const agora = new Date().toISOString();
  const usersRef = db.collection('users');
  const receiverSnap = await usersRef.where('email', '==', receiverEmail).get();

  if (receiverSnap.empty) {
    return res
      .status(404)
      .json({ error: 'Atenção: Nenhum cliente PayGo encontrado com este e-mail.' });
  }

  const receiverDoc = receiverSnap.docs[0];
  const receiverId = receiverDoc.id;

  if (senderId === receiverId) {
    return res.status(400).json({ error: 'Não pode enviar dinheiro para si mesmo.' });
  }

  const senderRef = usersRef.doc(senderId);
  const senderDoc = await senderRef.get();
  const senderBalance = parseFloat(senderDoc.data().walletBalance) || 0;

  if (senderBalance < transferAmount) {
    return res.status(400).json({ error: 'Saldo insuficiente para cobrir esta transferência.' });
  }

  const batch = db.batch();
  batch.update(senderRef, { walletBalance: FieldValue.increment(-transferAmount) });
  batch.update(receiverDoc.ref, { walletBalance: FieldValue.increment(transferAmount) });

  batch.set(db.collection('wallet_transactions').doc(), {
    userId: senderId,
    type: 'debit',
    amount: transferAmount,
    description: `Transferência para ${receiverEmail}`,
    reference: 'P2P',
    createdAt: agora,
  });

  batch.set(db.collection('wallet_transactions').doc(), {
    userId: receiverId,
    type: 'credit',
    amount: transferAmount,
    description: `Recebido de ${senderDoc.data().email}`,
    reference: 'P2P',
    createdAt: agora,
  });

  await batch.commit();
  return res.status(200).json({ success: true });
}

async function handleSendWhatsAppInvoice(req, res, body) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método não permitido.' });
  }

  const { orderId, clientName, phone, pdfData } = body;
  if (!orderId || !clientName || !phone || !pdfData) {
    return res.status(400).json({ success: false, error: 'Dados incompletos.' });
  }

  const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
  const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
  const INSTANCE_NAME = process.env.INSTANCE_NAME;

  let cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length <= 9) cleanPhone = '258' + cleanPhone;

  const base64Pure = pdfData.split('base64,')[1];
  const messageText = `Olá *${clientName}*! 👋

A tua compra foi processada com sucesso pela *PayGo*.

📄 Abaixo segue o teu comprovativo oficial (Pedido: ${orderId}).

Obrigado por confiares em nós! 🇲🇿`;

  const response = await axios.post(
    `${EVOLUTION_API_URL}/message/sendMedia/${INSTANCE_NAME}`,
    {
      number: cleanPhone,
      options: { delay: 1200, presence: 'composing' },
      mediaMessage: {
        mediatype: 'document',
        fileName: `Fatura_${orderId}.pdf`,
        caption: messageText,
        media: base64Pure,
      },
    },
    {
      headers: {
        'Content-Type': 'application/json',
        apikey: EVOLUTION_API_KEY,
      },
    }
  );

  if (response.status === 200 || response.status === 201) {
    return res.status(200).json({ success: true, message: 'Fatura enviada no WhatsApp!' });
  }

  throw new Error('Falha de comunicação com a API do WhatsApp.');
}

async function handleSendEmail(req, res, body) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { to, subject, template, variables } = body;

  if (!to || !template) {
    return res.status(400).json({ error: 'Faltam campos obrigatórios: to, template' });
  }

  if (!resend) {
    return res.status(500).json({ error: 'Sem API KEY da Resend' });
  }

  const html = `<div><h2>${template}</h2><pre>${JSON.stringify(variables || {}, null, 2)}</pre></div>`;
  const text = `${template}\n\n${JSON.stringify(variables || {}, null, 2)}`;

  const { data, error } = await resend.emails.send({
    from: 'PayGo Moçambique <noreply@paygo.co.mz>',
    to: [to],
    subject: subject || `PayGo - ${template}`,
    html,
    text,
  });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ success: true, id: data?.id });
}

async function handleRecoverPassword(req, res, body) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = body;
  if (!email) return res.status(400).json({ error: 'Email missing' });

  const { auth } = getFirebase();
  const baseUrl = process.env.SITE_URL || 'https://www.paygo.co.mz';
  const firebaseLink = await auth.generatePasswordResetLink(email);
  const urlObj = new URL(firebaseLink);
  const oobCode = urlObj.searchParams.get('oobCode');
  const customResetLink = `${baseUrl}/seguranca.html?mode=resetPassword&oobCode=${oobCode}`;

  if (!resend) return res.status(500).json({ error: 'Sem API KEY da Resend' });

  await resend.emails.send({
    from: 'PayGo Moçambique <noreply@paygo.co.mz>',
    to: email,
    subject: '🔐 Recuperação de Senha - PayGo',
    html: `<p>Redefina a sua palavra-passe aqui: <a href="${customResetLink}">${customResetLink}</a></p>`,
  });

  return res.status(200).json({ success: true, message: 'Link de segurança enviado.' });
}

async function handleVerifyEmail(req, res, body) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { email, name } = body;
  if (!email) return res.status(400).json({ error: 'Email não fornecido.' });

  const { auth } = getFirebase();
  const baseUrl = process.env.SITE_URL || 'https://www.paygo.co.mz';
  const firebaseLink = await auth.generateEmailVerificationLink(email);
  const urlObj = new URL(firebaseLink);
  const oobCode = urlObj.searchParams.get('oobCode');
  const customVerifyLink = `${baseUrl}/seguranca.html?mode=verifyEmail&oobCode=${oobCode}`;

  if (!resend) return res.status(500).json({ error: 'Sem API KEY da Resend' });

  await resend.emails.send({
    from: 'PayGo Moçambique <noreply@paygo.co.mz>',
    to: email,
    subject: '⚡ Verifique a sua conta PayGo',
    html: `<p>Olá ${name || 'Parceiro'}, verifique a sua conta aqui: <a href="${customVerifyLink}">${customVerifyLink}</a></p>`,
  });

  return res.status(200).json({ success: true, message: 'Email de verificação enviado.' });
}

async function handleNotifyOrder(req, res, body) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  return res.status(200).json({
    success: true,
    message: 'Rota unificada criada. Liga aqui o teu notify-order completo.',
    received: body,
  });
}

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
};

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const route = getRoute(req);
    const body = normalizeBody(req);

    const endpoint = routes[route];
    if (!endpoint) {
      return res.status(404).json({
        success: false,
        error: 'Endpoint não encontrado',
        route,
        available: Object.keys(routes),
      });
    }

    return await endpoint(req, res, body);
  } catch (error) {
    console.error('❌ [api/[...slug]] Erro crítico:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno do servidor',
    });
  }
}
