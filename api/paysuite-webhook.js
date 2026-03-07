// api/paysuite-webhook.js
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, doc, updateDoc, collection, query, where, getDocs } from 'firebase-admin/firestore';

// ✅ Inicializar Firebase Admin (apenas uma vez)
let adminApp;
let db;

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
  // ✅ Apenas POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ✅ Verificar assinatura do webhook (segurança)
    const signature = req.headers['x-paysuite-signature'];
    const webhookSecret = process.env.PAYSUITE_WEBHOOK_SECRET;
    
    // ⚠️ Em produção: validar HMAC signature
    // if (!verifyWebhookSignature(req.body, signature, webhookSecret)) {
    //   return res.status(401).json({ error: 'Invalid signature' });
    // }

    const payload = req.body;
    console.log('🔔 [paysuite-webhook] Received:', {
      event: payload.event,
      paymentId: payload.data?.payment_id,
      status: payload.data?.status
    });

    // ✅ Processar apenas eventos de pagamento
    if (payload.event !== 'payment.completed' && payload.event !== 'payment.failed') {
      return res.status(200).json({ received: true });
    }

    const { db } = getFirebaseAdmin();
    const paymentData = payload.data;

    // ✅ Buscar pedido no Firestore pelo transaction_id (orderId)
    const ordersRef = collection(db, 'orders');
    const q = query(ordersRef, where('orderId', '==', paymentData.transaction_id));
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      console.warn('⚠️ [paysuite-webhook] Order not found:', paymentData.transaction_id);
      return res.status(404).json({ error: 'Order not found' });
    }

    const orderDoc = snapshot.docs[0];
    const orderData = orderDoc.data();

    // ✅ Atualizar status do pedido
    const updateData = {
      paymentStatus: payload.event === 'payment.completed' ? 'paid' : 'failed',
      paysuitePaymentId: paymentData.payment_id,
      paysuiteStatus: paymentData.status,
      paidAt: payload.event === 'payment.completed' ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
      paymentDetails: {
        method: paymentData.payment_method,
        phone: paymentData.customer?.phone,
        transactionRef: paymentData.transaction_ref,
        completedAt: paymentData.completed_at
      }
    };

    // ✅ Se pago, atualizar status geral para 'processing'
    if (payload.event === 'payment.completed') {
      updateData.status = 'processing';
      updateData.paidAmount = paymentData.amount;
      updateData.paidCurrency = paymentData.currency;
    }

    await updateDoc(doc(db, 'orders', orderDoc.id), updateData);

    console.log('✅ [paysuite-webhook] Order updated:', {
      orderId: paymentData.transaction_id,
      newStatus: updateData.status,
      paymentStatus: updateData.paymentStatus
    });

    // ✅ Enviar notificações (email + Lark)
    if (payload.event === 'payment.completed') {
      try {
        // Notificar cliente por email
        await fetch(`${process.env.SITE_URL}/api/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: orderData.email,
            subject: `✅ Pagamento Confirmado - Pedido ${paymentData.transaction_id}`,
            template: 'payment-success',
            variables: {
              customer_name: orderData.name,
              order_id: paymentData.transaction_id,
              amount: paymentData.amount,
              currency: paymentData.currency,
              payment_method: paymentData.payment_method === 'm-pesa' ? 'M-Pesa' : 'e-Mola',
              transaction_ref: paymentData.transaction_ref
            }
          })
        }).catch(err => console.error('Email error:', err));

        // Notificar admin via Lark
        await fetch(`${process.env.SITE_URL}/api/webhook-lark`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'payment_completed',
            orderId: paymentData.transaction_id,
            customer: orderData.name,
            amount: paymentData.amount,
            method: paymentData.payment_method,
            phone: paymentData.customer?.phone
          })
        }).catch(err => console.error('Lark error:', err));

      } catch (notifyErr) {
        console.error('⚠️ [paysuite-webhook] Notification error:', notifyErr);
        // Não falhar o webhook por causa de notificações
      }
    }

    // ✅ Responder para PaySuite (confirma recebimento)
    return res.status(200).json({ 
      received: true, 
      processed: true,
      orderId: paymentData.transaction_id
    });

  } catch (err) {
    console.error('❌ [paysuite-webhook] Critical error:', err);
    // Retornar 200 mesmo em erro para evitar retries infinitos da PaySuite
    return res.status(200).json({ received: true, error: true });
  }
}
