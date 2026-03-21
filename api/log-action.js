import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// 🛡️ Filtro de Purificação
const purificarDados = (obj) => {
    if (obj === undefined) return null;
    if (typeof obj !== 'object' || obj === null) return obj;
    return JSON.parse(JSON.stringify(obj)); 
};

export default async function handler(req, res) {
    // ✅ CORS Security Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

    try {
        // 🔥 INICIALIZAÇÃO BLINDADA
        if (!getApps().length) {
            const envVar = process.env.FIREBASE_SERVICE_ACCOUNT;
            if (!envVar) throw new Error("A variável FIREBASE_SERVICE_ACCOUNT não existe na Vercel.");

            let serviceAccount = JSON.parse(envVar);
            if (serviceAccount.private_key) {
                serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
            }
            initializeApp({ credential: cert(serviceAccount) });
        }

        const db = getFirestore();
        
        // 🚨 A VACINA DA VERCEL: Se a Vercel entregar o body como Texto em vez de Objeto, nós forçamos a conversão!
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (e) { throw new Error("O servidor recebeu dados corrompidos do navegador."); }
        }

        const { adminId, adminName, action, targetId, targetType, previousData, newData } = body || {};

        if (!adminId || !action || !targetId) {
            return res.status(400).json({ error: 'DADOS_INCOMPLETOS', dados_recebidos: body });
        }

        // 📝 Estruturação do Log
        const logData = {
            adminId: String(adminId),
            adminName: adminName ? String(adminName) : 'Admin Oculto',
            action: String(action), 
            targetId: String(targetId), 
            targetType: targetType ? String(targetType) : 'order', 
            details: {
                previous: purificarDados(previousData),
                updated: purificarDados(newData)
            },
            ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'Desconhecido',
            createdAt: new Date().toISOString()
        };

        const logRef = await db.collection('admin_audit_logs').add(logData);
        return res.status(200).json({ success: true, logId: logRef.id });

    } catch (err) {
        console.error('🔥 Erro Crítico:', err);
        // Devolvemos o erro detalhado para a aba Network!
        return res.status(500).json({ error: err.message });
    }
}
