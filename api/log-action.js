// api/log-action.js
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// ✅ Inicialização Segura do Firebase Admin (Prevenção de Crashes na Vercel)
if (!getApps().length) {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
        console.error("❌ ERRO CRÍTICO: FIREBASE_SERVICE_ACCOUNT em falta nas variáveis de ambiente.");
    } else {
        try {
            initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
        } catch (e) {
            console.error("❌ ERRO CRÍTICO: Formato inválido na chave do Firebase.");
        }
    }
}

export default async function handler(req, res) {
    // ✅ Segurança CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

    try {
        const { adminId, adminName, action, targetId, targetType, previousData, newData } = req.body;

        // 🛡️ Validação mínima para não encher a DB de lixo (Prevenção de Spam)
        if (!adminId || !action || !targetId) {
            return res.status(400).json({ error: 'Faltam dados obrigatórios para auditar a ação.' });
        }

        const db = getFirestore();
        const logRef = db.collection('admin_audit_logs').doc();

        // 📝 Estrutura do Registo Forense
        await logRef.set({
            adminId: adminId,
            adminName: adminName || 'Admin Oculto',
            action: action, // Ex: 'UPDATE_ORDER_STATUS', 'DELETE_ORDER'
            targetId: targetId, // Ex: ID do Pedido
            targetType: targetType || 'unknown', // Ex: 'order', 'user'
            details: {
                previous: previousData || null,
                updated: newData || null
            },
            ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'IP Oculto',
            createdAt: new Date().toISOString()
        });

        console.log(`🔒 [AUDITORIA] Ação '${action}' de ${adminName} registada com sucesso.`);
        return res.status(200).json({ success: true, logId: logRef.id });

    } catch (err) {
        console.error('❌ Falha ao registar log de auditoria interna:', err);
        return res.status(500).json({ error: 'Erro interno na gravação do log.' });
    }
}
