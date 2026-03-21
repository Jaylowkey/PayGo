const admin = require('firebase-admin');

// 🔥 Inicialização Blindada e Universal
if (!admin.apps.length) {
    try {
        if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
            console.error("❌ ERRO: A variável FIREBASE_SERVICE_ACCOUNT não está configurada na Vercel.");
        } else {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log("✅ Firebase Admin inicializado com sucesso.");
        }
    } catch (error) {
        console.error("❌ ERRO CRÍTICO: O formato do JSON da Service Account é inválido.", error);
    }
}

// Filtro de sujidade para o Firebase não dar crash
const purificarDados = (obj) => {
    if (obj === undefined) return null;
    if (typeof obj !== 'object' || obj === null) return obj;
    return JSON.parse(JSON.stringify(obj)); 
};

module.exports = async function handler(req, res) {
    // ✅ CORS Security Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

    try {
        // Verifica se a chave foi carregada com sucesso
        if (!admin.apps.length) {
            return res.status(500).json({ error: 'Firebase Admin não inicializou. Verifique a variável FIREBASE_SERVICE_ACCOUNT na Vercel.' });
        }

        const db = admin.firestore();
        const body = req.body || {};
        
        const { adminId, adminName, action, targetId, targetType, previousData, newData } = body;

        if (!adminId || !action || !targetId) {
            return res.status(400).json({ error: 'Faltam dados obrigatórios para auditar a ação.' });
        }

        // 📝 Estruturação Cirúrgica do Log
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
        console.error('🔥 Erro Crítico na API log-action:', err);
        return res.status(500).json({ error: err.message, stack: err.stack });
    }
};
