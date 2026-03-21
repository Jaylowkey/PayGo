import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export default async function handler(req, res) {
    // ✅ Segurança CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

    try {
        // 🔥 INICIALIZAÇÃO BLINDADA
        if (!getApps().length) {
            const envVar = process.env.FIREBASE_SERVICE_ACCOUNT;
            if (!envVar) return res.status(500).json({ error: "Falta FIREBASE_SERVICE_ACCOUNT na Vercel." });

            let serviceAccount;
            try {
                serviceAccount = JSON.parse(envVar);
                if (serviceAccount.private_key) {
                    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
                }
            } catch (e) {
                return res.status(500).json({ error: "O JSON colado na Vercel está corrompido." });
            }
            initializeApp({ credential: cert(serviceAccount) });
        }

        const db = getFirestore("paygodb");
        
        // 🛡️ Vacina da Vercel: Garantir que o body é lido como objeto JSON
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (e) { body = {}; }
        }

        const { affiliateCode } = body || {};

        if (!affiliateCode) {
            return res.status(400).json({ error: 'Código de afiliado não fornecido pelo painel.' });
        }

        // 🎯 BUSCA SEGURA E FILTRADA
        const qUsers = await db.collection("users").where("referredBy", "==", affiliateCode).get();
        
        const referrals = [];
        qUsers.forEach(doc => {
            const data = doc.data();
            
            // 🚀 CORREÇÃO CRÍTICA: Lidar com datas em formato String ou Timestamp do Firebase!
            let dateStr = null;
            if (data.createdAt) {
                // Se for um Timestamp nativo do Firebase (tem a função toDate)
                if (typeof data.createdAt.toDate === 'function') {
                    dateStr = data.createdAt.toDate().toISOString();
                } 
                // Se já for uma String ou um Date normal
                else {
                    dateStr = new Date(data.createdAt).toISOString();
                }
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
        console.error('🔥 Erro na API get-referrals:', err);
        // O Erro 500 volta detalhado para sabermos exatamente o que partiu
        return res.status(500).json({ error: err.message });
    }
}
