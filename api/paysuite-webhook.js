import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export default async function handler(req, res) {
    // ✅ CORS e Segurança (Permite que a PaySuite entre)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-paysuite-signature');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // 🔥 INICIALIZAÇÃO BLINDADA DO FIREBASE (Vacina Vercel)
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

        const db = getFirestore("paygodb");
        
        // 🚨 PREVENÇÃO DE FALHA NA PAYSUITE: Algumas APIs mandam os dados no 'query' em vez do 'body'
        let payload = req.body;
        if (!payload || Object.keys(payload).length === 0) {
            payload = req.query; // Tenta ler do URL se o Body estiver vazio
        }
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch (e) { payload = {}; }
        }

        // 🟢 REGISTO BRUTO (Para sabermos se a PaySuite sequer tentou contactar)
        await db.collection('webhook_logs').add({
            source: 'paysuite',
            rawPayload: payload,
            receivedAt: new Date().toISOString()
        });

        // Validação Mínima
        if (!payload || (!payload.event && !payload.status)) {
            return res.status(200).json({ warning: 'Payload vazio ou não reconhecido, mas recebido com sucesso.' });
        }

        const paymentData = payload.data || payload;
        
        // 🎯 INTELIGÊNCIA DE BUSCA: Procura por várias chaves onde a PaySuite costuma esconder a referência
        const merchantReference = paymentData.reference || paymentData.tx_ref || paymentData.order_id || paymentData.transaction_id || paymentData.ref;

        if (!merchantReference) {
            return res.status(200).json({ warning: 'Sem ID de referência para processar.' });
        }

        // ✅ BUSCA O PEDIDO NO FIREBASE
        const ordersRef = db.collection('orders');
        const snapshot = await ordersRef.where('orderId', '==', merchantReference).get();

        if (snapshot.empty) {
            return res.status(200).json({ warning: `Pedido ${merchantReference} não encontrado no sistema.` });
        }

        const orderDoc = snapshot.docs[0];
        const orderData = orderDoc.data();

        // ✅ MÁQUINA DE ESTADOS E AUDITORIA AUTOMÁTICA
        const evento = payload.event || payload.status;
        let updateData = { updatedAt: new Date().toISOString() };

        if (evento === 'payment.completed' || evento === 'payment.successful' || evento === 'paid' || evento === 'success') {
            if (orderData.isPaid) {
                return res.status(200).json({ message: 'Pedido já se encontrava pago.' });
            }
            
            // 1. Atualiza o Pedido
            updateData.status = 'processing';
            updateData.isPaid = true;
            updateData.paysuitePaymentId = paymentData.payment_id || paymentData.id || 'N/A';
            await orderDoc.ref.update(updateData);

            // 2. 🤖 O ROBÔ ESCREVE NO LOG DE AUDITORIA (Vai aparecer no teu log.html)
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
                ip: req.headers['x-forwarded-for'] || 'Servidor PaySuite',
                createdAt: new Date().toISOString()
            });

        } else if (evento === 'payment.failed' || evento === 'failed') {
            updateData.status = 'pending';
            updateData.isPaid = false;
            await orderDoc.ref.update(updateData);
        }

        return res.status(200).json({ success: true, orderProcessed: merchantReference });

    } catch (err) {
        console.error('❌ Erro no webhook:', err);
        return res.status(500).json({ error: err.message });
    }
}
