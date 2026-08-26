import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { Resend } from 'resend';

const SITE_URL = (process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://paygo.co.mz').replace(/\/+$/, '');
const FROM_EMAIL = process.env.FROM_EMAIL || 'PayGo Moçambique <noreply@paygo.co.mz>';

function getFirebaseAuth() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT em falta.');
    const serviceAccount = JSON.parse(raw);
    if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getAuth(getApps()[0]);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function buildEmailHtml(resetLink) {
  const safeLink = escapeHtml(resetLink);
  return `<!doctype html><html lang="pt-MZ"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;color:#0f172a"><div style="max-width:620px;margin:30px auto;padding:0 16px"><div style="background:#fff;border:1px solid #e5eaf1;border-radius:24px;overflow:hidden;box-shadow:0 18px 45px rgba(15,23,42,.10)"><div style="background:linear-gradient(135deg,#06142e,#2563eb);padding:30px;text-align:center;color:#fff"><div style="font-size:25px;font-weight:800">⚡ PayGo</div><div style="margin-top:6px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#bfdbfe">Segurança da conta</div></div><div style="padding:30px"><h1 style="font-size:24px;margin:0 0 12px">Recuperar palavra-passe</h1><p style="font-size:15px;line-height:1.7;color:#64748b">Recebemos um pedido para redefinir a palavra-passe da sua conta PayGo. Se foi você, use o botão abaixo.</p><div style="text-align:center;margin:28px 0"><a href="${safeLink}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:14px 24px;border-radius:12px;font-weight:700">Redefinir palavra-passe</a></div><div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:14px;font-size:12px;color:#64748b;line-height:1.6">Por segurança, este link é temporário e só pode ser usado uma vez. Se não solicitou esta alteração, ignore este email.</div><p style="font-size:12px;color:#94a3b8;margin-top:24px">PayGo Moçambique · Segurança da conta</p></div></div></div></body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Email inválido.' });
    }

    const auth = getFirebaseAuth();
    // Firebase gera o token de recuperação no servidor; o token nunca é exposto à API cliente.
    const firebaseLink = await auth.generatePasswordResetLink(email);
    const url = new URL(firebaseLink);
    const oobCode = url.searchParams.get('oobCode');
    if (!oobCode) throw new Error('Firebase não devolveu o token de recuperação.');

    // A página PayGo processa o token e mantém a experiência de marca.
    const resetLink = `${SITE_URL}/seguranca.html?mode=resetPassword&oobCode=${encodeURIComponent(oobCode)}`;
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY em falta.');

    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: '🔐 Recuperação de palavra-passe — PayGo',
      html: buildEmailHtml(resetLink),
    });

    if (result?.error) {
      console.error('[recover-password] Resend error:', result.error);
      return res.status(502).json({ success: false, error: 'Não foi possível enviar o email de recuperação.' });
    }

    return res.status(200).json({ success: true, message: 'Link de recuperação enviado.' });
  } catch (error) {
    console.error('[recover-password] error:', error);
    // Não revelar se o email existe para evitar enumeração de contas.
    return res.status(500).json({ success: false, error: 'Não foi possível processar a recuperação agora. Tente novamente.' });
  }
}
