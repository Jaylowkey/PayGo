import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export default async function handler(req, res) {
    // ✅ CORS e Segurança
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-paysuite-signature, x-webhook-signature');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // 🚨 CAPTURAR OS DADOS (Blindagem Vercel)
    let payload = req.body;
    if (!payload || Object.keys(payload).length === 0) payload = req.query;
    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (e) { payload = { raw: payload }; }
    }

    console.log('🟢 [PAYSUITE WEBHOOK] DADOS RECEBIDOS:', JSON.stringify(payload));

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

        // 🎯 GRAVAR COM O NOME EXATO PARA O PAINEL
        await db.collection('webhook_logs').add({
            source: 'paysuite',
            rawPayload: payload,
            status: 'received',
            createdAt: agora,
            receivedAt: agora
        });

        // 🛡️ VALIDAÇÃO DE SEGURANÇA BÁSICA
        if (!payload || !payload.event) {
            console.warn("⚠️ Webhook ignorado: Faltam campos principais.");
            return res.status(200).json({ warning: 'Payload sem event.' }); // Respondemos 200 para a PaySuite não nos bloquear
        }

        // 🎯 O ALVO: A PaySuite documenta 'payment.success', mas na prática envia 'payment.completed'. Lemos os dois!
        const evento = payload.event;
        const isSuccess = evento === 'payment.completed' || evento === 'payment.success';
        const isFailed = evento === 'payment.failed';

        // Extração Inteligente de Dados (Cobrindo falhas da documentação vs prática)
        const paymentData = payload.data || payload; 
        
        // A referência pode vir no 'data.reference' ou diretamente na raiz
        let merchantReference = paymentData.reference || payload.reference; 
        
        // Formatação Defensiva: Se vier "PG441504", forçamos "PG-441504" para o Firebase encontrar!
        if (merchantReference && merchantReference.startsWith('PG') && !merchantReference.startsWith('PG-')) {
             merchantReference = merchantReference.replace('PG', 'PG-');
        }

        if (!merchantReference) {
            console.error("❌ Webhook falhou: Não foi possível encontrar a referência (ID do Pedido).");
            return res.status(200).json({ warning: 'Sem Referência' });
        }

        console.log(`🔍 Procurando Pedido: ${merchantReference}`);

        // ✅ BUSCA O PEDIDO NO FIREBASE
        const ordersRef = db.collection('orders');
        const snapshot = await ordersRef.where('orderId', '==', merchantReference).get();

        if (snapshot.empty) {
            console.error(`❌ Webhook falhou: Pedido ${merchantReference} não existe na Base de Dados.`);
            return res.status(200).json({ warning: `Pedido ${merchantReference} não encontrado.` });
        }

        const orderDoc = snapshot.docs[0];
        const orderData = orderDoc.data();

        // 💰 PROCESSAR O PAGAMENTO BEM-SUCEDIDO
        if (isSuccess) {
            if (orderData.isPaid) {
                console.log(`ℹ️ Pedido ${merchantReference} já estava pago. Ignorando.`);
                return res.status(200).json({ message: 'Já pago.' });
            }
            
            // Tenta obter o ID da transação da PaySuite
            let transactionId = 'N/A';
            if (paymentData.transaction && paymentData.transaction.id) transactionId = paymentData.transaction.id;
            else if (paymentData.id) transactionId = paymentData.id;

            await orderDoc.ref.update({
                status: 'processing',
                isPaid: true,
                paysuitePaymentId: transactionId,
                updatedAt: agora
            });

            // Registo de Auditoria para o Painel
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

            console.log(`✅ Pagamento do Pedido ${merchantReference} confirmado com sucesso!`);
        } 
        // ❌ PROCESSAR FALHA NO PAGAMENTO
        else if (isFailed) {
             console.log(`⚠️ Pagamento do Pedido ${merchantReference} falhou ou foi recusado.`);
             
             if (!orderData.isPaid) {
                 await orderDoc.ref.update({
                    status: 'cancelled',
                    updatedAt: agora,
                    adminNotes: [...(orderData.adminNotes || []), { author: '🤖 Sistema', text: `A PaySuite rejeitou o pagamento. Motivo: ${paymentData.error || 'Desconhecido'}`, date: agora }]
                 });
             }
        } else {
             console.log(`ℹ️ Evento não financeiro recebido: ${evento}`);
        }

        return res.status(200).json({ success: true, orderProcessed: merchantReference });

    } catch (err) {
        console.error('❌ Erro Crítico no Webhook:', err.message);
        return res.status(500).json({ error: err.message });
    }
}
