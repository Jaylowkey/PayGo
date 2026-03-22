import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-paysuite-signature');

    if (req.method === 'OPTIONS') return res.status(200).end();

    let payload = req.body;
    if (!payload || Object.keys(payload).length === 0) payload = req.query;
    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (e) { payload = { raw: payload }; }
    }

    // 🟢 MARCADOR DE VERSÃO PARA A VERCEL (Só terá 1 linha agora!)
    console.log('🟢 [WEBHOOK PAYSUITE v3] DADOS RECEBIDOS:', JSON.stringify(payload));

    try {
        if (!getApps().length) {
            const envVar = process.env.FIREBASE_SERVICE_ACCOUNT;
            if (!envVar) throw new Error("Falta FIREBASE_SERVICE_ACCOUNT");
            let serviceAccount = JSON.parse(envVar);
            if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
            initializeApp({ credential: cert(serviceAccount) });
        }

        const db = getFirestore("paygodb");
        const agora = new Date().toISOString();

        // 🎯 GRAVAR COM O NOME EXATO PARA O PAINEL
        await db.collection('webhook_logs').add({
            source: 'paysuite',
            rawPayload: payload,
            status: 'received',
            createdAt: agora,
            receivedAt: agora
        });

        if (!payload || (!payload.event && !payload.status)) {
            return res.status(200).json({ warning: 'Payload sem event ou status.' });
        }

        const paymentData = payload.data || payload;
        const merchantReference = paymentData.reference || paymentData.tx_ref || paymentData.order_id || paymentData.transaction_id || paymentData.ref;

        if (!merchantReference) return res.status(200).json({ warning: 'Sem Referência' });

        const ordersRef = db.collection('orders');
        const snapshot = await ordersRef.where('orderId', '==', merchantReference).get();

        if (snapshot.empty) return res.status(200).json({ warning: `Pedido ${merchantReference} não encontrado.` });

        const orderDoc = snapshot.docs[0];
        const orderData = orderDoc.data();
        const evento = payload.event || payload.status;

        if (evento === 'payment.completed' || evento === 'payment.successful' || evento === 'paid' || evento === 'success') {
            if (orderData.isPaid) return res.status(200).json({ message: 'Já pago.' });
            
            await orderDoc.ref.update({
                status: 'processing',
                isPaid: true,
                paysuitePaymentId: paymentData.payment_id || paymentData.id || 'N/A',
                updatedAt: agora
            });

            await db.collection('admin_audit_logs').add({
                adminId: 'system_bot',
                adminName: '🤖 Sistema Automático (PaySuite)',
                action: 'PAGAMENTO_CONFIRMADO',
                targetId: String(merchantReference),
                targetType: 'order',
                details: {
                    previous: { status: orderData.status, isPaid: orderData.isPaid },
                    updated: { status: 'processing', isPaid: true }
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
