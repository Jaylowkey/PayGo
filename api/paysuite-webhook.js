import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export default async function handler(req, res) {
    // ✅ CORS e Segurança
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-paysuite-signature');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // 🚨 CAPTURAR OS DADOS
    let payload = req.body;
    if (!payload || Object.keys(payload).length === 0) {
        payload = req.query; 
    }
    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (e) { payload = { texto_bruto: payload }; }
    }

    console.log('🚨 ALARME PAYSUITE 🚨', JSON.stringify(payload));

    try {
        // 🔥 INICIALIZAÇÃO BLINDADA DO FIREBASE
        if (!getApps().length) {
            const envVar = process.env.FIREBASE_SERVICE_ACCOUNT;
            if (!envVar) throw new Error("Falta FIREBASE_SERVICE_ACCOUNT");

            let serviceAccount = JSON.parse(envVar);
            if (serviceAccount.private_key) {
                serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
            }
            initializeApp({ credential: cert(serviceAccount) });
        }

        const db = getFirestore("paygodb");
        const agora = new Date().toISOString();

        // 🟢 CORREÇÃO MÁXIMA: Usar 'createdAt' para o Firebase mostrar no teu Painel!
        try {
            await db.collection('webhook_logs').add({
                source: 'paysuite',
                rawPayload: payload,
                status: 'received',
                createdAt: agora, // O TEU PAINEL EXIGE ESTA PALAVRA!
                receivedAt: agora
            });
        } catch (e) {
            console.error('Falha ao gravar na Caixa Negra:', e.message);
        }

        // Validação Mínima
        if (!payload || (!payload.event && !payload.status)) {
            return res.status(200).json({ warning: 'Payload recebido, mas formato desconhecido.' });
        }

        const paymentData = payload.data || payload;
        const merchantReference = paymentData.reference || paymentData.tx_ref || paymentData.order_id || paymentData.transaction_id || paymentData.ref;

        if (!merchantReference) {
            return res.status(200).json({ warning: 'Sem ID de referência para processar.' });
        }

        // ✅ BUSCA O PEDIDO NO FIREBASE
        const ordersRef = db.collection('orders');
        const snapshot = await ordersRef.where('orderId', '==', merchantReference).get();

        if (snapshot.empty) {
            return res.status(200).json({ warning: `Pedido ${merchantReference} não encontrado.` });
        }

        const orderDoc = snapshot.docs[0];
        const orderData = orderDoc.data();
        const evento = payload.event || payload.status;
        let updateData = { updatedAt: agora };

        // Processa o pagamento
        if (evento === 'payment.completed' || evento === 'payment.successful' || evento === 'paid' || evento === 'success') {
            if (orderData.isPaid) return res.status(200).json({ message: 'Já pago.' });
            
            updateData.status = 'processing';
            updateData.isPaid = true;
            updateData.paysuitePaymentId = paymentData.payment_id || paymentData.id || 'N/A';
            
            await orderDoc.ref.update(updateData);

            await db.collection('admin_audit_logs').add({
                adminId: 'system_bot',
                adminName: '🤖 Sistema Automático (PaySuite)',
                action: 'PAGAMENTO_CONFIRMADO',
                targetId: String(merchantReference),
                targetType: 'order',
                details: {
                    previous: { status: orderData.status, isPaid: orderData.isPaid },
                    updated: { status: 'processing', isPaid: true, method: paymentData.method || 'M-Pesa/e-Mola' }
                },
                ip: req.headers['x-forwarded-for'] || 'PaySuite',
                createdAt: agora
            });
        }

        return res.status(200).json({ success: true, orderProcessed: merchantReference });

    } catch (err) {
        console.error('❌ Erro no webhook:', err.message);
        return res.status(500).json({ error: err.message });
    }
}
