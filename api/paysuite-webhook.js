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
    const payload = req.body;
    console.log('🔔 [paysuite-webhook] Evento recebido:', {
      event: payload?.event,
      transactionId: payload?.data?.transaction_id,
      status: payload?.data?.status
    });

    // ✅ Só avança se o evento for "Pagamento Concluído"
    if (payload?.event !== 'payment.completed') {
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

    // ✅ Procurar a Encomenda na Base de Dados
    const ordersRef = collection(db, 'orders');
    const q = query(ordersRef, where('orderId', '==', transactionId));
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      console.warn(`⚠️ [paysuite-webhook] Pedido não encontrado: ${transactionId}`);
      return res.status(404).json({ error: 'Order not found' });
    }

    const orderDoc = snapshot.docs[0];
    const orderData = orderDoc.data();

    // Proteção contra duplicação de processamento
    if (orderData.isPaid) {
        console.log(`✅ [paysuite-webhook] Pedido ${transactionId} já processado. Ignorando.`);
        return res.status(200).json({ received: true, processed: false, reason: 'Already paid' });
    }

    // ✅ 1. Atualizar o Firestore (Dinheiro entrou!)
    await updateDoc(doc(db, 'orders', orderDoc.id), {
      status: 'processing', // Move de 'pending' para 'processing'
      isPaid: true,         // Marca como pago
      paysuitePaymentId: paymentData.payment_id || null,
      updatedAt: new Date().toISOString()
    });

    console.log(`✅ [paysuite-webhook] Pedido ${transactionId} atualizado para PAGO. Chamando notify-order...`);

    // ✅ 2. Disparar a TUA API de Notificações (notify-order)
    const siteUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://paygo.co.mz';
    
    // Mesclar os dados da base de dados com a referência de pagamento para o Lark exibir
    const fullOrderData = {
        ...orderData,
        paysuitePaymentId: paymentData.payment_id
    };

    const notifyResponse = await fetch(`${siteUrl}/api/notify-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderData: fullOrderData,
        action: 'payment_confirmed', // A tag que a tua API procura para mandar o e-mail de "Dinheiro Recebido"
        sendEmail: true,
        sendLark: true
      })
    });

    if (!notifyResponse.ok) {
        console.warn(`⚠️ [paysuite-webhook] A API notify-order retornou um erro: ${notifyResponse.status}`);
    } else {
        console.log(`🚀 [paysuite-webhook] Notificações disparadas com sucesso!`);
    }

    // ✅ 3. Responder à PaySuite
    return res.status(200).json({ 
      received: true, 
      processed: true,
      orderId: transactionId
    });

  } catch (err) {
    console.error('❌ [paysuite-webhook] Erro crítico:', err);
    return res.status(200).json({ received: true, error: true }); // Responde 200 para a PaySuite não ficar a repetir
  }
}
