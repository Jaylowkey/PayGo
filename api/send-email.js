// api/send-email.js
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  // ✅ Apenas POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { to, subject, template, variables } = req.body;

    // ✅ Validações básicas
    if (!to || !subject || !template) {
      return res.status(400).json({ 
        error: 'Missing required fields: to, subject, template' 
      });
    }

    // ✅ Gerar HTML baseado no template
    const html = generateEmailHTML(template, variables);
    const text = generateEmailText(template, variables);

    // ✅ Enviar email via Resend
    const { data, error } = await resend.emails.send({
      from: `PayGo <noreply@paygo.co.mz>`,
      to: [to],
      subject: subject,
      html: html,
      text: text,
      headers: {
        'X-PayGo-Template': template,
        'X-PayGo-Version': '1.0'
      }
    });

    if (error) {
      console.error('❌ Resend error:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log('✅ Email sent:', data);
    return res.status(200).json({ 
      success: true, 
      data: data,
      message: 'Email enviado com sucesso'
    });

  } catch (err) {
    console.error('❌ Send email error:', err);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: err.message 
    });
  }
}

// ✅ Gerador de HTML para templates
function generateEmailHTML(template, vars) {
  const baseStyles = `
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; padding: 20px; margin: 0; }
      .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
      .header { background: linear-gradient(135deg, #3b82f6, #06b6d4); padding: 24px; text-align: center; }
      .header h1 { color: #fff; margin: 0; font-size: 24px; }
      .content { padding: 32px; color: #334155; line-height: 1.6; }
      .button { display: inline-block; background: #3b82f6; color: #fff; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-weight: 600; margin: 20px 0; }
      .footer { background: #f8fafc; padding: 20px; text-align: center; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 12px; }
      .alert { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; margin: 16px 0; border-radius: 0 8px 8px 0; }
    </style>
  `;

  switch (template) {
    case 'password-reset':
      return `<!DOCTYPE html><html><head><meta charset="UTF-8">${baseStyles}</head><body>
        <div class="container">
          <div class="header"><h1>PayGo</h1><p>🔐 Recuperação de Senha</p></div>
          <div class="content">
            <p>Olá <strong>${vars.customer_name || 'Cliente'}</strong>,</p>
            <p>Recebemos uma solicitação para redefinir a senha da sua conta PayGo.</p>
            <div style="text-align:center">
              <a href="${vars.reset_link || '#'}" class="button">Redefinir Senha</a>
            </div>
            <p class="alert">⚠️ Este link expira em <strong>1 hora</strong>.</p>
            <p>Se você não solicitou esta alteração, ignore este email.</p>
          </div>
          <div class="footer">&copy; 2026 PayGo Moçambique. Todos direitos reservados.</div>
        </div>
      </body></html>`;

    case 'order-confirmation':
      return `<!DOCTYPE html><html><head><meta charset="UTF-8">${baseStyles}</head><body>
        <div class="container">
          <div class="header"><h1>PayGo</h1><p>✅ Pedido Confirmado</p></div>
          <div class="content">
            <p>Olá <strong>${vars.customer_name || 'Cliente'}</strong>,</p>
            <p>Seu pedido foi registrado com sucesso!</p>
            <table style="width:100%; border-collapse: collapse; margin: 20px 0;">
              <tr><td style="padding:8px 0; border-bottom:1px solid #e2e8f0"><strong>ID do Pedido:</strong></td><td style="padding:8px 0; border-bottom:1px solid #e2e8f0">${vars.order_id || 'N/A'}</td></tr>
              <tr><td style="padding:8px 0; border-bottom:1px solid #e2e8f0"><strong>Valor Total:</strong></td><td style="padding:8px 0; border-bottom:1px solid #e2e8f0">${vars.total_amount || 'N/A'}</td></tr>
              <tr><td style="padding:8px 0"><strong>Pagamento:</strong></td><td style="padding:8px 0">${vars.payment_method || 'N/A'}</td></tr>
            </table>
            <p>Receberá atualizações via WhatsApp e email.</p>
            <p><a href="${vars.dashboard_link || '#'}" class="button">Ver no Dashboard</a></p>
          </div>
          <div class="footer">&copy; 2026 PayGo Moçambique.</div>
        </div>
      </body></html>`;

    case 'affiliate-approved':
      return `<!DOCTYPE html><html><head><meta charset="UTF-8">${baseStyles}</head><body>
        <div class="container">
          <div class="header" style="background:linear-gradient(135deg,#22c55e,#16a34a)"><h1>PayGo</h1><p>🎉 Afiliado Aprovado!</p></div>
          <div class="content">
            <p>Olá <strong>${vars.customer_name || 'Cliente'}</strong>,</p>
            <p>Parabéns! Sua candidatura ao programa de afiliados foi <strong>aprovada</strong>.</p>
            <div style="background:#f0fdf4; padding:16px; border-radius:8px; margin:20px 0;">
              <p style="margin:0"><strong>Seu Código de Afiliado:</strong></p>
              <p style="margin:8px 0 0; font-size:18px; font-weight:bold; color:#22c55e">${vars.affiliate_code || 'N/A'}</p>
            </div>
            <p><strong>Comissão:</strong> 3% na primeira compra de cada indicado</p>
            <p><a href="${vars.dashboard_link || '#'}" class="button">Acessar Dashboard</a></p>
          </div>
          <div class="footer">&copy; 2026 PayGo Moçambique.</div>
        </div>
      </body></html>`;

    default:
      return `<!DOCTYPE html><html><head><meta charset="UTF-8">${baseStyles}</head><body>
        <div class="container">
          <div class="header"><h1>PayGo</h1></div>
          <div class="content"><p>${vars.message || 'Notificação PayGo'}</p></div>
          <div class="footer">&copy; 2026 PayGo Moçambique.</div>
        </div>
      </body></html>`;
  }
}

// ✅ Versão texto simples (fallback)
function generateEmailText(template, vars) {
  switch (template) {
    case 'password-reset':
      return `Olá ${vars.customer_name || 'Cliente'},\n\nRecebemos uma solicitação para redefinir sua senha.\n\nClique aqui: ${vars.reset_link || '#'}\n\nEste link expira em 1 hora.\n\n© 2026 PayGo Moçambique`;
    case 'order-confirmation':
      return `Olá ${vars.customer_name || 'Cliente'},\n\nSeu pedido foi registrado!\n\nID: ${vars.order_id}\nTotal: ${vars.total_amount}\n\n© 2026 PayGo Moçambique`;
    case 'affiliate-approved':
      return `Olá ${vars.customer_name || 'Cliente'},\n\nParabéns! Sua candidatura de afiliado foi aprovada.\n\nCódigo: ${vars.affiliate_code}\n\n© 2026 PayGo Moçambique`;
    default:
      return vars.message || 'PayGo Notification';
  }
}