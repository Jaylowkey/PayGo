import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export default async function handler(req, res) {
    // Cabeçalhos essenciais para a PaySuite
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-paysuite-signature');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

    try {
        // 🔥 INICIALIZAÇÃO BLINDADA (A vacina da Vercel)
        if (!getApps().length) {
            const envVar = process.env.FIREBASE_SERVICE_ACCOUNT;
            if (!envVar) return res.status(500).json({ error: "Falta FIREBASE_SERVICE_ACCOUNT" });

            let serviceAccount;
            try {
                serviceAccount = JSON.parse(envVar);
                if (serviceAccount.private_key) {
                    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
                }
            } catch (e) {
                return res.status(500).json({ error: "JSON corrompido na Vercel." });
            }
            initializeApp({ credential: cert(serviceAccount) });
        }

        // 🎯 O ALVO CORRETO: Apontamos para a tua Base de Dados!
        const db = getFirestore("paygodb");
        
        let payload = req.body;
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch (e) { payload = {}; }
        }
        
        // 🟢 GRAVAR NA CAIXA NEGRA (Logs de Webhook)
        let logRef = null;
        try {
            logRef = db.collection('webhook_logs').doc();
            await logRef.set({
                source: 'paysuite',
                event: payload?.event || 'unknown',
                payload: payload,
                status: 'received',
                createdAt: new Date().toISOString()
            });
        } catch (logErr) {
            console.warn('⚠️ Falha ao criar log:', logErr.message);
        }

        if (!payload || !payload.event) {
            if (logRef) await logRef.update({ status: 'error', errorMsg: 'Payload vazio' });
            return res.status(400).json({ error: 'Payload inválido' });
        }

        const paymentData = payload.data || {};
        
        // 🎯 INTELIGÊNCIA DE MATCHING: Procurar a referência PG-XXXX
        const merchantReference = paymentData.reference || paymentData.tx_ref || paymentData.order_id || paymentData.transaction_id;

        if (!merchantReference) {
            if (logRef) await logRef.update({ status: 'error', errorMsg: 'Sem referência (PG-XXXX)' });
            return res.status(400).json({ error: 'Missing reference' });
        }

        // ✅ PROCURAR O PEDIDO NO FIREBASE
        const ordersRef = db.collection('orders');
        const snapshot = await ordersRef.where('orderId', '==', merchantReference).get();

        if (snapshot.empty) {
            if (logRef) await logRef.update({ status: 'error', errorMsg: `ID [${merchantReference}] não encontrado.` });
            return res.status(404).json({ error: 'Order not found' });
        }

        const orderDoc = snapshot.docs[0];
        const orderData = orderDoc.data();

        // ✅ MÁQUINA DE ESTADOS (Atualização Automática)
        let updateData = { updatedAt: new Date().toISOString() };
        let actionMessage = '';

        switch (payload.event) {
            case 'payment.completed':
            case 'payment.successful':
                if (orderData.isPaid) {
                    if (logRef) await logRef.update({ status: 'ignored', errorMsg: 'Já estava pago.' });
                    return res.status(200).json({ received: true, processed: false, reason: 'Already paid' });
                }
                
                // MÁGICA: Muda para PAGO e EM PROCESSAMENTO!
                updateData.status = 'processing';
                updateData.isPaid = true;
                updateData.paysuitePaymentId = paymentData.payment_id || paymentData.id || null;
                actionMessage = 'Pagamento confirmado automaticamente!';
                break;
            
            case 'payment.failed':
            case 'payment.expired':
            case 'payment.canceled':
                updateData.status = 'pending';
                updateData.isPaid = false;
                actionMessage = 'Pagamento falhou ou expirou.';
                break;

            default:
                if (logRef) await logRef.update({ status: 'ignored', errorMsg: `Evento ${payload.event} ignorado.` });
                return res.status(200).json({ received: true, ignored: true });
        }

        // DISPARA A ATUALIZAÇÃO!
        await orderDoc.ref.update(updateData);

        // FECHAR LOG NA CAIXA NEGRA
        if (logRef) {
            await logRef.update({ 
                status: 'processed', 
                orderId: merchantReference,
                actionTaken: actionMessage,
                completedAt: new Date().toISOString()
            });
        }

        return res.status(200).json({ received: true, processed: true, orderId: merchantReference, newStatus: updateData.status });

    } catch (err) {
        console.error('❌ Erro no webhook:', err);
        return res.status(500).json({ error: err.message });
    }
}
