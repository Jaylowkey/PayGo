// ==========================================
// 🚀 PAYGO MASTER API - BACKEND COMPLETO
// ==========================================
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Resend } = require("resend");
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

// ==========================================
// 1. CONFIGURAÇÕES GLOBAIS E VALIDAÇÕES
// ==========================================
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'https://paygo.co.mz'],
    credentials: true
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Headers de Segurança
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});

// Variáveis Globais PayGo
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || "25881002255";
const FROM_EMAIL = `PayGo Moçambique <${process.env.FROM_EMAIL || 'noreply@paygo.co.mz'}>`;
const SITE_URL = process.env.SITE_URL || 'https://paygo.co.mz';

// Validação de Variáveis Críticas
const requiredEnvVars = ['FIREBASE_SERVICE_ACCOUNT'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
    console.warn(`⚠️ Variáveis de ambiente em falta: ${missingVars.join(', ')}`);
}

// Inicialização Resend (com fallback)
const resend = process.env.RESEND_API_KEY 
    ? new Resend(process.env.RESEND_API_KEY) 
    : null;

if (!resend) {
    console.warn("⚠️ RESEND_API_KEY não configurada. Emails não serão enviados.");
}

// ==========================================
// 2. INICIALIZAÇÃO FIREBASE ADMIN (BLINDADA)
// ==========================================
let db = null;
let auth = null;

try {
    if (!getApps().length) {
        const envVar = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (!envVar) {
            throw new Error("FIREBASE_SERVICE_ACCOUNT não definida");
        }

        let serviceAccount;
        try {
            serviceAccount = JSON.parse(envVar);
            // Corrigir chaves privadas com \\n
            if (serviceAccount.private_key) {
                serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
            }
            // Validar campos obrigatórios
            if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
                throw new Error("Service Account incompleta");
            }
            
            initializeApp({ 
                credential: cert(serviceAccount),
                databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
            });
            console.log("✅ Firebase Admin inicializado com sucesso");
        } catch (parseError) {
            console.error("❌ Erro ao processar FIREBASE_SERVICE_ACCOUNT:", parseError.message);
            throw parseError;
        }
    }

    const adminApp = getApps()[0];
    // ✅ CORREÇÃO: Usar banco "paygodb" conforme especificado
    db = getFirestore(adminApp, "paygodb");
    auth = getAuth(adminApp);
    
} catch (firebaseError) {
    console.error("❌ Falha crítica na inicialização do Firebase:", firebaseError.message);
    // Continuar sem Firebase para health checks
}

// ==========================================
// 3. MIDDLEWARE DE AUTENTICAÇÃO ADMIN
// ==========================================
const requireAdminAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Token não fornecido' });
        }
        
        const token = authHeader.split('Bearer ')[1];
        const decodedToken = await auth.verifyIdToken(token);
        
        // Buscar dados do usuário no Firestore
        const userDoc = await db.collection('users').doc(decodedToken.uid).get();
        if (!userDoc.exists) {
            return res.status(403).json({ error: 'Usuário não encontrado' });
        }
        
        const userData = userDoc.data();
        if (userData.role !== 'admin' && userData.role !== 'superadmin') {
            return res.status(403).json({ error: 'Acesso restrito a administradores' });
        }
        
        // Anexar dados do admin à request
        req.admin = {
            uid: decodedToken.uid,
            email: decodedToken.email,
            name: userData.name,
            role: userData.role
        };
        
        next();
    } catch (error) {
        console.error('Erro na autenticação admin:', error);
        return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
};

// ==========================================
// 4. ROTAS DA PLATAFORMA
// ==========================================

// 🔵 Health Check
app.get("/api/health", (req, res) => {
    res.status(200).json({ 
        status: "PayGo Master API Online 🚀",
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// 🔴 DELETE USER (Admin Only)
app.post("/api/delete-user", requireAdminAuth, async (req, res) => {
    try {
        const { uid, reason } = req.body;
        
        if (!uid) {
            return res.status(400).json({ error: 'UID do usuário é obrigatório' });
        }
        
        // Log da ação antes de executar
        await db.collection('admin_audit_logs').add({
            adminId: req.admin.uid,
            adminName: req.admin.name,
            action: 'DELETE_USER',
            targetId: uid,
            targetType: 'user',
            details: { reason: reason || 'Não especificado' },
            ip: req.ip,
            createdAt: Timestamp.now()
        });
        
        // Deletar do Auth (pode falhar se usuário não existir)
        try {
            await auth.deleteUser(uid);
            console.log(`✅ Usuário ${uid} removido do Firebase Auth`);
        } catch (authError) {
            console.warn(`⚠️ Usuário ${uid} não encontrado no Auth:`, authError.message);
        }
        
        // Deletar do Firestore
        await db.collection('users').doc(uid).delete();
        
        // Deletar dados relacionados (ordens, transações, etc.)
        const batch = db.batch();
        const collections = ['orders', 'wallet_transactions', 'withdrawals', 'support_tickets'];
        
        for (const collection of collections) {
            const snapshot = await db.collection(collection)
                .where('userId', '==', uid)
                .limit(100)
                .get();
            
            snapshot.forEach(doc => {
                batch.delete(doc.ref);
            });
        }
        
        if (!batch._operations || batch._operations.length > 0) {
            await batch.commit();
        }
        
        return res.status(200).json({ 
            success: true, 
            message: 'Usuário e dados relacionados apagados com sucesso' 
        });
        
    } catch (error) {
        console.error('Erro ao deletar usuário:', error);
        return res.status(500).json({ 
            error: 'Erro interno ao processar exclusão',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// 🟢 GET REFERRALS (Admin Only)
app.post("/api/get-referrals", requireAdminAuth, async (req, res) => {
    try {
        const { affiliateCode, limit = 100, page = 1 } = req.body;
        
        if (!affiliateCode) {
            return res.status(400).json({ error: 'Código de afiliado é obrigatório' });
        }
        
        const qUsers = await db.collection("users")
            .where("referredBy", "==", affiliateCode)
            .orderBy("createdAt", "desc")
            .limit(limit)
            .get();
        
        const referrals = [];
        
        qUsers.forEach(doc => {
            const data = doc.data();
            let dateStr = null;
            
            if (data.createdAt) {
                if (data.createdAt instanceof Timestamp) {
                    dateStr = data.createdAt.toDate().toISOString();
                } else if (typeof data.createdAt?.toDate === 'function') {
                    dateStr = data.createdAt.toDate().toISOString();
                } else {
                    dateStr = new Date(data.createdAt).toISOString();
                }
            }
            
            referrals.push({
                id: doc.id,
                name: data.name || 'Cliente PayGo',
                email: data.email || '',
                phone: data.phone || '',
                status: data.status || 'pending',
                emailVerified: data.emailVerified || false,
                firstPurchaseProcessed: data.firstPurchaseProcessed || false,
                totalPurchases: data.totalPurchases || 0,
                walletBalance: data.walletBalance || 0,
                createdAt: dateStr,
                lastLogin: data.lastLogin || null
            });
        });
        
        return res.status(200).json({ 
            success: true, 
            count: referrals.length,
            referrals 
        });
        
    } catch (err) {
        console.error('Erro ao buscar indicações:', err);
        return res.status(500).json({ 
            error: 'Erro ao carregar indicações',
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});

// 🔵 LOG ACTION (Auditoria - Admin Only)
app.post("/api/log-action", requireAdminAuth, async (req, res) => {
    try {
        const { action, targetId, targetType, previousData, newData, reason } = req.body;
        
        // Validação mínima
        if (!action || !targetId) {
            return res.status(400).json({ error: 'action e targetId são obrigatórios' });
        }
        
        // Função para sanitizar dados sensíveis
        const sanitizeData = (obj) => {
            if (obj === null || obj === undefined) return null;
            if (typeof obj !== 'object') return obj;
            
            const sensitive = ['password', 'token', 'apiKey', 'private_key', 'secret'];
            const cleaned = {};
            
            for (const [key, value] of Object.entries(obj)) {
                if (sensitive.some(s => key.toLowerCase().includes(s))) {
                    cleaned[key] = '[REDACTED]';
                } else if (typeof value === 'object' && value !== null) {
                    cleaned[key] = sanitizeData(value);
                } else {
                    cleaned[key] = value;
                }
            }
            return cleaned;
        };

        const logData = {
            adminId: req.admin.uid,
            adminName: req.admin.name || 'Admin',
            adminRole: req.admin.role,
            action: String(action),
            targetId: String(targetId),
            targetType: targetType ? String(targetType) : 'unknown',
            reason: reason || null,
            details: {
                previous: sanitizeData(previousData),
                updated: sanitizeData(newData)
            },
            metadata: {
                ip: req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown',
                userAgent: req.headers['user-agent'] || 'unknown',
                timestamp: new Date().toISOString()
            },
            createdAt: Timestamp.now()
        };
        
        const logRef = await db.collection('admin_audit_logs').add(logData);
        
        return res.status(200).json({ 
            success: true, 
            logId: logRef.id,
            message: 'Ação registrada com sucesso'
        });
        
    } catch (err) {
        console.error('Erro ao registrar log:', err);
        return res.status(500).json({ 
            error: 'Falha ao registrar auditoria',
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});

// 🟣 NOTIFY ORDER (Emails e Notificações)
app.post("/api/notify-order", async (req, res) => {
    try {
        const body = req.body;
        
        // Suporte a webhook da PaySuite
        if (body.type && body.data) {
            // Webhook format - redirecionar para handler específico
            return res.status(200).json({ 
                success: true, 
                message: "Webhook recebido. Use /api/paysuite-webhook para processamento." 
            });
        }

        const { orderData, sendEmail = true, sendLark = true, action = 'new_order', reason, extraAmount, mediaUrl } = body;
        
        if (!orderData) {
            return res.status(400).json({ error: 'Dados do pedido são obrigatórios' });
        }

        const results = { email: null, lark: null };
        const orderId = orderData.orderId || orderData.topupId || orderData.id || 'N/A';
        const userEmail = orderData.email;

        // Gerar conteúdo do email baseado na ação
        let emailSubject, emailHTML;
        
        switch (action) {
            case 'payment_confirmed':
                emailSubject = `✅ Pagamento Recebido - Pedido ${orderId} - PayGo`;
                emailHTML = generatePaymentSuccessHTML(orderData);
                break;
            case 'order_refunded':
                emailSubject = `🟣 Reembolso Emitido - Pedido ${orderId} - PayGo`;
                emailHTML = generateRefundHTML(orderData, reason, mediaUrl);
                break;
            case 'insufficient_funds':
                emailSubject = `⚠️ Ação Necessária - Pedido ${orderId}`;
                emailHTML = generateInsufficientFundsHTML(orderData, extraAmount, reason);
                break;
            case 'order_completed':
                emailSubject = `🎉 Pedido Concluído - #${orderId} - PayGo`;
                emailHTML = generateOrderCompletedHTML(orderData);
                break;
            default:
                emailSubject = `🛒 Pedido ${orderId} Registado - PayGo`;
                emailHTML = generateOrderConfirmationHTML(orderData);
        }

        // Enviar email via Resend
        if (sendEmail && userEmail && resend) {
            try {
                const { data, error } = await resend.emails.send({
                    from: FROM_EMAIL,
                    to: [userEmail],
                    subject: emailSubject,
                    html: emailHTML,
                    text: emailHTML.replace(/<[^>]*>/g, '') // Fallback em texto puro
                });
                
                results.email = error 
                    ? { success: false, error: error.message } 
                    : { success: true, id: data?.id };
                    
            } catch (emailError) {
                console.error('Erro ao enviar email:', emailError);
                results.email = { success: false, error: emailError.message };
                // Não falhar a request inteira se email falhar
            }
        } else if (sendEmail && userEmail && !resend) {
            console.warn(`⚠️ Email não enviado para ${userEmail}: Resend não configurado`);
        }

        // Enviar notificação Lark (opcional)
        if (sendLark && process.env.LARK_WEBHOOK_URL) {
            try {
                await fetch(process.env.LARK_WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        msg_type: "post",
                        content: {
                            post: {
                                "pt-MZ": {
                                    title: `🔔 ${action === 'new_order' ? 'Novo Pedido' : 'Atualização'}: ${orderId}`,
                                    content: [[
                                        { tag: "text", text: `Cliente: ${orderData.name}\n` },
                                        { tag: "text", text: `Valor: ${orderData.total?.toFixed(2) || 'N/A'} MT\n` },
                                        { tag: "a", text: "Ver no Painel", href: `${SITE_URL}/admin/pedidos.html?id=${orderId}` }
                                    ]]
                                }
                            }
                        }
                    })
                });
                results.lark = { success: true };
            } catch (larkError) {
                console.warn('⚠️ Falha ao notificar Lark:', larkError.message);
                results.lark = { success: false, error: larkError.message };
            }
        }

        return res.status(200).json({ 
            success: true, 
            results,
            message: 'Notificações processadas'
        });
        
    } catch (err) {
        console.error('Erro crítico em notify-order:', err);
        return res.status(500).json({ 
            error: 'Erro interno ao processar notificações',
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});

// 🟠 P2P TRANSFER (Entre usuários - Requer Auth)
app.post("/api/p2p-transfer", requireAdminAuth, async (req, res) => {
    try {
        const { senderId, receiverEmail, amount, description } = req.body;
        const transferAmount = parseFloat(amount);

        // Validações
        if (!senderId || !receiverEmail) {
            return res.status(400).json({ error: 'senderId e receiverEmail são obrigatórios' });
        }
        if (isNaN(transferAmount) || transferAmount <= 0) {
            return res.status(400).json({ error: 'Valor deve ser um número positivo' });
        }
        if (transferAmount > 50000) { // Limite de segurança
            return res.status(400).json({ error: 'Valor excede o limite permitido (50.000 MT)' });
        }

        const usersRef = db.collection('users');
        
        // Buscar destinatário
        const receiverSnap = await usersRef.where('email', '==', receiverEmail.trim().toLowerCase()).limit(1).get();
        if (receiverSnap.empty) {
            return res.status(404).json({ error: 'Nenhum usuário encontrado com este e-mail' });
        }

        const receiverDoc = receiverSnap.docs[0];
        
        // Prevenir auto-transferência
        if (senderId === receiverDoc.id) {
            return res.status(400).json({ error: 'Não é possível enviar dinheiro para si mesmo' });
        }

        // Verificar saldo do remetente
        const senderRef = usersRef.doc(senderId);
        const senderDoc = await senderRef.get();
        
        if (!senderDoc.exists) {
            return res.status(404).json({ error: 'Remetente não encontrado' });
        }
        
        const senderBalance = parseFloat(senderDoc.data().walletBalance) || 0;
        if (senderBalance < transferAmount) {
            return res.status(400).json({ 
                error: `Saldo insuficiente. Disponível: ${senderBalance.toFixed(2)} MT` 
            });
        }

        // Executar transação atômica
        const batch = db.batch();
        const transactionId = `P2P-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
        const agora = Timestamp.now();
        
        // Debitar remetente
        batch.update(senderRef, { 
            walletBalance: FieldValue.increment(-transferAmount),
            updatedAt: agora
        });
        
        // Creditar destinatário
        batch.update(receiverDoc.ref, { 
            walletBalance: FieldValue.increment(transferAmount),
            updatedAt: agora
        });
        
        // Registrar transações para ambos
        batch.set(db.collection('wallet_transactions').doc(), {
            userId: senderId,
            type: 'debit',
            amount: transferAmount,
            description: description || `Transferência P2P para ${receiverEmail}`,
            reference: transactionId,
            relatedUserId: receiverDoc.id,
            createdAt: agora,
            metadata: { type: 'p2p', direction: 'sent' }
        });
        
        batch.set(db.collection('wallet_transactions').doc(), {
            userId: receiverDoc.id,
            type: 'credit',
            amount: transferAmount,
            description: description || `Recebido de ${senderDoc.data().email}`,
            reference: transactionId,
            relatedUserId: senderId,
            createdAt: agora,
            metadata: { type: 'p2p', direction: 'received' }
        });

        await batch.commit();
        
        // Log de auditoria
        await db.collection('admin_audit_logs').add({
            adminId: req.admin.uid,
            adminName: req.admin.name,
            action: 'P2P_TRANSFER',
            targetId: transactionId,
            targetType: 'transaction',
            details: {
                from: senderId,
                to: receiverDoc.id,
                amount: transferAmount,
                description: description
            },
            createdAt: agora
        });

        return res.status(200).json({ 
            success: true,
            transactionId,
            message: 'Transferência realizada com sucesso'
        });
        
    } catch (err) {
        console.error('Erro em P2P transfer:', err);
        return res.status(500).json({ 
            error: 'Erro ao processar transferência',
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});

// 🟤 PAYSUITE PAYMENT (Criar checkout)
app.post("/api/paysuite-payment", async (req, res) => {
    try {
        // Verificar se PaySuite está ativa nas configurações
        let paysuiteActive = true;
        if (db) {
            try {
                const settingsDoc = await db.collection('settings').doc('global').get();
                if (settingsDoc.exists) {
                    paysuiteActive = settingsDoc.data().paysuiteActive !== false;
                }
            } catch (e) {
                console.warn('⚠️ Não foi possível verificar status da PaySuite:', e.message);
            }
        }

        if (!paysuiteActive) {
            return res.status(503).json({ 
                success: false, 
                error: "⚠️ Pagamentos automáticos estão em manutenção. Use o WhatsApp para finalizar seu pedido.",
                fallback: `https://wa.me/${WHATSAPP_NUMBER}`
            });
        }

        const { orderId, amount, method, description, phone, email, name } = req.body;
        
        // Validações básicas
        if (!orderId || !amount || !method) {
            return res.status(400).json({ success: false, error: 'orderId, amount e method são obrigatórios' });
        }
        if (isNaN(amount) || amount < 1) {
            return res.status(400).json({ success: false, error: 'Valor mínimo: 1 MT' });
        }
        if (amount > 100000) { // Limite de segurança
            return res.status(400).json({ success: false, error: 'Valor excede limite permitido' });
        }

        // Normalizar método de pagamento
        const cleanMethod = ['mpesa', 'm-pesa'].includes(method.toLowerCase()) ? 'mpesa' : 'emola';
        const cleanReference = String(orderId).replace(/[^a-zA-Z0-9\-]/g, '').substring(0, 50);

        // Preparar payload para PaySuite
        const paysuitePayload = {
            amount: parseFloat(amount),
            method: cleanMethod,
            reference: cleanReference,
            description: description || `Pedido PayGo #${orderId}`,
            callback_url: `${SITE_URL}/api/paysuite-webhook`,
            return_url: `${SITE_URL}/index.html?payment=${cleanReference}`,
            // Dados do cliente para melhor experiência
            customer: {
                name: name || '',
                email: email || '',
                phone: phone ? phone.replace(/\D/g, '') : ''
            }
        };

        // Fetch nativo do Node.js 18+ (com fallback de erro)
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

        let response;
        try {
            response = await fetch('https://paysuite.tech/api/v1/payments', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${process.env.PAYSUITE_API_KEY}`,
                    'User-Agent': 'PayGo-API/1.0'
                },
                body: JSON.stringify(paysuitePayload),
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }

        // Parser seguro de resposta (evita crash se PaySuite retornar HTML)
        const textData = await response.text();
        let result;
        
        try {
            result = JSON.parse(textData);
        } catch (parseError) {
            console.error("❌ PaySuite retornou resposta não-JSON:", textData.substring(0, 200));
            return res.status(502).json({ 
                success: false, 
                error: "Gateway de pagamentos indisponível. Tente novamente em instantes." 
            });
        }

        // Verificar resposta da PaySuite
        if (!response.ok) {
            return res.status(400).json({ 
                success: false, 
                error: result.message || result.error || `Erro HTTP ${response.status}` 
            });
        }
        
        if (result.status === 'error') {
            return res.status(400).json({ 
                success: false, 
                error: result.message || 'Operação recusada pela operadora' 
            });
        }

        // Resposta de sucesso
        return res.status(200).json({
            success: true,
            data: {
                paymentId: result.data?.id,
                checkoutUrl: result.data?.checkout_url,
                method: cleanMethod,
                reference: cleanReference,
                expiresAt: result.data?.expires_at
            },
            message: 'Checkout criado com sucesso'
        });

    } catch (err) {
        console.error("Erro crítico em paysuite-payment:", err);
        
        // Tratamento específico para erros de rede/timeout
        if (err.name === 'AbortError') {
            return res.status(504).json({ 
                success: false, 
                error: "Tempo limite excedido ao conectar com a PaySuite" 
            });
        }
        
        return res.status(500).json({ 
            success: false, 
            error: "Erro interno ao processar pagamento",
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});

// ⚫ PAYSUITE WEBHOOK (Processar pagamentos recebidos)
app.post("/api/paysuite-webhook", async (req, res) => {
    try {
        // Parse flexível do payload
        let payload = req.body;
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch (e) {}
        }
        
        // Log do webhook para debugging
        const agora = Timestamp.now();
        await db?.collection('webhook_logs').add({
            source: 'paysuite',
            event: payload?.event || 'unknown',
            reference: payload?.data?.reference || payload?.reference,
            status: payload?.status,
            rawPayload: payload,
            receivedAt: agora
        }).catch(e => console.warn('⚠️ Falha ao logar webhook:', e.message));

        // Validar payload mínimo
        if (!payload?.event) {
            return res.status(200).json({ warning: 'Evento não especificado' });
        }

        const isSuccess = ['payment.completed', 'payment.success', 'transaction.completed'].includes(payload.event);
        const isFailed = ['payment.failed', 'payment.cancelled', 'transaction.failed'].includes(payload.event);
        
        const paymentData = payload.data || payload;
        let ref = paymentData.reference || payload.reference;
        
        // Normalizar referência
        if (ref) {
            ref = String(ref).toUpperCase();
            if (ref.startsWith('PG') && !ref.startsWith('PG-')) ref = `PG-${ref.slice(2)}`;
            if (ref.startsWith('TOP') && !ref.startsWith('TOP-')) ref = `TOP-${ref.slice(3)}`;
        }
        
        if (!ref) {
            return res.status(200).json({ warning: 'Referência não encontrada no payload' });
        }

        // Processar TOP-UPs
        if (ref.startsWith('TOP-')) {
            const snap = await db?.collection('topups')
                .where('topupId', '==', ref)
                .limit(1)
                .get();
            
            if (!snap || snap.empty) {
                return res.status(200).json({ warning: `Top-up ${ref} não encontrado` });
            }
            
            const doc = snap.docs[0];
            const currentStatus = doc.data().status;
            
            if (isSuccess && currentStatus !== 'completed') {
                const amount = parseFloat(doc.data().amount) || 0;
                
                await doc.ref.update({ 
                    status: 'completed', 
                    paidAt: agora,
                    paysuitePaymentId: paymentData.id || payload.id,
                    updatedAt: agora 
                });
                
                // Creditar na carteira do usuário
                if (doc.data().userId && amount > 0) {
                    await db.collection('users').doc(doc.data().userId).update({
                        walletBalance: FieldValue.increment(amount),
                        updatedAt: agora
                    });
                }
                
                console.log(`✅ Top-up ${ref} concluído: ${amount} MT creditados`);
                
            } else if (isFailed && currentStatus === 'pending') {
                await doc.ref.update({ 
                    status: 'failed', 
                    failedAt: agora,
                    failureReason: paymentData.failure_reason || 'Falha no processamento',
                    updatedAt: agora 
                });
                console.log(`❌ Top-up ${ref} falhou`);
            }
            
        } 
        // Processar Pedidos (PG-)
        else if (ref.startsWith('PG-')) {
            const snap = await db?.collection('orders')
                .where('orderId', '==', ref)
                .limit(1)
                .get();
            
            if (!snap || snap.empty) {
                return res.status(200).json({ warning: `Pedido ${ref} não encontrado` });
            }
            
            const doc = snap.docs[0];
            const orderData = doc.data();
            
            // Processar apenas se não foi pago ainda
            if (isSuccess && !orderData.isPaid) {
                await doc.ref.update({ 
                    status: 'processing', 
                    isPaid: true,
                    paidAt: agora,
                    paymentMethod: paymentData.method || orderData.paymentMethod,
                    paysuitePaymentId: paymentData.id || payload.id,
                    updatedAt: agora 
                });
                
                console.log(`✅ Pedido ${ref} pago - Status: processing`);
                
                // Trigger: Notificar cliente sobre pagamento confirmado
                // (opcional: chamar /api/notify-order aqui)
                
            } else if (isFailed && orderData.status === 'pending') {
                await doc.ref.update({ 
                    status: 'payment_failed',
                    failedAt: agora,
                    failureReason: paymentData.failure_reason || 'Pagamento não confirmado',
                    updatedAt: agora 
                });
                console.log(`❌ Pedido ${ref} falhou no pagamento`);
            }
        }

        return res.status(200).json({ success: true, processed: true });
        
    } catch (err) {
        console.error("Erro ao processar webhook PaySuite:", err);
        // Retornar 200 mesmo em erro para evitar retries infinitos da PaySuite
        return res.status(200).json({ 
            success: false, 
            error: "Erro interno no processamento",
            logged: true
        });
    }
});

// ⚪ RECOVER PASSWORD
app.post("/api/recover-password", async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Email válido é obrigatório' });
        }

        // Gerar link de reset
        const link = await auth.generatePasswordResetLink(email);
        const oobCode = new URL(link).searchParams.get('oobCode');
        
        // Link customizado com nossa UI
        const customResetLink = `${SITE_URL}/seguranca.html?mode=resetPassword&oobCode=${oobCode}`;

        // Template de email
        const html = `
            <!DOCTYPE html>
            <html>
            <body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #2563eb;">🔐 Recuperação de Senha</h2>
                <p>Olá,</p>
                <p>Recebemos uma solicitação para redefinir sua senha na PayGo.</p>
                <p style="margin: 20px 0;">
                    <a href="${customResetLink}" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">
                        Redefinir Senha
                    </a>
                </p>
                <p style="font-size: 12px; color: #666;">
                    Este link expira em 1 hora. Se não solicitou esta alteração, ignore este email.
                </p>
                <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                <p style="font-size: 12px; color: #999;">PayGo Moçambique • <a href="${SITE_URL}">${SITE_URL}</a></p>
            </body>
            </html>
        `;

        // Enviar email
        if (resend) {
            await resend.emails.send({
                from: FROM_EMAIL,
                to: [email],
                subject: '🔐 Redefinir Senha - PayGo',
                html: html,
                text: `Redefina sua senha: ${customResetLink}`
            });
        }

        // Por segurança, sempre retornar sucesso (evitar enumeração de usuários)
        return res.status(200).json({ 
            success: true,
            message: 'Se o email estiver cadastrado, você receberá instruções para redefinir sua senha.'
        });
        
    } catch (error) {
        // auth/user-not-found é esperado - não revelar
        if (error.code === 'auth/user-not-found') {
            return res.status(200).json({ success: true });
        }
        
        console.error('Erro em recover-password:', error);
        return res.status(500).json({ 
            error: 'Erro ao processar solicitação',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// 🟨 SEND EMAIL (Genérico)
app.post("/api/send-email", async (req, res) => {
    try {
        const { to, subject, template, variables, type, sendLark = false } = req.body;
        
        // Validações
        if (!to || !template) {
            return res.status(400).json({ error: 'Campos obrigatórios: to, template' });
        }
        
        // Validar email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const recipients = Array.isArray(to) ? to : [to];
        const validRecipients = recipients.filter(email => emailRegex.test(email));
        
        if (validRecipients.length === 0) {
            return res.status(400).json({ error: 'Nenhum email válido fornecido' });
        }

        // Gerar HTML do email
        const html = generateEmailHTML(template, variables || {});
        
        // Enviar via Resend
        if (resend) {
            await resend.emails.send({
                from: FROM_EMAIL,
                to: validRecipients,
                subject: subject || "Notificação PayGo",
                html: html,
                text: html.replace(/<[^>]*>/g, '').substring(0, 500) // Fallback texto
            });
        }
        
        // Notificar Lark (opcional)
        if (sendLark && process.env.LARK_WEBHOOK_URL) {
            try {
                await fetch(process.env.LARK_WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        msg_type: "post",
                        content: {
                            post: {
                                "pt-MZ": {
                                    title: `📧 Email Enviado: ${template}`,
                                    content: [[
                                        { tag: "text", text: `Para: ${validRecipients.join(', ')}\n` },
                                        { tag: "text", text: `Assunto: ${subject || 'N/A'}` }
                                    ]]
                                }
                            }
                        }
                    }),
                    signal: AbortSignal.timeout(5000)
                });
            } catch (larkErr) {
                console.warn('⚠️ Falha ao notificar Lark:', larkErr.message);
            }
        }
        
        return res.status(200).json({ 
            success: true,
            sent: validRecipients.length,
            message: 'Email(s) enviados com sucesso'
        });
        
    } catch (err) {
        console.error('Erro em send-email:', err);
        return res.status(500).json({ 
            error: 'Falha ao enviar email',
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});

// 🟧 SEND WHATSAPP INVOICE
app.post("/api/send-whatsapp-invoice", async (req, res) => {
    try {
        const { orderId, clientName, phone, pdfData, message } = req.body;
        
        if (!orderId || !phone || !pdfData) {
            return res.status(400).json({ error: 'orderId, phone e pdfData são obrigatórios' });
        }

        // Normalizar número de telefone
        let cleanPhone = phone.replace(/\D/g, '');
        if (cleanPhone.length === 9) cleanPhone = '258' + cleanPhone; // Adicionar código Moçambique
        if (!cleanPhone.startsWith('258') || cleanPhone.length !== 12) {
            return res.status(400).json({ error: 'Número de telefone inválido para Moçambique' });
        }

        // Extrair base64 puro do data URL
        const base64Match = pdfData.match(/^data:application\/pdf;base64,(.+)$/);
        const base64Pure = base64Match ? base64Match[1] : pdfData;
        
        if (!base64Pure || base64Pure.length < 100) {
            return res.status(400).json({ error: 'PDF inválido ou muito pequeno' });
        }

        // Mensagem padrão ou customizada
        const defaultMessage = `Olá *${clientName || 'Cliente'}*! 👋\n\n✅ Sua compra foi processada com sucesso!\n\n📄 Segue a fatura do pedido *#${orderId}*.\n\nDúvidas? Estamos à disposição!`;
        const messageText = message || defaultMessage;

        // Enviar via Evolution API
        const evolutionUrl = `${process.env.EVOLUTION_API_URL}/message/sendMedia/${process.env.INSTANCE_NAME}`;
        
        if (!process.env.EVOLUTION_API_URL || !process.env.EVOLUTION_API_KEY) {
            throw new Error('Evolution API não configurada');
        }

        const response = await fetch(evolutionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': process.env.EVOLUTION_API_KEY
            },
            body: JSON.stringify({
                number: cleanPhone,
                options: { 
                    delay: 1200, 
                    presence: 'composing',
                    linkPreview: false
                },
                mediaMessage: {
                    mediatype: 'document',
                    fileName: `Fatura_PayGo_${orderId}.pdf`,
                    caption: messageText,
                    media: base64Pure
                }
            }),
            signal: AbortSignal.timeout(30000)
        });

        const result = await response.json();
        
        if (!response.ok || result?.error) {
            throw new Error(result?.message || result?.error || `HTTP ${response.status}`);
        }

        return res.status(200).json({ 
            success: true, 
            message: 'Fatura enviada via WhatsApp',
            messageId: result?.messageId
        });
        
    } catch (error) {
        console.error('Erro ao enviar WhatsApp:', error);
        return res.status(500).json({ 
            error: 'Falha ao enviar mensagem',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// 🟩 VERIFY EMAIL
app.post("/api/verify-email", async (req, res) => {
    try {
        const { email, name } = req.body;
        
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Email válido é obrigatório' });
        }

        // Gerar link de verificação
        const link = await auth.generateEmailVerificationLink(email);
        const oobCode = new URL(link).searchParams.get('oobCode');
        
        // Link customizado
        const customVerifyLink = `${SITE_URL}/seguranca.html?mode=verifyEmail&oobCode=${oobCode}`;

        // Template de email
        const html = `
            <!DOCTYPE html>
            <html>
            <body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #22c55e;">🛡️ Verifique seu Email</h2>
                <p>Olá ${name || 'Cliente'},</p>
                <p>Quase lá! Clique no botão abaixo para verificar seu email na PayGo:</p>
                <p style="margin: 20px 0;">
                    <a href="${customVerifyLink}" style="background: #22c55e; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">
                        ✅ Verificar Email
                    </a>
                </p>
                <p style="font-size: 12px; color: #666;">
                    Este link expira em 24 horas.
                </p>
            </body>
            </html>
        `;

        if (resend) {
            await resend.emails.send({
                from: FROM_EMAIL,
                to: [email],
                subject: '⚡ Verifique seu Email - PayGo',
                html: html,
                text: `Verifique seu email: ${customVerifyLink}`
            });
        }

        return res.status(200).json({ 
            success: true,
            message: 'Email de verificação enviado'
        });
        
    } catch (error) {
        console.error('Erro em verify-email:', error);
        return res.status(500).json({ 
            error: 'Erro ao enviar email de verificação',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// ==========================================
// 💸 PAYOUTS AUTOMATIZADOS (Admin Only)
// ==========================================
app.post("/api/paysuite-payout", requireAdminAuth, async (req, res) => {
    try {
        const { withdrawalId, targetPhone, targetAmount, targetMethod, reason } = req.body;
        
        // Validações
        if (!withdrawalId || !targetPhone || !targetAmount || !targetMethod) {
            return res.status(400).json({ 
                success: false, 
                error: "Campos obrigatórios: withdrawalId, targetPhone, targetAmount, targetMethod" 
            });
        }

        const finalAmount = parseFloat(targetAmount);
        if (isNaN(finalAmount) || finalAmount < 100 || finalAmount > 50000) {
            return res.status(400).json({ 
                success: false, 
                error: "Valor deve estar entre 100 MT e 50.000 MT" 
            });
        }

        // Buscar dados do saque (se não for manual)
        let withdrawalData = null;
        let previousDataLog = { status: 'pending', amount: finalAmount };
        
        if (withdrawalId !== "MANUAL_PAYOUT") {
            const wDoc = await db.collection("withdrawals").doc(withdrawalId).get();
            if (!wDoc.exists) {
                return res.status(404).json({ success: false, error: "Saque não encontrado" });
            }
            withdrawalData = wDoc.data();
            
            if (withdrawalData.status !== 'pending') {
                return res.status(400).json({ 
                    success: false, 
                    error: `Saque já está com status: ${withdrawalData.status}` 
                });
            }
            previousDataLog = { status: withdrawalData.status, amount: withdrawalData.amount };
        }

        // Normalizar dados para PaySuite
        const cleanPhone = targetPhone.replace(/\D/g, '');
        const method = targetMethod.toLowerCase() === 'emola' ? 'emola' : 'mpesa';
        const reference = withdrawalId === "MANUAL_PAYOUT" 
            ? `MAN-${Date.now().toString().slice(-6)}` 
            : withdrawalId;

        // Payload para PaySuite Payouts
        const payoutPayload = {
            amount: finalAmount,
            phone: cleanPhone,
            method: method,
            reference: reference,
            description: reason || `Payout PayGo - Ref: ${reference}`,
            // Metadados para rastreamento
            metadata: {
                adminId: req.admin.uid,
                adminName: req.admin.name,
                withdrawalId: withdrawalId,
                platform: 'paygo'
            }
        };

        // Fetch com timeout
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000); // 45s para payouts

        let response;
        try {
            response = await fetch('https://paysuite.tech/api/v1/payouts', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${process.env.PAYSUITE_API_KEY}`,
                    'User-Agent': 'PayGo-Payouts/1.0'
                },
                body: JSON.stringify(payoutPayload),
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }

        // Parser seguro
        const textData = await response.text();
        let result;
        
        try {
            result = JSON.parse(textData);
        } catch (e) {
            console.error("❌ PaySuite Payout retornou não-JSON:", textData.substring(0, 200));
            return res.status(502).json({ 
                success: false, 
                error: "Gateway de payouts indisponível" 
            });
        }

        // Validar resposta
        if (!response.ok || result?.status === 'error') {
            // Atualizar saque como falho se aplicável
            if (withdrawalData && withdrawalId !== "MANUAL_PAYOUT") {
                await db.collection("withdrawals").doc(withdrawalId).update({
                    status: 'failed',
                    failureReason: result?.message || 'Falha na comunicação com operadora',
                    updatedAt: Timestamp.now()
                });
            }
            
            return res.status(400).json({ 
                success: false, 
                error: result?.message || "Transferência recusada pela operadora" 
            });
        }

        // Sucesso: Atualizar registro do saque
        if (withdrawalId !== "MANUAL_PAYOUT" && withdrawalData) {
            await db.collection("withdrawals").doc(withdrawalId).update({
                status: 'approved',
                paysuitePayoutId: result.data?.id || `PROC-${Date.now()}`,
                amountPaid: finalAmount,
                phonePaid: cleanPhone,
                methodPaid: method,
                processedAt: Timestamp.now(),
                processedBy: req.admin.uid,
                processedByName: req.admin.name,
                updatedAt: Timestamp.now()
            });
        }

        // Log de auditoria
        await db.collection("admin_audit_logs").add({
            adminId: req.admin.uid,
            adminName: req.admin.name,
            adminRole: req.admin.role,
            action: withdrawalId === "MANUAL_PAYOUT" ? "PAYOUT_MANUAL" : "PAYOUT_AFILIADO",
            targetId: reference,
            targetType: "payout",
            details: {
                previous: previousDataLog,
                updated: { 
                    status: 'approved', 
                    amountPaid: finalAmount, 
                    phone: cleanPhone, 
                    paysuiteId: result.data?.id,
                    method: method
                }
            },
            metadata: {
                ip: req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
                userAgent: req.headers['user-agent']
            },
            createdAt: Timestamp.now()
        });

        return res.status(200).json({ 
            success: true, 
            message: "Transferência executada com sucesso!",
            payoutId: result.data?.id,
            reference: reference
        });

    } catch (err) {
        console.error("💸 Erro crítico em paysuite-payout:", err);
        
        if (err.name === 'AbortError') {
            return res.status(504).json({ 
                success: false, 
                error: "Tempo limite excedido ao processar payout" 
            });
        }
        
        return res.status(500).json({ 
            success: false, 
            error: "Erro interno ao processar payout",
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});

// ==========================================
// 5. FUNÇÕES AUXILIARES DE HTML PARA EMAILS
// ==========================================
function getWhatsAppLink(orderId, name, total, method) {
    const isBankTransfer = String(method||'').toLowerCase().includes('transferencia') || String(method||'').toLowerCase().includes('bank');
    const action = isBankTransfer ? 'enviar o comprovativo' : 'finalizar pedido';
    
    const msg = `*OLÁ PAYGO!* 👋\n\nGostaria de ${action}.\n\n📋 *Dados do Pedido:*\n• ID: #${orderId}\n• Cliente: ${name}\n• Valor: ${total?.toFixed(2) || 'N/A'} MT\n• Método: ${method || 'N/A'}\n\n_Aguardo instruções da equipa._`;
    
    return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;
}

function generateOrderConfirmationHTML(order) {
    const waLink = getWhatsAppLink(order.orderId, order.name, order.total, order.paymentMethod);
    return `
        <!DOCTYPE html>
        <html>
        <body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f8fafc;">
            <div style="background: white; padding: 24px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                <h2 style="color: #2563eb; margin-top: 0;">🛒 Pedido Registado!</h2>
                <p>Olá <strong>${order.name}</strong>,</p>
                <p>Seu pedido <strong>#${order.orderId}</strong> foi registrado com sucesso.</p>
                
                <div style="background: #f1f5f9; padding: 16px; border-radius: 8px; margin: 20px 0;">
                    <p style="margin: 4px 0;"><strong>💰 Total:</strong> ${order.total?.toFixed(2) || 'N/A'} MT</p>
                    <p style="margin: 4px 0;"><strong>💳 Método:</strong> ${order.paymentMethod || 'N/A'}</p>
                    <p style="margin: 4px 0;"><strong>📦 Tipo:</strong> ${order.category === 'game' ? 'Jogo/Serviço' : 'Produto Físico'}</p>
                </div>
                
                <p>Para finalizar, clique no botão abaixo:</p>
                <p style="text-align: center; margin: 24px 0;">
                    <a href="${waLink}" style="background: #25D366; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">
                        💬 Finalizar no WhatsApp
                    </a>
                </p>
                
                <p style="font-size: 12px; color: #666; border-top: 1px solid #eee; padding-top: 16px;">
                    PayGo Moçambique • <a href="${SITE_URL}" style="color: #2563eb;">${SITE_URL}</a>
                </p>
            </div>
        </body>
        </html>
    `;
}

function generatePaymentSuccessHTML(order) {
    return `
        <!DOCTYPE html>
        <html>
        <body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f0fdf4;">
            <div style="background: white; padding: 24px; border-radius: 12px; border-left: 4px solid #22c55e;">
                <h2 style="color: #16a34a; margin-top: 0;">✅ Pagamento Confirmado!</h2>
                <p>Olá <strong>${order.name}</strong>,</p>
                <p>Recebemos seu pagamento de <strong>${order.total?.toFixed(2) || 'N/A'} MT</strong> para o pedido <strong>#${order.orderId}</strong>.</p>
                
                <div style="background: #f0fdf4; padding: 16px; border-radius: 8px; margin: 20px 0; border: 1px solid #bbf7d0;">
                    <p style="margin: 4px 0; color: #166534;">🔄 Seu pedido está sendo processado.</p>
                    <p style="margin: 4px 0; color: #166534;">📧 Você receberá atualizações por email.</p>
                </div>
                
                <p style="font-size: 12px; color: #666;">
                    Dúvidas? <a href="https://wa.me/${WHATSAPP_NUMBER}" style="color: #2563eb;">Fale conosco</a>
                </p>
            </div>
        </body>
        </html>
    `;
}

function generateRefundHTML(order, reason, mediaUrl) {
    return `
        <!DOCTYPE html>
        <html>
        <body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: white; padding: 24px; border-radius: 12px; border-left: 4px solid #a855f7;">
                <h2 style="color: #9333ea; margin-top: 0;">🟣 Reembolso Processado</h2>
                <p>Olá <strong>${order.name}</strong>,</p>
                <p>O valor do pedido <strong>#${order.orderId}</strong> foi devolvido à sua carteira PayGo.</p>
                
                ${reason ? `<p style="background: #faf5ff; padding: 12px; border-radius: 6px; margin: 16px 0;"><strong>Motivo:</strong> ${reason}</p>` : ''}
                
                <p style="font-size: 12px; color: #666;">
                    O saldo já está disponível para uso. <a href="${SITE_URL}/dashboard.html" style="color: #9333ea;">Acessar carteira</a>
                </p>
            </div>
        </body>
        </html>
    `;
}

function generateInsufficientFundsHTML(order, extra, reason) {
    return `
        <!DOCTYPE html>
        <html>
        <body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: white; padding: 24px; border-radius: 12px; border-left: 4px solid #f59e0b;">
                <h2 style="color: #d97706; margin-top: 0;">⚠️ Ação Necessária</h2>
                <p>Olá <strong>${order.name}</strong>,</p>
                <p>Seu pedido <strong>#${order.orderId}</strong> requer atenção:</p>
                
                <div style="background: #fffbeb; padding: 16px; border-radius: 8px; margin: 20px 0; border: 1px solid #fcd34d;">
                    <p style="margin: 4px 0;"><strong>💰 Valor pendente:</strong> ${extra?.toFixed(2) || 'N/A'} MT</p>
                    ${reason ? `<p style="margin: 4px 0;"><strong>📝 Motivo:</strong> ${reason}</p>` : ''}
                </div>
                
                <p style="text-align: center; margin: 24px 0;">
                    <a href="https://wa.me/${WHATSAPP_NUMBER}" style="background: #f59e0b; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">
                        💬 Resolver no WhatsApp
                    </a>
                </p>
            </div>
        </body>
        </html>
    `;
}

function generateOrderCompletedHTML(order) {
    return `
        <!DOCTYPE html>
        <html>
        <body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f0fdf4;">
            <div style="background: white; padding: 24px; border-radius: 12px; border-left: 4px solid #22c55e;">
                <h2 style="color: #16a34a; margin-top: 0;">🎉 Pedido Concluído!</h2>
                <p>Olá <strong>${order.name}</strong>,</p>
                <p>Seu pedido <strong>#${order.orderId}</strong> foi concluído com sucesso!</p>
                
                <div style="background: #f0fdf4; padding: 16px; border-radius: 8px; margin: 20px 0;">
                    <p style="margin: 4px 0;"><strong>✅ Status:</strong> Entregue/Ativado</p>
                    <p style="margin: 4px 0;"><strong>📧 Detalhes:</strong> Verifique seu email ou painel</p>
                </div>
                
                <p style="text-align: center; margin: 24px 0;">
                    <a href="${SITE_URL}/dashboard.html" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">
                        📋 Ver Histórico
                    </a>
                </p>
            </div>
        </body>
        </html>
    `;
}

function generateEmailHTML(template, vars) {
    const templates = {
        'order-completed': generateOrderCompletedHTML,
        'payment-confirmed': generatePaymentSuccessHTML,
        'welcome': (v) => `
            <!DOCTYPE html>
            <html>
            <body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #2563eb;">🚀 Bem-vindo à PayGo!</h2>
                <p>Olá ${v.name || 'Cliente'},</p>
                <p>Sua conta foi criada com sucesso. ${v.affiliate_code ? `Seu código de afiliado: <strong>${v.affiliate_code}</strong>` : ''}</p>
                <p><a href="${SITE_URL}/dashboard.html" style="background: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px;">Acessar Painel</a></p>
            </body>
            </html>
        `,
        'password-reset': (v) => `
            <!DOCTYPE html>
            <html>
            <body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #2563eb;">🔐 Redefinir Senha</h2>
                <p><a href="${v.link}" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px;">Redefinir Senha</a></p>
                <p style="font-size: 12px; color: #666;">Link válido por 1 hora.</p>
            </body>
            </html>
        `
    };
    
    const generator = templates[template];
    if (generator) {
        return generator(vars);
    }
    
    // Fallback genérico
    return `
        <!DOCTYPE html>
        <html>
        <body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2>Notificação PayGo</h2>
            <p>${vars.message || 'Nova atualização na sua conta PayGo.'}</p>
            <p style="font-size: 12px; color: #666; margin-top: 24px;">PayGo Moçambique</p>
        </body>
        </html>
    `;
}

// ==========================================
// 6. INICIALIZAÇÃO DO SERVIDOR
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 PayGo API rodando na porta ${PORT}`);
    console.log(`📍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 URL Base: ${SITE_URL}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🔄 Recebido SIGTERM, encerrando graceful...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('🔄 Recebido SIGINT, encerrando graceful...');
    process.exit(0);
});

// Export para serverless (Vercel, etc.)
module.exports = app;
