// api/notify-order.js
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { orderData, sendEmail = true, sendLark = true } = req.body;
    const results = { email: null, lark: null };

    // ✅ 1. Enviar Email ao Cliente (opcional)
    if (sendEmail && orderData.email) {
      try {
        const { data, error } = await resend.emails.send({
          from: `PayGo <noreply@paygo.co.mz>`,
          to: [orderData.email],
          subject: `✅ Pedido ${orderData.orderId} Confirmado - PayGo`,
          html: generateOrderConfirmationHTML(orderData),
          text: generateOrderConfirmationText(orderData)
        });

        if (error) {
          console.error('❌ Email error:', error);
          results.email = { success: false, error: error.message };
        } else {
          console.log('✅ Email sent:', data);
          results.email = { success: true, data };
        }
      } catch (err) {
        console.error('❌ Email exception:', err);
        results.email = { success: false, error: err.message };
      }
    }

    // ✅ 2. Enviar Notificação Lark para Admin (opcional)
    if (sendLark && process.env.LARK_WEBHOOK_URL) {
      try {
        const larkPayload = {
          msg_type: "interactive",
          card: {
            config: { wide_screen_mode: true },
            header: {
              template: "blue",
              title: { content: "🛒 Novo Pedido PayGo", tag: "plain_text" }
            },
            elements: [
              {
                tag: "div",
                fields: [
                  { is_short: true, text: { tag: "lark_md", content: `**ID:**\n${orderData.orderId}` }},
                  { is_short: true, text: { tag: "lark_md", content: `**Cliente:**\n${orderData.name}` }},
                  { is_short: true, text: { tag: "lark_md", content: `**Total:**\n${orderData.total} MT` }},
                  { is_short: true, text: { tag: "lark_md", content: `**WhatsApp:**\n${orderData.whatsapp}` }},
                  { is_short: false, text: { tag: "lark_md", content: `**Email:**\n${orderData.email}` }}
                ]
              },
              {
                tag: "action",
                actions: [
                  {
                    tag: "button",
                    text: { tag: "plain_text", content: "Ver no Admin" },
                    type: "primary",
                    url: `${process.env.SITE_URL || 'https://paygo.co.mz'}/admin.html`
                  }
                ]
              }
            ]
          }
        };

        const response = await fetch(process.env.LARK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(larkPayload)
        });

        const result = await response.json();
        results.lark = { success: result.code === 0 || !result.code, data: result };

      } catch (err) {
        console.error('❌ Lark exception:', err);
        results.lark = { success: false, error: err.message };
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Notificações processadas',
      results
    });

  } catch (err) {
    console.error('❌ Notify order error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err.message
    });
  }
}

// ✅ HTML do Email de Confirmação
function generateOrderConfirmationHTML(order) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8">
<style>
  body { font-family: Arial, sans-serif; background: #f8fafc; padding: 20px; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 16px; overflow: hidden; }
  .header { background: linear-gradient(135deg, #3b82f6, #06b6d4); padding: 24px; text-align: center; color: #fff; }
  .content { padding: 32px; }
  .table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  .table td { padding: 12px; border-bottom: 1px solid #e2e8f0; }
  .button { display: inline-block; background: #3b82f6; color: #fff; padding: 14px 32px; text-decoration: none; border-radius: 12px; }
  .footer { background: #f8fafc; padding: 20px; text-align: center; color: #94a3b8; font-size: 12px; }
</style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>PayGo</h1><p>✅ Pedido Confirmado</p></div>
    <div class="content">
      <p>Olá <strong>${order.name}</strong>,</p>
      <p>Seu pedido foi registrado com sucesso!</p>
      <table class="table">
        <tr><td><strong>ID do Pedido:</strong></td><td>${order.orderId}</td></tr>
        <tr><td><strong>Valor Total:</strong></td><td>${order.total.toLocaleString('pt-MZ')} MT</td></tr>
        <tr><td><strong>Pagamento:</strong></td><td>${order.paymentMethod === 'mpesa' ? '🔴 M-Pesa' : '🟡 e-Mola'}</td></tr>
        <tr><td><strong>WhatsApp:</strong></td><td>${order.whatsapp}</td></tr>
      </table>
      <p><a href="${process.env.SITE_URL || 'https://paygo.co.mz'}/dashboard.html" class="button">Ver no Dashboard</a></p>
    </div>
    <div class="footer">&copy; 2026 PayGo Moçambique.</div>
  </div>
</body>
</html>`;
}

// ✅ Texto simples (fallback)
function generateOrderConfirmationText(order) {
  return `Olá ${order.name},\n\nSeu pedido foi registrado!\n\nID: ${order.orderId}\nTotal: ${order.total.toLocaleString('pt-MZ')} MT\n\nAcesse: ${process.env.SITE_URL || 'https://paygo.co.mz'}/dashboard.html\n\n© 2026 PayGo Moçambique`;
}