import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  // CORS Security Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // 🔥 INICIALIZAÇÃO BLINDADA DO FIREBASE ADMIN
    if (!getApps().length) {
        const envVar = process.env.FIREBASE_SERVICE_ACCOUNT;
        
        if (!envVar) {
            return res.status(500).json({ error: "A variável FIREBASE_SERVICE_ACCOUNT não existe na Vercel." });
        }

        let serviceAccount;
        try {
            serviceAccount = JSON.parse(envVar);
            if (serviceAccount.private_key) {
                serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
            }
        } catch (parseError) {
            return res.status(500).json({ error: "O JSON colado na Vercel tem um erro de formatação." });
        }

        initializeApp({ credential: cert(serviceAccount) });
    }

    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email missing' });

    const auth = getAuth();
    
    // 🎯 O TRUQUE DE MESTRE: Forçar o domínio oficial com 'www' cravado na pedra!
    // Ignoramos o VERCEL_URL porque ele usa domínios provisórios que o Firebase bloqueia.
    const baseUrl = 'https://www.paygo.co.mz';
    
    // 1. Firebase Admin gera o Link Oficial e Seguro
    const actionCodeSettings = {
      url: `${baseUrl}/login.html`, // Para onde o cliente volta depois de redefinir
      handleCodeInApp: false
    };
    
    const firebaseLink = await auth.generatePasswordResetLink(email, actionCodeSettings);

    // 2. Extrair o Token do Firebase e injetar no HTML da PayGo
    const urlObj = new URL(firebaseLink);
    const oobCode = urlObj.searchParams.get('oobCode');
    
    const customResetLink = `${baseUrl}/seguranca.html?mode=resetPassword&oobCode=${oobCode}`;

    // 3. Criar o HTML Premium
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; padding: 40px 20px; margin: 0; }
        .container { max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 16px; padding: 32px; box-shadow: 0 4px 20px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; }
        .logo { text-align: center; font-size: 28px; font-weight: 800; color: #0f172a; margin-bottom: 24px; letter-spacing: -1px; }
        .logo span { color: #3b82f6; }
        h2 { color: #0f172a; font-size: 20px; text-align: center; margin-top: 0; }
        p { color: #475569; font-size: 15px; line-height: 1.6; }
        .btn-container { text-align: center; margin: 32px 0; }
        .btn { background: #2563eb; color: #ffffff !important; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: 600; display: inline-block; }
        .footer { text-align: center; font-size: 12px; color: #94a3b8; margin-top: 32px; border-top: 1px solid #e2e8f0; padding-top: 24px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">Pay<span>Go</span></div>
        <h2>Recuperação de Senha 🔐</h2>
        <p>Olá,</p>
        <p>Recebemos um pedido para redefinir a palavra-passe da sua conta PayGo associada a este e-mail. Clique no botão abaixo para criar uma nova senha de forma segura e exclusiva.</p>
        
        <div class="btn-container">
          <a href="${customResetLink}" class="btn">Redefinir Palavra-passe</a>
        </div>
        
        <p style="font-size: 13px;">Se o botão não funcionar, copie e cole o seguinte link no seu navegador:<br><br><span style="word-break: break-all; color: #3b82f6;">${customResetLink}</span></p>
        
        <div class="footer">
          <p>Se não solicitou esta alteração, por favor ignore este e-mail. A sua conta permanecerá segura.</p>
          <p>PayGo Moçambique &copy; ${new Date().getFullYear()}</p>
        </div>
      </div>
    </body>
    </html>
    `;

    // 4. Enviar via Resend
    await resend.emails.send({
      from: 'PayGo Moçambique <noreply@paygo.co.mz>',
      to: email,
      subject: '🔐 Recuperação de Senha - PayGo',
      html: html
    });

    return res.status(200).json({ success: true, message: 'Link de segurança enviado.' });

  } catch (error) {
    console.error('❌ Erro na recuperação de senha:', error);
    
    if (error.code === 'auth/user-not-found') {
        return res.status(200).json({ success: true }); 
    }
    
    return res.status(500).json({ error: error.message });
  }
}
