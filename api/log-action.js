import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// 🛡️ Filtro de Purificação: O Firebase ODEIA valores 'undefined' e crasha. Isto limpa a sujidade toda.
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
        // 🔥 INICIALIZAÇÃO BLINDADA DO FIREBASE ADMIN
        if (!getApps().length) {
            if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
                console.error("❌ ERRO: FIREBASE_SERVICE_ACCOUNT em falta.");
                return res.status(500).json({ error: "Configuração de servidor em falta." });
            }
            
            let serviceAccount;
            try {
                serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            } catch (e) {
                console.error("❌ ERRO: FIREBASE_SERVICE_ACCOUNT inválido.");
                return res.status(500).json({ error: "Chave do servidor corrompida." });
            }

            initializeApp({ credential: cert(serviceAccount) });
        }

        const db = getFirestore();
        const body = req.body || {};
        
        const { adminId, adminName, action, targetId, targetType, previousData, newData } = body;

        // Validação mínima de segurança
        if (!adminId || !action || !targetId) {
            return res.status(400).json({ error: 'Dados obrigatórios em falta para auditoria.' });
        }

        // 📝 Estruturação Cirúrgica do Log
        const logData = {
            adminId: String(adminId),
            adminName: adminName ? String(adminName) : 'Admin Oculto',
            action: String(action), 
            targetId: String(targetId), 
            targetType: targetType ? String(targetType) : 'order', 
            details: {
                // Passamos os dados pelo purificador antes de gravar!
                previous: purificarDados(previousData),
                updated: purificarDados(newData)
            },
            ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'Desconhecido',
            createdAt: new Date().toISOString()
        };

        // Gravar no cofre da Caixa Negra
        const logRef = await db.collection('admin_audit_logs').add(logData);

        return res.status(200).json({ success: true, logId: logRef.id });

    } catch (err) {
        console.error('🔥 Erro Crítico na API log-action:', err);
        // Ao enviar o err.message, conseguimos ver nos "Network Tabs" exatamente o que falhou!
        return res.status(500).json({ error: err.message, stack: err.stack });
    }
}
