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
        const { affiliateCode } = req.body;

        if (!affiliateCode) {
            return res.status(400).json({ error: 'Código de afiliado não fornecido.' });
        }

        // 🎯 BUSCA SEGURA E FILTRADA (O Firebase Admin ignora as regras do lado do cliente)
        const qUsers = await db.collection("users").where("referredBy", "==", affiliateCode).get();
        
        const referrals = [];
        qUsers.forEach(doc => {
            const data = doc.data();
            referrals.push({
                id: doc.id,
                name: data.name || 'Cliente PayGo',
                email: data.email || '', // O Front-End vai mascarar o e-mail
                status: data.status || 'pending',
                emailVerified: data.emailVerified || false,
                firstPurchaseProcessed: data.firstPurchaseProcessed || false,
                createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
            });
        });

        return res.status(200).json({ success: true, referrals });

    } catch (err) {
        console.error('🔥 Erro na API get-referrals:', err);
        return res.status(500).json({ error: err.message });
    }
}
