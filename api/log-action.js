import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export default async function handler(req, res) {
  // ✅ CORS Security Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // 🔥 INICIALIZAÇÃO BLINDADA DO FIREBASE ADMIN (Idêntica à tua API Oficial)
    if (!getApps().length) {
        if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
            console.error("❌ ERRO CRÍTICO: FIREBASE_SERVICE_ACCOUNT não encontrada nas variáveis da Vercel.");
            return res.status(500).json({ error: "Erro de configuração no servidor." });
        }

        let serviceAccount;
        try {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        } catch (parseError) {
            console.error("❌ ERRO CRÍTICO: O formato do FIREBASE_SERVICE_ACCOUNT é inválido.");
            return res.status(500).json({ error: "Chave do servidor corrompida." });
        }

        initializeApp({
            credential: cert(serviceAccount)
        });
    }

    const db = getFirestore();
    const { adminId, adminName, action, targetId, targetType, previousData, newData } = req.body;

    // 🛡️ Validação de Segurança
    if (!adminId || !action || !targetId) {
        return res.status(400).json({ error: 'Faltam dados obrigatórios para auditar a ação.' });
    }

    const logRef = db.collection('admin_audit_logs').doc();

    // 📝 Gravação do Registo Forense
    await logRef.set({
        adminId: adminId,
        adminName: adminName || 'Admin Oculto',
        action: action, 
        targetId: targetId, 
        targetType: targetType || 'unknown', 
        details: {
            previous: previousData || null,
            updated: newData || null
        },
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'IP Oculto',
        createdAt: new Date().toISOString()
    });

    console.log(`🔒 [AUDITORIA] Ação '${action}' registada com sucesso.`);
    return res.status(200).json({ success: true, logId: logRef.id });

  } catch (err) {
      console.error('❌ Falha ao registar log de auditoria:', err);
      return res.status(500).json({ error: err.message });
  }
}
