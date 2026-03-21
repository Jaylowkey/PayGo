import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// 🛡️ Filtro de Purificação
const purificarDados = (obj) => {
    if (obj === undefined) return null;
    if (typeof obj !== 'object' || obj === null) return obj;
    return JSON.parse(JSON.stringify(obj)); 
};

export default async function handler(req, res) {
    // ✅ Segurança CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

    try {
        // 🔥 INICIALIZAÇÃO BLINDADA (Com correção de Quebras de Linha da Vercel)
        if (!getApps().length) {
            const envVar = process.env.FIREBASE_SERVICE_ACCOUNT;
            
            if (!envVar) {
                console.error("❌ ERRO: FIREBASE_SERVICE_ACCOUNT não existe na Vercel.");
                return res.status(500).json({ error: "FALTA_VARIAVEL_AMBIENTE" });
            }
            
            let serviceAccount;
            try {
                serviceAccount = JSON.parse(envVar);
                // 🚨 O TRUQUE DE MESTRE: Corrigir a chave privada que a Vercel estraga!
                if (serviceAccount.private_key) {
                    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
                }
            } catch (e) {
                console.error("❌ ERRO: JSON inválido.", e.message);
                return res.status(500).json({ error: "JSON_INVALIDO_NA_VERCEL", detalhe: e.message });
            }

            try {
                initializeApp({ credential: cert(serviceAccount) });
            } catch(e) {
                console.error("❌ ERRO: Falha ao iniciar Firebase.", e.message);
                return res.status(500).json({ error: "FALHA_INICIALIZACAO_FIREBASE", detalhe: e.message });
            }
        }

        const db = getFirestore();
        const body = req.body || {};
        const { adminId, adminName, action, targetId, targetType, previousData, newData } = body;

        if (!adminId || !action || !targetId) {
            return res.status(400).json({ error: 'DADOS_INCOMPLETOS' });
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
        return res.status(500).json({ error: "ERRO_DESCONHECIDO", detalhe: err.message });
    }
}
