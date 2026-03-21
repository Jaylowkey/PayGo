import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  // ✅ Defesas CORS e Cabeçalhos
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  try {
    // 🔥 INICIALIZAÇÃO BLINDADA DO FIREBASE (Com a nossa vacina anti-Vercel)
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
            return res.status(500).json({ error: "O JSON na Vercel está mal formatado." });
        }
        initializeApp({ credential: cert(serviceAccount) });
    }

    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: 'Email não fornecido.' });

    const auth = getAuth();
    const baseUrl = 'https://www.paygo.co.mz';
    
    // 🎯 1. Gerar o Link de Verificação do Firebase
    const firebaseLink = await auth.generateEmailVerificationLink(email);

    // 🕵️‍♂️ 2. Extrair o Token (oobCode) para o nosso Domínio Oficial
    const urlObj = new URL(firebaseLink);
    const oobCode = urlObj.searchParams.get('oobCode');
    const customVerifyLink = `${baseUrl}/seguranca.html?mode=verifyEmail&oobCode=${oobCode}`;

    // 🎨 3. Construir o HTML do E-mail (Premium & Responsivo)
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; padding: 40px 20px; margin: 0; }
        .container { max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 16px; padding: 32px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; }
        .logo { text-align: center; font-size: 28px; font-weight: 800; color: #0f172a; margin-bottom: 24px; letter-spacing: -1px; }
        .logo span { color: #3b82f6; }
        h2 { color: #0f172a; font-size: 22px; text-align: center; margin-top: 0; }
        p { color: #475569; font-size: 15px; line-height: 1.6; text-align: center; }
        .btn-container { text-align: center; margin: 32px 0; }
        .btn { background: #22c55e; color: #ffffff !important; padding: 14px 32px; text-decoration: none; border-radius: 12px; font-weight: 700; font-size: 16px; display: inline-block; box-shadow: 0 4px 15px rgba(34, 197, 94, 0.3); }
        .footer { text-align: center; font-size: 12px; color: #94a3b8; margin-top: 32px; border-top: 1px solid #e2e8f0; padding-top: 24px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">Pay<span>Go</span></div>
        <h2>Bem-vindo à Revolução! 🚀</h2>
        <p>Olá <strong>${name ? name : 'Parceiro'}</strong>,</p>
        <p>Falta apenas um pequeno passo para desbloquear todo o poder da sua nova conta PayGo. Por favor, confirme o seu endereço de e-mail clicando no botão abaixo:</p>
        
        <div class="btn-container">
          <a href="${customVerifyLink}" class="btn">Verificar Meu E-mail</a>
        </div>
        
        <p style="font-size: 13px;">Se o botão não funcionar, copie este link para o navegador:<br><br><span style="word-break: break-all; color: #3b82f6;">${customVerifyLink}</span></p>
        
        <div class="footer">
          <p>Se você não criou esta conta, pode ignorar este e-mail em segurança.</p>
          <p>PayGo Moçambique &copy; ${new Date().getFullYear()}</p>
        </div>
      </div>
    </body>
    </html>
    `;

    // 🚀 4. Disparar via Resend
    await resend.emails.send({
      from: 'PayGo Moçambique <noreply@paygo.co.mz>',
      to: email,
      subject: '⚡ Verifique a sua conta PayGo',
      html: html
    });

    return res.status(200).json({ success: true, message: 'Email de verificação enviado.' });

  } catch (error) {
    console.error('❌ Erro ao enviar verificação:', error);
    return res.status(500).json({ error: error.message });
  }
}
