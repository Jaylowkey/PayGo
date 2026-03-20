// api/paysuite-webhook.js
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// ✅ Inicializar Firebase Admin de forma segura (Vercel Stateless)
if (!getApps().length) {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
        console.error("❌ ERRO CRÍTICO: FIREBASE_SERVICE_ACCOUNT em falta.");
    } else {
        try {
            initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
        } catch (e) {
            console.error("❌ ERRO CRÍTICO: Formato inválido na chave do Firebase.");
        }
    }
}

export default async function handler(req, res) {
    // ✅ CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-paysuite-signature');

    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const db = getFirestore();
    const payload = req.body || {};
    
    // 🟢 1. CRIAR LOG INICIAL (CAIXA NEGRA)
    let logRef = null;
    try {
        logRef = db.collection('webhook_logs').doc();
        await logRef.set({
            source: 'paysuite',
            event: payload?.event || 'unknown',
            method: req.method,
            headers: req.headers,
            ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
            payload: payload,
            status: 'received',
            createdAt: new Date().toISOString()
        });
        console.log(`📦 [webhook-log] Criado registo inicial ID: ${logRef.id}`);
    } catch (logErr) {
        console.warn('⚠️ [webhook-log] Falha ao criar log inicial (o processo continuará):', logErr.message);
    }

    try {
        // ✅ Validar Estrutura Básica
        if (!payload || !payload.event) {
            if (logRef) await logRef.update({ status: 'error', errorMsg: 'Payload vazio ou sem evento' });
            return res.status(400).json({ error: 'Invalid payload structure' });
        }

        // ✅ Ignorar eventos que não sejam pagamento concluído para poupar recursos
        if (payload.event !== 'payment.completed') {
            console.log(`⏭️ [paysuite-webhook] Evento ignorado: ${payload.event}`);
            if (logRef) await logRef.update({ status: 'ignored', reason: 'Not a payment.completed event' });
            return res.status(200).json({ received: true, status: 'ignored' });
        }

        const paymentData = payload.data;
        const transactionId = paymentData?.transaction_id;

        if (!transactionId) {
            if (logRef) await logRef.update({ status: 'error', errorMsg: 'transaction_id ausente no objeto data' });
            return res.status(400).json({ error: 'Missing transaction_id' });
        }

        // ✅ 2. PROCURAR PEDIDO NA BASE DE DADOS (Usando Firebase Admin Puro)
        const ordersRef = db.collection('orders');
        const snapshot = await ordersRef.where('orderId', '==', transactionId).get();

        if (snapshot.empty) {
            console.warn(`⚠️ [paysuite-webhook] Pedido fantasma recebido: ${transactionId}`);
            if (logRef) await logRef.update({ status: 'error', errorMsg: `Pedido ${transactionId} não encontrado no Firestore.` });
            return res.status(404).json({ error: 'Order not found' });
        }

        const orderDoc = snapshot.docs[0];
        const orderData = orderDoc.data();

        // ✅ Proteção contra duplicação de Webhooks (A PaySuite pode enviar 2x por segurança)
        if (orderData.isPaid) {
            console.log(`✅ [paysuite-webhook] Pedido ${transactionId} já processado. Ignorando duplicado.`);
            if (logRef) await logRef.update({ status: 'ignored', reason: 'Order already marked as paid' });
            return res.status(200).json({ received: true, processed: false, reason: 'Already paid' });
        }

        // ✅ 3. ATUALIZAR PEDIDO PARA PAGO
        await orderDoc.ref.update({
            status: 'processing', // Move de 'pendente' para 'em processamento'
            isPaid: true,         // Confirma a entrada do dinheiro
            paysuitePaymentId: paymentData.payment_id || null,
            paysuiteRawData: paymentData, // Guarda os dados da operadora por precaução
            updatedAt: new Date().toISOString()
        });

        // ✅ 4. DISPARAR NOTIFICAÇÕES (API notify-order)
        const siteUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://paygo.co.mz';
        const fullOrderData = { ...orderData, paysuitePaymentId: paymentData.payment_id };

        try {
            const notifyResponse = await fetch(`${siteUrl}/api/notify-order`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    orderData: fullOrderData,
                    action: 'payment_confirmed',
                    sendEmail: true,
                    sendLark: true
                })
            });

            if (!notifyResponse.ok) {
                console.warn(`⚠️ [paysuite-webhook] API notify-order retornou erro: ${notifyResponse.status}`);
            }
        } catch (notifyErr) {
            console.error(`❌ [paysuite-webhook] Falha total ao contactar notify-order:`, notifyErr);
        }

        // 🟢 5. FECHAR O LOG COM SUCESSO
        if (logRef) {
            await logRef.update({ 
                status: 'processed', 
                orderId: transactionId,
                completedAt: new Date().toISOString()
            });
        }

        console.log(`🚀 [paysuite-webhook] Pedido ${transactionId} liquidado e fechado com sucesso!`);
        
        // Retornar 200 OK para a PaySuite saber que não precisa reenviar
        return res.status(200).json({ received: true, processed: true, orderId: transactionId, logId: logRef?.id });

    } catch (err) {
        console.error('❌ [paysuite-webhook] Erro crítico no motor:', err);
        
        // 🔴 REGISTAR O ERRO FATAL NO LOG
        if (logRef) {
            try {
                await logRef.update({ 
                    status: 'error', 
                    errorMsg: err.message, 
                    stack: err.stack 
                });
            } catch (e) {}
        }
        
        // Devolvemos 200 à PaySuite na mesma para eles não nos fazerem DDoS com tentativas,
        // porque o erro está do nosso lado e já ficou gravado na caixa negra.
        return res.status(200).json({ received: true, error: true, logId: logRef?.id });
    }
}
