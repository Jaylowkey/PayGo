// api/log-action.js
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
        console.error("FIREBASE_SERVICE_ACCOUNT em falta.");
    } else {
        try { initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }); } 
        catch (e) { console.error("Chave do Firebase inválida."); }
    }
}

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { adminId, adminName, action, targetId, targetType, previousData, newData } = req.body;

        // Validação mínima para não encher a DB de lixo
        if (!adminId || !action || !targetId) {
            return res.status(400).json({ error: 'Faltam dados obrigatórios para auditar a ação.' });
        }

        const db = getFirestore();
        const logRef = db.collection('admin_audit_logs').doc();

        await logRef.set({
            adminId: adminId,
            adminName: adminName || 'Admin Oculto',
            action: action, // Ex: 'UPDATE_ORDER', 'DELETE_USER', 'CHANGE_EXCHANGE_RATE'
            targetId: targetId, // Ex: ID do Pedido ou ID do Usuário
            targetType: targetType || 'unknown', // Ex: 'order', 'user', 'settings'
            details: {
                previous: previousData || null,
                updated: newData || null
            },
            ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
            createdAt: new Date().toISOString()
        });

        return res.status(200).json({ success: true, logId: logRef.id });

    } catch (err) {
        console.error('Falha ao registar log de auditoria interna:', err);
        return res.status(500).json({ error: 'Erro interno na gravação do log.' });
    }
}
