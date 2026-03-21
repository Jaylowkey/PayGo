import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// 🛡️ Filtro de Purificação: Impede que o Firebase crashe com valores 'undefined'
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
        // 🔥 INICIALIZAÇÃO BLINDADA (A mesma vacina que curou a Recuperação de Senha)
        if (!getApps().length) {
            const envVar = process.env.FIREBASE_SERVICE_ACCOUNT;
            
            if (!envVar) {
                return res.status(500).json({ error: "A variável FIREBASE_SERVICE_ACCOUNT não existe na Vercel." });
            }

            let serviceAccount;
            try {
                serviceAccount = JSON.parse(envVar);
                // O TRUQUE DE MESTRE: Corrige a chave privada que a Vercel desformata
                if (serviceAccount.private_key) {
                    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
                }
            } catch (parseError) {
                return res.status(500).json({ error: "O JSON colado na Vercel tem um erro de formatação." });
            }

            initializeApp({ credential: cert(serviceAccount) });
        }

        const db = getFirestore();
        const body = req.body || {};
        
        const { adminId, adminName, action, targetId, targetType, previousData, newData } = body;

        // Validação de Segurança
        if (!adminId || !action || !targetId) {
            return res.status(400).json({ error: 'Dados obrigatórios em falta para registar a auditoria.' });
        }

        // 📝 Estruturação da Caixa Negra
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

        // Gravar no cofre da Firebase
        const logRef = await db.collection('admin_audit_logs').add(logData);

        return res.status(200).json({ success: true, logId: logRef.id });

    } catch (err) {
        console.error('🔥 Erro Crítico na API log-action:', err);
        // Retornamos o erro exato para ver na consola se algo falhar
        return res.status(500).json({ error: err.message });
    }
}
