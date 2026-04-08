require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { Resend } = require("resend");
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// ==========================================
// 1. CONFIGURAÇÕES GLOBAIS E INICIALIZAÇÃO
// ==========================================
const app = express();

// O Express trata do CORS e do parsing de JSON automaticamente para todas as rotas!
app.use(cors());
// Limite aumentado para 10MB para suportar o envio de faturas PDF em Base64
app.use(express.json({ limit: "10mb" })); 
app.use(express.urlencoded({ extended: true }));

// Variáveis Globais PayGo
const WHATSAPP_NUMBER = "258871002255";
const FROM_EMAIL = 'PayGo Moçambique <noreply@paygo.co.mz>';
const SITE_URL = process.env.SITE_URL || 'https://paygo.co.mz';

// Inicialização Resend
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Inicialização Blindada Firebase Admin
if (!getApps().length) {
    const envVar = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (envVar) {
        let serviceAccount;
        try {
            serviceAccount = JSON.parse(envVar);
            if (serviceAccount.private_key) {
                serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
            }
            initializeApp({ credential: cert(serviceAccount) });
            console.log("✅ Firebase Admin Inicializado");
        } catch (e) {
            console.error("❌ Erro ao decodificar FIREBASE_SERVICE_ACCOUNT:", e);
        }
    } else {
        console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT não encontrada.");
    }
}
const db = getFirestore("paygodb");
const auth = getAuth();

// ==========================================
// 2. ROTAS DA PLATAFORMA (MEGAZORD)
// ==========================================

app.get("/api/health", (req, res) => res.json({ status: "PayGo Master API Online 🚀" }));

// 🔴 1. DELETE USER
app.post("/api/delete-user", async (req, res) => {
    try {
        const { uid } = req.body;
        if (!uid) return res.status(400).json({ error: 'UID não fornecido' });
        try { await auth.deleteUser(uid); } catch (e) { console.warn('User não estava no Auth'); }
        await db.collection('users').doc(uid).delete();
        return res.status(200).json({ success: true, message: 'Utilizador apagado.' });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// 🟢 2. GET REFERRALS
app.post("/api/get-referrals", async (req, res) => {
    try {
        const { affiliateCode } = req.body;
        if (!affiliateCode) return res.status(400).json({ error: 'Código em falta.' });

        const qUsers = await db.collection("users").where("referredBy", "==", affiliateCode).get();
        const referrals = [];
        
        qUsers.forEach(doc => {
            const data = doc.data();
            let dateStr = null;
            if (data.createdAt) {
                dateStr = typeof data.createdAt.toDate === 'function' ? data.createdAt.toDate().toISOString() : new Date(data.createdAt).toISOString();
            }
            referrals.push({
                id: doc.id,
                name: data.name || 'Cliente PayGo',
                email: data.email || '', 
                status: data.status || 'pending',
                emailVerified: data.emailVerified || false,
                firstPurchaseProcessed: data.firstPurchaseProcessed || false,
                createdAt: dateStr
            });
        });
        return res.status(200).json({ success: true, referrals });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 🔵 3. LOG ACTION (Auditoria)
app.post("/api/log-action", async (req, res) => {
    const purificarDados = (obj) => {
        if (obj === undefined) return null;
        if (typeof obj !== 'object' || obj === null) return obj;
        return JSON.parse(JSON.stringify(obj)); 
    };

    try {
        const { adminId, adminName, action, targetId, targetType, previousData, newData } = req.body;
        if (!adminId || !action || !targetId) return res.status(400).json({ error: 'DADOS_INCOMPLETOS' });

        const logData = {
            adminId: String(adminId),
            adminName: adminName ? String(adminName) : 'Admin Oculto',
            action: String(action), 
            targetId: String(targetId), 
            targetType: targetType ? String(targetType) : 'order', 
            details: { previous: purificarDados(previousData), updated: purificarDados(newData) },
            ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'Desconhecido',
            createdAt: new Date().toISOString()
        };
        const logRef = await db.collection('admin_audit_logs').add(logData);
        return res.status(200).json({ success: true, logId: logRef.id });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 🟣 4. NOTIFY ORDER (Emails e Lark do Admin)
app.post("/api/notify-order", async (req, res) => {
    try {
        const body = req.body;
        const LARK_WEBHOOK_URL = process.env.LARK_WEBHOOK_URL;

        if (body.type && body.data) {
            return res.status(200).json({ success: true, message: "Use a rota /api/send-email para notificações Lark antigas." });
        }

        const { orderData, sendEmail = true, sendLark = true, action = 'new_order', reason, extraAmount, mediaUrl } = body;
        if (!orderData) return res.status(400).json({ error: 'Payload não reconhecido.' });

        const results = { email: null, lark: null };
        const orderId = orderData.orderId || orderData.topupId || 'N/A';

        let emailSubject, emailHTML;
        if (action === 'payment_confirmed') {
            emailSubject = `✅ Pagamento Recebido - Pedido ${orderId} - PayGo`;
            emailHTML = generatePaymentSuccessHTML(orderData);
        } else if (action === 'order_refunded') {
            emailSubject = `🟣 Reembolso Emitido - Pedido ${orderId} - PayGo`;
            emailHTML = generateRefundHTML(orderData, reason, mediaUrl);
        } else if (action === 'insufficient_funds') {
            emailSubject = `⚠️ Ação Necessária - Pedido ${orderId}`;
            emailHTML = generateInsufficientFundsHTML(orderData, extraAmount, reason);
        } else {
            emailSubject = `🛒 Pedido ${orderId} Registado - PayGo`;
            emailHTML = generateOrderConfirmationHTML(orderData);
        }

        if (sendEmail && orderData.email && resend) {
            const { data, error } = await resend.emails.send({
                from: FROM_EMAIL, to: [orderData.email], subject: emailSubject, html: emailHTML
            });
            results.email = error ? { success: false, error } : { success: true, id: data?.id };
        }
        return res.status(200).json({ success: true, results });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 🟠 5. P2P TRANSFER (Transferências entre utilizadores)
app.post("/api/p2p-transfer", async (req, res) => {
    try {
        const { senderId, receiverEmail, amount } = req.body;
        const transferAmount = parseFloat(amount);

        if (!senderId || !receiverEmail || isNaN(transferAmount) || transferAmount <= 0) {
            return res.status(400).json({ error: 'Dados inválidos.' });
        }

        const usersRef = db.collection('users');
        const receiverSnap = await usersRef.where('email', '==', receiverEmail).get();
        if (receiverSnap.empty) return res.status(404).json({ error: 'Cliente não encontrado com este e-mail.' });

        const receiverDoc = receiverSnap.docs[0];
        if (senderId === receiverDoc.id) return res.status(400).json({ error: 'Não pode enviar dinheiro para si mesmo.' });

        const senderRef = usersRef.doc(senderId);
        const senderDoc = await senderRef.get();
        const senderBalance = parseFloat(senderDoc.data().walletBalance) || 0;

        if (senderBalance < transferAmount) return res.status(400).json({ error: 'Saldo insuficiente.' });

        const batch = db.batch();
        batch.update(senderRef, { walletBalance: FieldValue.increment(-transferAmount) });
        batch.update(receiverDoc.ref, { walletBalance: FieldValue.increment(transferAmount) });

        const agora = new Date().toISOString();
        batch.set(db.collection('wallet_transactions').doc(), { userId: senderId, type: 'debit', amount: transferAmount, description: `P2P para ${receiverEmail}`, reference: 'P2P', createdAt: agora });
        batch.set(db.collection('wallet_transactions').doc(), { userId: receiverDoc.id, type: 'credit', amount: transferAmount, description: `Recebido de ${senderDoc.data().email}`, reference: 'P2P', createdAt: agora });

        await batch.commit();
        return res.status(200).json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 🟤 6. PAYSUITE PAYMENT (Criar checkout)
app.post("/api/paysuite-payment", async (req, res) => {
    try {
        // 🔴 LER O ESTADO DO BOTÃO DE PÂNICO DIRETAMENTE DA FIREBASE
        const settingsDoc = await db.collection('settings').doc('global').get();
        // Se a configuração não existir, assume que está ativa por segurança.
        const PAYSUITE_ACTIVA = settingsDoc.exists ? (settingsDoc.data().paysuiteActive !== false) : true; 

        if (!PAYSUITE_ACTIVA) {
            return res.status(503).json({ 
                success: false, 
                error: "⚠️ Os pagamentos automáticos estão temporariamente em manutenção preventiva. Por favor, feche a sua encomenda através do nosso WhatsApp oficial." 
            });
        }
        // --------------------------------------------------------

        const { orderId, amount, method, description } = req.body;
        if (!orderId || !amount || !method) return res.status(400).json({ success: false, error: 'Faltam dados.' });
        if (isNaN(amount) || amount < 1) return res.status(400).json({ success: false, error: 'Mínimo 1 MT' });

        const cleanMethod = (method === 'mpesa' || method === 'm-pesa') ? 'mpesa' : 'emola';
        const cleanReference = orderId.replace(/[^a-zA-Z0-9]/g, '');

        const response = await fetch('https://paysuite.tech/api/v1/payments', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json', 'Accept': 'application/json',
                'Authorization': `Bearer ${process.env.PAYSUITE_API_KEY}` 
            },
            body: JSON.stringify({
                amount: parseFloat(amount), method: cleanMethod, reference: cleanReference, 
                description: description || `Pedido #${orderId}`, callback_url: `${SITE_URL}/api/paysuite-webhook`, return_url: `${SITE_URL}/index.html`
            })
        });

        const result = await response.json();
        if (!response.ok || result.status === 'error') throw new Error(result.message || 'Erro PaySuite');

        return res.status(200).json({
            success: true,
            data: { paymentId: result.data?.id, checkoutUrl: result.data?.checkout_url, method: cleanMethod }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ⚫ 7. PAYSUITE WEBHOOK (Receber pagamentos da PaySuite)
app.post("/api/paysuite-webhook", async (req, res) => {
    try {
        let payload = req.body;
        if (typeof payload === 'string') try { payload = JSON.parse(payload); } catch (e) {}

        const agora = new Date().toISOString();
        await db.collection('webhook_logs').add({ source: 'paysuite', rawPayload: payload, createdAt: agora });

        if (!payload || !payload.event) return res.status(200).json({ warning: 'Sem event.' });

        const isSuccess = payload.event === 'payment.completed' || payload.event === 'payment.success';
        const isFailed = payload.event === 'payment.failed';
        const paymentData = payload.data || payload; 
        let ref = paymentData.reference || payload.reference; 
        
        if (ref) {
            if (ref.startsWith('PG') && !ref.startsWith('PG-')) ref = ref.replace('PG', 'PG-');
            else if (ref.startsWith('TOP') && !ref.startsWith('TOP-')) ref = ref.replace('TOP', 'TOP-');
        }
        if (!ref) return res.status(200).json({ warning: 'Sem Referência' });

        if (ref.startsWith('TOP-')) {
            const snap = await db.collection('topups').where('topupId', '==', ref).get();
            if (snap.empty) return res.status(200).json({ warning: 'Nao encontrado' });
            if (isSuccess && snap.docs[0].data().status !== 'completed') {
                await snap.docs[0].ref.update({ status: 'completed', updatedAt: agora });
                await db.collection('users').doc(snap.docs[0].data().userId).update({ walletBalance: FieldValue.increment(parseFloat(snap.docs[0].data().amount)) });
            } else if (isFailed) {
                await snap.docs[0].ref.update({ status: 'failed', updatedAt: agora });
            }
        } else if (ref.startsWith('PG-')) {
            const snap = await db.collection('orders').where('orderId', '==', ref).get();
            if (!snap.empty && isSuccess && !snap.docs[0].data().isPaid) {
                await snap.docs[0].ref.update({ status: 'processing', isPaid: true, updatedAt: agora });
            }
        }
        return res.status(200).json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ⚪ 8. RECOVER PASSWORD
app.post("/api/recover-password", async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email missing' });
        
        const link = await auth.generatePasswordResetLink(email);
        const oobCode = new URL(link).searchParams.get('oobCode');
        const customResetLink = `${SITE_URL}/seguranca.html?mode=resetPassword&oobCode=${oobCode}`;

        const html = `<h2>Recuperação de Senha 🔐</h2><a href="${customResetLink}">Redefinir Palavra-passe</a>`;
        if (resend) await resend.emails.send({ from: FROM_EMAIL, to: email, subject: '🔐 Recuperação de Senha - PayGo', html });

        return res.status(200).json({ success: true });
    } catch (error) {
        if (error.code === 'auth/user-not-found') return res.status(200).json({ success: true }); 
        return res.status(500).json({ error: error.message });
    }
});

// 🟨 9. SEND EMAIL (Unificado com Templates)
app.post("/api/send-email", async (req, res) => {
    try {
        const { to, subject, template, variables, type, sendLark = false } = req.body;
        if (!to || !template) return res.status(400).json({ error: 'Faltam campos (to, template)' });

        const html = generateEmailHTML(template, variables || {});
        if (resend) {
            await resend.emails.send({
                from: FROM_EMAIL, to: [to], subject: subject || "Notificação PayGo", html: html
            });
        }
        
        // Disparar para o Lark se necessário
        if (sendLark && process.env.LARK_WEBHOOK_URL) {
            await fetch(process.env.LARK_WEBHOOK_URL, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ msg_type: "text", content: { text: `Alerta: ${template} para ${to}` } })
            }).catch(()=>{});
        }
        return res.status(200).json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 🟧 10. SEND WHATSAPP INVOICE (Evolution API)
app.post("/api/send-whatsapp-invoice", async (req, res) => {
    try {
        const { orderId, clientName, phone, pdfData } = req.body;
        if (!orderId || !phone || !pdfData) return res.status(400).json({ error: 'Dados incompletos.' });

        let cleanPhone = phone.replace(/\D/g, '');
        if (cleanPhone.length <= 9) cleanPhone = '258' + cleanPhone;

        const base64Pure = pdfData.split('base64,')[1];
        const messageText = `Olá *${clientName}*! 👋\n\nA tua compra foi processada com sucesso.\n\n📄 Segue a tua fatura (Pedido: ${orderId}).`;

        await axios.post(
            `${process.env.EVOLUTION_API_URL}/message/sendMedia/${process.env.INSTANCE_NAME}`,
            {
                number: cleanPhone,
                options: { delay: 1200, presence: 'composing' },
                mediaMessage: { mediatype: 'document', fileName: `Fatura_${orderId}.pdf`, caption: messageText, media: base64Pure }
            },
            { headers: { 'Content-Type': 'application/json', 'apikey': process.env.EVOLUTION_API_KEY } }
        );
        return res.status(200).json({ success: true, message: 'WhatsApp enviado!' });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// 🟩 11. VERIFY EMAIL
app.post("/api/verify-email", async (req, res) => {
    try {
        const { email, name } = req.body;
        if (!email) return res.status(400).json({ error: 'Email não fornecido.' });

        const link = await auth.generateEmailVerificationLink(email);
        const oobCode = new URL(link).searchParams.get('oobCode');
        const customVerifyLink = `${SITE_URL}/seguranca.html?mode=verifyEmail&oobCode=${oobCode}`;

        const html = `<h2>Verificação de Email 🛡️</h2><a href="${customVerifyLink}">Validar Conta</a>`;
        if (resend) await resend.emails.send({ from: FROM_EMAIL, to: email, subject: '⚡ Verifique a sua conta PayGo', html });

        return res.status(200).json({ success: true });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 💸 12. AUTOMATIZAÇÃO DE SAQUES (PAYSUITE PAYOUT B2C)
// ==========================================
app.post("/api/paysuite-payout", async (req, res) => {
    try {
        // Recebemos os dados exatos que o Admin preencheu no modal (Número e Valor)
        const { adminId, withdrawalId, targetPhone, targetAmount, targetMethod } = req.body;
        
        if (!adminId || !withdrawalId || !targetPhone || !targetAmount || !targetMethod) {
            return res.status(400).json({ success: false, error: "Dados incompletos para processar o Payout." });
        }

        // 1. Segurança: Garantir que quem disparou a ação foi um Admin válido
        const adminDoc = await db.collection("users").doc(adminId).get();
        if (!adminDoc.exists || (adminDoc.data().role !== 'admin' && adminDoc.data().role !== 'superadmin')) {
            return res.status(403).json({ success: false, error: "Acesso Negado. Privilégios insuficientes." });
        }

        // 2. Verificar o estado do Saque na Firebase
        const wDocRef = db.collection("withdrawals").doc(withdrawalId);
        const wDoc = await wDocRef.get();
        
        if (!wDoc.exists) {
            return res.status(404).json({ success: false, error: "Registo de saque não encontrado na base de dados." });
        }
        
        if (wDoc.data().status !== 'pending') {
            return res.status(400).json({ success: false, error: "Este saque já foi processado, rejeitado ou está bloqueado." });
        }

        // 3. Limpar e preparar os dados para a PaySuite
        const cleanPhone = targetPhone.replace(/\D/g, ''); // Ex: 841234567
        const method = targetMethod.toLowerCase() === 'emola' ? 'emola' : 'mpesa';
        const finalAmount = parseFloat(targetAmount);

        console.log(`🚀 Iniciando Payout Automático: ${finalAmount} MT para ${cleanPhone} (${method}) | Ref: ${withdrawalId}`);

        // 4. Contactar a PaySuite
        const response = await fetch('https://paysuite.tech/api/v1/payouts', { 
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${process.env.PAYSUITE_API_KEY}` 
            },
            // Baseado na estrutura de devoluções deles
            body: JSON.stringify({
                amount: finalAmount,
                phone: cleanPhone,
                method: method,
                reference: withdrawalId,
                description: `Payout PayGo (Ref: ${withdrawalId})`
            })
        });

        const result = await response.json();

        // 5. Tratamento de Erros da PaySuite
        if (!response.ok || result.status === 'error') {
            // Muitas vezes o saldo da tua conta PaySuite pode não ser suficiente para cobrir o Payout
            const errorMsg = result.message || "A operadora rejeitou a transferência. Verifique se tem saldo B2C suficiente na PaySuite.";
            console.error("❌ Erro PaySuite Payout:", errorMsg, result);
            return res.status(400).json({ success: false, error: errorMsg });
        }

        // 6. Sucesso! Atualiza a Base de Dados
        await wDocRef.update({
            status: 'approved',
            paysuitePayoutId: result.data?.id || 'PROCESSADO',
            amountPaid: finalAmount,
            phonePaid: cleanPhone,
            processedAt: FieldValue.serverTimestamp(),
            processedBy: adminDoc.data().name || 'Admin'
        });

        // 7. Regista a ação na Auditoria do Admin (Obrigatório para segurança)
        await db.collection("admin_audit_logs").add({
            adminId: adminId,
            adminName: adminDoc.data().name || 'Admin',
            action: "PAYOUT_AUTOMATICO",
            targetId: withdrawalId,
            targetType: "withdrawal",
            details: { 
                previous: { status: 'pending', amount: wDoc.data().amount }, 
                updated: { status: 'approved', amountPaid: finalAmount, phone: cleanPhone, method: method, paysuiteId: result.data?.id } 
            },
            ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'Desconhecido',
            createdAt: new Date().toISOString()
        });

        return res.status(200).json({ success: true, message: "Transferência executada com sucesso!" });

    } catch (err) {
        console.error("❌ Erro Crítico no Payout:", err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 3. FUNÇÕES AUXILIARES DE HTML
// ==========================================
function getWhatsAppLink(orderId, name, total, method) {
    const isTransf = String(method||'').includes('transferencia');
    const msg = `*OLÁ PAYGO!*\nGostaria de ${isTransf?'enviar o comprovativo':'finalizar pedido'}.\nID: #${orderId}\nValor: ${total} MT`;
    return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;
}

// HTML Base Simplificado
function generateOrderConfirmationHTML(order) {
    const waLink = getWhatsAppLink(order.orderId, order.name, order.total, order.paymentMethod);
    return `<h2>🛒 Pedido Registado!</h2><p>Olá ${order.name}. Total: ${order.total} MT.</p><a href="${waLink}">WhatsApp</a>`;
}
function generatePaymentSuccessHTML(order) {
    return `<h2>✅ Pagamento Recebido!</h2><p>Olá ${order.name}. Confirmado: ${order.total} MT.</p>`;
}
function generateRefundHTML(order, reason, mediaUrl) {
    return `<h2>🟣 Reembolso Emitido</h2><p>Valor devolvido à carteira. Motivo: ${reason}</p>`;
}
function generateInsufficientFundsHTML(order, extra, reason) {
    return `<h2>⚠️ Falta de Fundos</h2><p>Falta ${extra} MT. Motivo: ${reason}</p>`;
}
function generateEmailHTML(template, vars) {
    if(template === 'order-completed') return `<h2>Pedido Concluído 🎉</h2>`;
    if(template === 'welcome') return `<h2>Bem-vindo à PayGo! 🚀</h2><p>Código: ${vars.affiliate_code||''}</p>`;
    return `<h2>Notificação PayGo</h2><p>${vars.message||''}</p>`;
}

// Obrigatório para a Vercel executar o Express
module.exports = app;
