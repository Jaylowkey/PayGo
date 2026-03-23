// api/p2p-transfer.js
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

    try {
        const { senderId, receiverEmail, amount } = req.body;
        const transferAmount = parseFloat(amount);

        if (!senderId || !receiverEmail || isNaN(transferAmount) || transferAmount <= 0) {
            return res.status(400).json({ error: 'Dados inválidos para transferência.' });
        }

        // Inicializa o Firebase no servidor
        if (!getApps().length) {
            const envVar = process.env.FIREBASE_SERVICE_ACCOUNT;
            if (!envVar) throw new Error("Chave Firebase em falta na Vercel");
            let serviceAccount = JSON.parse(envVar);
            if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
            initializeApp({ credential: cert(serviceAccount) });
        }

        const db = getFirestore("paygodb");
        const agora = new Date().toISOString();

        // 1. Procurar o Destinatário pelo E-mail
        const usersRef = db.collection('users');
        const receiverSnap = await usersRef.where('email', '==', receiverEmail).get();
        
        if (receiverSnap.empty) {
            return res.status(404).json({ error: 'Atenção: Nenhum cliente PayGo encontrado com este e-mail.' });
        }

        const receiverDoc = receiverSnap.docs[0];
        const receiverId = receiverDoc.id;

        if (senderId === receiverId) {
            return res.status(400).json({ error: 'Não pode enviar dinheiro para si mesmo.' });
        }

        // 2. Verificar Saldo do Remetente
        const senderRef = usersRef.doc(senderId);
        const senderDoc = await senderRef.get();
        const senderBalance = parseFloat(senderDoc.data().walletBalance) || 0;

        if (senderBalance < transferAmount) {
            return res.status(400).json({ error: 'Saldo insuficiente para cobrir esta transferência.' });
        }

        // 3. TRANSFERÊNCIA ATÓMICA (Tira de um, põe no outro)
        const batch = db.batch();
        batch.update(senderRef, { walletBalance: FieldValue.increment(-transferAmount) });
        batch.update(receiverDoc.ref, { walletBalance: FieldValue.increment(transferAmount) });

        // 4. Extratos Bancários
        const txRefSender = db.collection('wallet_transactions').doc();
        batch.set(txRefSender, { userId: senderId, type: 'debit', amount: transferAmount, description: `Transferência para ${receiverEmail}`, reference: 'P2P', createdAt: agora });

        const txRefReceiver = db.collection('wallet_transactions').doc();
        batch.set(txRefReceiver, { userId: receiverId, type: 'credit', amount: transferAmount, description: `Recebido de ${senderDoc.data().email}`, reference: 'P2P', createdAt: agora });

        // Executa tudo ao mesmo tempo!
        await batch.commit();

        return res.status(200).json({ success: true });

    } catch (err) {
        console.error('Erro no P2P:', err);
        return res.status(500).json({ error: 'Falha interna no servidor.' });
    }
}
