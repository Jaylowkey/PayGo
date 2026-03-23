import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore'; // 👈 Importamos o Incremento Matemático!

export default async function handler(req, res) {
    // ✅ CORS e Segurança
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-paysuite-signature, x-webhook-signature');

    if (req.method === 'OPTIONS') return res.status(200).end();

    let payload = req.body;
    if (!payload || Object.keys(payload).length === 0) payload = req.query;
    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (e) { payload = { raw: payload }; }
    }

    console.log('🟢 [PAYGO WEBHOOK] DADOS RECEBIDOS DA PAYSUITE:', JSON.stringify(payload));

    try {
        // 🔥 INICIALIZAÇÃO FIREBASE
        if (!getApps().length) {
            const envVar = process.env.FIREBASE_SERVICE_ACCOUNT;
            if (!envVar) throw new Error("Falta FIREBASE_SERVICE_ACCOUNT");
            let serviceAccount = JSON.parse(envVar);
            if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
            initializeApp({ credential: cert(serviceAccount) });
        }

        const db = getFirestore("paygodb");
        const agora = new Date().toISOString();

        // 🎯 GRAVAR AUDITORIA
        await db.collection('webhook_logs').add({
            source: 'paysuite',
            rawPayload: payload,
            status: 'received',
            createdAt: agora,
            receivedAt: agora
        });

        if (!payload || !payload.event) {
            return res.status(200).json({ warning: 'Payload sem event.' }); 
        }

        const evento = payload.event;
        const isSuccess = evento === 'payment.completed' || evento === 'payment.success';
        const isFailed = evento === 'payment.failed';

        const paymentData = payload.data || payload; 
        let merchantReference = paymentData.reference || payload.reference; 
        
        // 🛠️ FILTRO INTELIGENTE DE PREFIXOS (Corrige a asneira da PaySuite tirar os traços)
        if (merchantReference) {
            if (merchantReference.startsWith('PG') && !merchantReference.startsWith('PG-')) {
                 merchantReference = merchantReference.replace('PG', 'PG-');
            } else if (merchantReference.startsWith('TOP') && !merchantReference.startsWith('TOP-')) {
                 merchantReference = merchantReference.replace('TOP', 'TOP-');
            }
        }

        if (!merchantReference) {
            return res.status(200).json({ warning: 'Sem Referência para processar' });
        }

        console.log(`🔍 A Analisar Operação: ${merchantReference}`);

        // =====================================================================
        // 🏦 MOTOR 1: O BANQUEIRO (DEPÓSITOS NA CARTEIRA DIGITAL / TOP-UPS)
        // =====================================================================
        if (merchantReference.startsWith('TOP-')) {
            const topupsRef = db.collection('topups');
            const snap = await topupsRef.where('topupId', '==', merchantReference).get();

            if (snap.empty) return res.status(200).json({ warning: `Depósito ${merchantReference} não encontrado.` });

            const docTopup = snap.docs[0];
            const topupData = docTopup.data();

            if (isSuccess) {
                if (topupData.status === 'completed') return res.status(200).json({ message: 'Depósito já processado.' });

                const userId = topupData.userId;
                const amountToCredit = parseFloat(topupData.amount);

                // 1. Marcar a transação de depósito como concluída
                await docTopup.ref.update({
                    status: 'completed',
                    paysuiteId: paymentData.payment_id || paymentData.id || 'N/A',
                    updatedAt: agora
                });

                // 2. INJEÇÃO ATÓMICA DE CAPITAL: Soma o dinheiro à carteira do cliente sem apagar o que lá estava!
                const userRef = db.collection('users').doc(userId);
                await userRef.update({
                    walletBalance: FieldValue.increment(amountToCredit)
                });

                // 3. Criar Extrato Financeiro para o Histórico do Cliente
                await db.collection('wallet_transactions').add({
                    userId: userId,
                    type: 'credit', // credit = entrou dinheiro
                    amount: amountToCredit,
                    description: `Depósito via ${paymentData.method || 'M-Pesa/e-Mola'}`,
                    reference: merchantReference,
                    createdAt: agora
                });

                console.log(`✅ [CARTEIRA] Depósito de ${amountToCredit} MT na conta ${userId} efetuado com sucesso!`);
                return res.status(200).json({ success: true, operation: 'wallet_funded' });
            }
            
            if (isFailed) {
                await docTopup.ref.update({ status: 'failed', updatedAt: agora });
                return res.status(200).json({ message: 'Depósito falhou.' });
            }
        }

        // =====================================================================
        // 🛒 MOTOR 2: O LOGÍSTICO (COMPRA DE PEDIDOS NORMAIS)
        // =====================================================================
        if (merchantReference.startsWith('PG-')) {
            const ordersRef = db.collection('orders');
            const snap = await ordersRef.where('orderId', '==', merchantReference).get();

            if (snap.empty) return res.status(200).json({ warning: `Pedido ${merchantReference} não encontrado.` });

            const docOrder = snap.docs[0];
            const orderData = docOrder.data();

            if (isSuccess) {
                if (orderData.isPaid) return res.status(200).json({ message: 'Já pago.' });
                
                await docOrder.ref.update({
                    status: 'processing',
                    isPaid: true,
                    paysuitePaymentId: paymentData.payment_id || paymentData.id || 'N/A',
                    updatedAt: agora
                });

                await db.collection('admin_audit_logs').add({
                    adminId: 'system_bot',
                    adminName: '🤖 Sistema Automático',
                    action: 'PAGAMENTO_CONFIRMADO',
                    targetId: String(merchantReference),
                    targetType: 'order',
                    details: { updated: { status: 'processing', isPaid: true } },
                    createdAt: agora
                });

                console.log(`✅ [LOJA] Pagamento do Pedido ${merchantReference} confirmado!`);
                return res.status(200).json({ success: true, operation: 'order_paid' });
            }
            
            if (isFailed && !orderData.isPaid) {
                await docOrder.ref.update({ status: 'cancelled', updatedAt: agora });
                return res.status(200).json({ message: 'Pedido cancelado por falha no pagamento.' });
            }
        }

        // Se a referência não for PG- nem TOP-
        return res.status(200).json({ success: true, message: 'Referência ignorada.' });

    } catch (err) {
        console.error('❌ Erro Crítico no Webhook:', err.message);
        return res.status(500).json({ error: err.message });
    }
}
