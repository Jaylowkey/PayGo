// api/delete-user.js
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Inicialização Segura do Admin
    if (!getApps().length) {
        if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
            throw new Error("FIREBASE_SERVICE_ACCOUNT em falta.");
        }
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }

    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'UID do utilizador não fornecido' });

    // 1. Tentar apagar da Autenticação (Firebase Auth)
    try {
        await getAuth().deleteUser(uid);
        console.log(`✅ [delete-user] Conta Auth apagada: ${uid}`);
    } catch (authErr) {
        // Se o utilizador já não existir no Auth (já é um fantasma), ignoramos o erro e avançamos
        console.warn(`⚠️ [delete-user] Utilizador não encontrado no Auth, a prosseguir limpeza da BD...`);
    }

    // 2. Apagar da Base de Dados (Firestore)
    const db = getFirestore();
    await db.collection('users').doc(uid).delete();
    console.log(`✅ [delete-user] Documento Firestore apagado: ${uid}`);

    return res.status(200).json({ success: true, message: 'Utilizador erradicado com sucesso.' });

  } catch (error) {
    console.error('❌ Erro crítico ao apagar utilizador:', error);
    return res.status(500).json({ error: error.message });
  }
}
