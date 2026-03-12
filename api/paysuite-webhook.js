// api/paysuite-webhook.js
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, doc, updateDoc, collection, query, where, getDocs } from 'firebase-admin/firestore';

// ✅ Inicializar Firebase Admin (singleton pattern)
let adminApp = null;
let db = null;

function getFirebaseAdmin() {
  if (!adminApp) {
    adminApp = initializeApp({
      credential: process.env.FIREBASE_SERVICE_ACCOUNT 
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : undefined,
      projectId: process.env.FIREBASE_PROJECT_ID
    });
    db = getFirestore(adminApp);
  }
  return { adminApp, db };
}

export default async function handler(req, res) {
  // ✅ CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-paysuite-signature');

  // ✅ Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ✅ Apenas POST
  if (req.method !== 'POST') {
    console.warn(`⚠️ [paysuite-webhook] Método não permitido: ${req.method}`);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ✅ Log do payload recebido (sem dados sensíveis)
    const payload = req.body;
    console.log('🔔 [paysuite-webhook] Evento recebido:', {
      event: payload?.event,
      paymentId: payload?.data?.payment_id,
      transactionId: payload?.data?.transaction_id,
      status: payload?.data?.status,
      timestamp: new Date().toISOString()
    });

    // ✅ Processar apenas eventos relevantes
    if (!['payment.completed', 'payment.failed', 'payment.pending'].includes(payload?.event)) {
      console.log('⏭️ [paysuite-webhook] Evento ignorado:', payload?.event);
      return res.status(200).json({ received: true, ignored: true });
    }

    const { db } = getFirebaseAdmin();
    const paymentData = payload.data;
    const transactionId = paymentData?.transaction_id;

    if (!transactionId) {
      console.error('❌ [paysuite-webhook] transaction_id não encontrado no payload');
      return res.status(400).json({ error: 'Missing transaction_id' });
    }

    // ✅ Buscar pedido no Firestore
    const ordersRef = collection(db, 'orders');
    const q = query(ordersRef, where('orderId', '==', transactionId));
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      console.warn(`⚠️ [paysuite-webhook] Pedido não encontrado: ${transactionId}`);
      return res.status(404).json({ error: 'Order not found' });
    }

    const orderDoc = snapshot.docs[0];
    const orderData = orderDoc.data();

    // ✅ Preparar dados de atualização
    const updateData = {
      paymentStatus: payload.event === 'payment.completed' ? 'paid' : 
                    payload.event === 'payment.failed' ? 'failed' : 'pending',
      paysuitePaymentId: paymentData.payment_id || null,
      paysuiteStatus: paymentData.status || null,
      updatedAt: new Date().toISOString(),
      paymentDetails: {
        method: paymentData.payment_method || null,
        phone: paymentData.customer?.phone || null,
        transactionRef: paymentData.transaction_ref || null,
        completedAt: paymentData.completed_at || null,
        providerResponse: paymentData // Armazena resposta completa para auditoria
      }
    };

    // ✅ Se pagamento concluído, atualizar status geral
    if (payload.event === 'payment.completed') {
      updateData.status = 'processing';
      updateData.paidAt = new Date().toISOString();
      updateData.paidAmount = paymentData.amount;
      updateData.paidCurrency = paymentData.currency;
    }

    // ✅ Atualizar documento no Firestore
    await updateDoc(doc(db, 'orders', orderDoc.id), updateData);

    console.log('✅ [paysuite-webhook] Pedido atualizado:', {
      orderId: transactionId,
      newStatus: updateData.status,
      paymentStatus: updateData.paymentStatus
    });

    // ✅ ENVIAR NOTIFICAÇÕES (apenas para pagamento concluído)
    if (payload.event === 'payment.completed') {
      await sendPaymentNotifications(orderData, updateData, paymentData);
    }

    // ✅ Responder para PaySuite (confirma recebimento)
    return res.status(200).json({ 
      received: true, 
      processed: true,
      orderId: transactionId,
      event: payload.event
    });

  } catch (err) {
    console.error('❌ [paysuite-webhook] Erro crítico:', {
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
    
    // ✅ Retornar 200 para evitar retries infinitos da PaySuite
    // O erro é logado para investigação posterior
    return res.status(200).json({ 
      received: true, 
      error: true,
      message: 'Internal processing error'
    });
  }
}

// ============================================================================
// 📧 FUNÇÃO CENTRALIZADA DE NOTIFICAÇÕES
// ============================================================================
async function sendPaymentNotifications(orderData, updateData, paymentData) {
  try {
    console.log('🔔 [paysuite-webhook] Iniciando notificações para:', orderData?.email);

    // ✅ URL CORRIGIDA - SEM ESPAÇOS
    const siteUrl = (process.env.SITE_URL || 'https://paygo.co.mz').trim();
    const notifyEndpoint = `${siteUrl}/api/notify-order`;

    // ✅ Combinar dados do pedido com informações de pagamento
    const mergedOrderData = {
      ...orderData,
      ...updateData,
      paymentDetails: {
        ...orderData.paymentDetails,
        ...updateData.paymentDetails,
        ...paymentData
      },
      // Garantir campos essenciais para os templates
      orderId: orderData.orderId,
      name: orderData.name,
      email: orderData.email,
      whatsapp: orderData.whatsapp,
      total: orderData.total,
      paymentMethod: orderData.paymentMethod,
      type: orderData.type,
      detail: orderData.detail
    };

    // ✅ Payload para o endpoint de notificação
    const notifyPayload = {
      orderData: mergedOrderData,
      action: 'payment_confirmed',  // ✅ Ação específica para pagamento confirmado
      sendEmail: true,              // ✅ Enviar email ao cliente
      sendLark: true,               // ✅ Notificar admin via Lark
      metadata: {
        source: 'paysuite-webhook',
        paymentId: paymentData.payment_id,
        transactionRef: paymentData.transaction_ref,
        timestamp: new Date().toISOString()
      }
    };

    console.log('📤 [paysuite-webhook] Enviando notificação para:', notifyEndpoint);

    // ✅ Enviar notificação com timeout e retry simples
    const response = await fetch(notifyEndpoint, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'User-Agent': 'PayGo-PaySuite-Webhook/1.0'
      },
      body: JSON.stringify(notifyPayload),
      signal: AbortSignal.timeout(15000) // 15 segundos timeout
    });

    const result = await response.json().catch(() => ({ raw: 'Invalid JSON' }));

    console.log('📥 [paysuite-webhook] Resposta da notificação:', {
      status: response.status,
      ok: response.ok,
      result: result
    });

    if (!response.ok) {
      console.warn('⚠️ [paysuite-webhook] Notificação retornou erro HTTP:', response.status);
    }

    return { success: true, result };

  } catch (notifyErr) {
    console.error('❌ [paysuite-webhook] Erro ao enviar notificações:', {
      message: notifyErr.message,
      code: notifyErr.code,
      name: notifyErr.name
    });
    // ✅ Não lançar erro - notificações são secundárias ao processamento do pagamento
    return { success: false, error: notifyErr.message };
  }
}
