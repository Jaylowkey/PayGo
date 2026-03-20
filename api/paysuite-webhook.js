// api/paysuite-webhook.js
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// ✅ Inicialização Segura do Firebase Admin
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
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const db = getFirestore();
    const payload = req.body || {};
    
    // 🟢 1. CRIAR LOG NA CAIXA NEGRA
    let logRef = null;
    try {
        logRef = db.collection('webhook_logs').doc();
        await logRef.set({
            source: 'paysuite',
            event: payload?.event || 'unknown',
            method: req.method,
            ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
            payload: payload,
            status: 'received',
            createdAt: new Date().toISOString()
        });
    } catch (logErr) {
        console.warn('⚠️ [webhook-log] Falha ao criar log inicial:', logErr.message);
    }

    try {
        if (!payload || !payload.event) {
            if (logRef) await logRef.update({ status: 'error', errorMsg: 'Payload vazio ou sem evento' });
            return res.status(400).json({ error: 'Invalid payload structure' });
        }

        const paymentData = payload.data;
        const transactionId = paymentData?.transaction_id;

        if (!transactionId) {
            if (logRef) await logRef.update({ status: 'error', errorMsg: 'transaction_id ausente' });
            return res.status(400).json({ error: 'Missing transaction_id' });
        }

        // ✅ 2. PROCURAR PEDIDO NA BASE DE DADOS
        const ordersRef = db.collection('orders');
        const snapshot = await ordersRef.where('orderId', '==', transactionId).get();

        if (snapshot.empty) {
            if (logRef) await logRef.update({ status: 'error', errorMsg: `Pedido não encontrado no Firestore.` });
            return res.status(404).json({ error: 'Order not found' });
        }

        const orderDoc = snapshot.docs[0];
        const orderData = orderDoc.data();

        // ✅ 3. MÁQUINA DE ESTADOS (Atualização Automática)
        let updateData = { updatedAt: new Date().toISOString() };
        let actionMessage = '';

        switch (payload.event) {
            case 'payment.completed':
                if (orderData.isPaid) {
                    if (logRef) await logRef.update({ status: 'ignored', errorMsg: 'Já estava pago' });
                    return res.status(200).json({ received: true, processed: false, reason: 'Already paid' });
                }
                updateData.status = 'processing';
                updateData.isPaid = true;
                updateData.paysuitePaymentId = paymentData.payment_id || null;
                actionMessage = 'Pagamento confirmado e pedido em processamento.';
                break;
            
            case 'payment.failed':
            case 'payment.expired':
            case 'payment.canceled':
                updateData.status = 'pending';
                updateData.isPaid = false;
                actionMessage = 'Pagamento falhou/expirou. A aguardar pagamento.';
                break;
                
            case 'payment.refunded':
                updateData.status = 'refunded';
                updateData.isPaid = false;
                actionMessage = 'Pagamento reembolsado ao cliente.';
                break;

            default:
                if (logRef) await logRef.update({ status: 'ignored', errorMsg: `Evento ${payload.event} não mapeado.` });
                return res.status(200).json({ received: true, ignored: true });
        }

        // Atualizar Base de Dados
        await orderDoc.ref.update(updateData);

        // ✅ 4. NOTIFICAR SE FOR SUCESSO
        if (payload.event === 'payment.completed') {
            const siteUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://paygo.co.mz';
            const fullOrderData = { ...orderData, ...updateData };

            fetch(`${siteUrl}/api/notify-order`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderData: fullOrderData, action: 'payment_confirmed', sendEmail: true, sendLark: true })
            }).catch(e => console.warn('Erro silencioso notify-order:', e));
        }

        // 🟢 5. FECHAR LOG
        if (logRef) {
            await logRef.update({ 
                status: 'processed', 
                orderId: transactionId,
                actionTaken: actionMessage,
                completedAt: new Date().toISOString()
            });
        }

        return res.status(200).json({ received: true, processed: true, orderId: transactionId, newStatus: updateData.status });

    } catch (err) {
        console.error('❌ Erro no webhook:', err);
        if (logRef) await logRef.update({ status: 'error', errorMsg: err.message });
        return res.status(200).json({ received: true, error: true });
    }
}
