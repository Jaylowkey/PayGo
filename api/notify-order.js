// api/notify-order.js
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  // ✅ Log inicial
  console.log('🔔 [notify-order] Request received:', {
    method: req.method,
    url: req.url,
    body: req.body
  });

  // ✅ Apenas POST
  if (req.method !== 'POST') {
    console.warn('⚠️ [notify-order] Method not allowed:', req.method);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { orderData, sendEmail = true, sendLark = true } = req.body;
    const results = { email: null, lark: null };

    console.log('📦 [notify-order] Processing order:', orderData?.orderId);

    // ✅ 1. Enviar Email ao Cliente (opcional)
    if (sendEmail && orderData?.email) {
      try {
        console.log('📧 [notify-order] Sending email to:', orderData.email);
        
        const { data, error } = await resend.emails.send({
          from: `PayGo <noreply@paygo.co.mz>`,
          to: [orderData.email],
          subject: `✅ Pedido ${orderData.orderId} Confirmado - PayGo`,
          html: generateOrderConfirmationHTML(orderData),
          text: generateOrderConfirmationText(orderData)
        });

        if (error) {
          console.error('❌ [notify-order] Email error:', error);
          results.email = { success: false, error: error.message };
        } else {
          console.log('✅ [notify-order] Email sent:', data?.id);
          results.email = { success: true,  data };
        }
      } catch (err) {
        console.error('❌ [notify-order] Email exception:', err);
        results.email = { success: false, error: err.message };
      }
    } else {
      console.log('⏭️ [notify-order] Email skipped:', { sendEmail, hasEmail: !!orderData?.email });
    }

    // ✅ 2. Enviar Notificação Lark para Admin (opcional)
    if (sendLark && process.env.LARK_WEBHOOK_URL) {
      try {
        console.log('🔔 [notify-order] Sending Lark notification to:', process.env.LARK_WEBHOOK_URL?.substring(0, 50) + '...');
        
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
                  { is_short: false, text: { tag: "lark_md", content: `**Email:**\n${orderData.email}` }},
                  { is_short: false, text: { tag: "lark_md", content: `**Detalhe:**\n${(orderData.detail || '').substring(0, 100)}...` }}
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
              },
              {
                tag: "note",
                elements: [
                  { tag: "plain_text", content: `🕐 ${new Date().toLocaleString('pt-MZ')}` }
                ]
              }
            ]
          }
        };

        console.log('📤 [notify-order] Lark payload:', JSON.stringify(larkPayload, null, 2).substring(0, 500) + '...');

        const response = await fetch(process.env.LARK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(larkPayload)
        });

        const responseText = await response.text();
        let result;
        try {
          result = JSON.parse(responseText);
        } catch {
          result = { raw: responseText };
        }

        console.log('📥 [notify-order] Lark response:', {
          status: response.status,
          statusText: response.statusText,
          result: result
        });

        // ✅ Lark retorna code: 0 para sucesso
        if (result.code === 0 || result.StatusCode === 0 || (!result.code && response.ok)) {
          console.log('✅ [notify-order] Lark notification sent successfully');
          results.lark = { success: true,  result };
        } else {
          console.error('❌ [notify-order] Lark API error:', result);
          results.lark = { success: false, error: 'Lark API error',  result };
        }

      } catch (err) {
        console.error('❌ [notify-order] Lark exception:', err);
        results.lark = { success: false, error: err.message };
      }
    } else {
      console.log('⏭️ [notify-order] Lark skipped:', { 
        sendLark, 
        hasWebhook: !!process.env.LARK_WEBHOOK_URL 
      });
    }

    console.log('✅ [notify-order] Completed:', results);

    return res.status(200).json({
      success: true,
      message: 'Notificações processadas',
      results,
      debug: {
        sendEmail,
        sendLark,
        hasResendKey: !!process.env.RESEND_API_KEY,
        hasLarkWebhook: !!process.env.LARK_WEBHOOK_URL
      }
    });

  } catch (err) {
    console.error('❌ [notify-order] Critical error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
}

// ✅ HTML do Email de Confirmação
function generateOrderConfirmationHTML(order) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8">
<style>
  body { font-family: Arial, sans-serif; background: #f8fafc; padding: 20px; margin: 0; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
  .header { background: linear-gradient(135deg, #3b82f6, #06b6d4); padding: 24px; text-align: center; color: #fff; }
  .content { padding: 32px; color: #334155; line-height: 1.6; }
  .table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  .table td { padding: 12px; border-bottom: 1px solid #e2e8f0; }
  .button { display: inline-block; background: #3b82f6; color: #fff; padding: 14px 32px; text-decoration: none; border-radius: 12px; font-weight: 600; }
  .footer { background: #f8fafc; padding: 20px; text-align: center; color: #94a3b8; font-size: 12px; }
</style>
</head>
<body>
  <div class="container">
    <div class="header"><h1 style="margin:0">PayGo</h1><p style="margin:8px 0 0">✅ Pedido Confirmado</p></div>
    <div class="content">
      <p>Olá <strong>${order.name || 'Cliente'}</strong>,</p>
      <p>Seu pedido foi registrado com sucesso!</p>
      <table class="table">
        <tr><td><strong>ID do Pedido:</strong></td><td>${order.orderId || 'N/A'}</td></tr>
        <tr><td><strong>Valor Total:</strong></td><td>${order.total?.toLocaleString('pt-MZ') || 'N/A'} MT</td></tr>
        <tr><td><strong>Pagamento:</strong></td><td>${order.paymentMethod === 'mpesa' ? '🔴 M-Pesa' : '🟡 e-Mola'}</td></tr>
        <tr><td><strong>WhatsApp:</strong></td><td>${order.whatsapp || 'N/A'}</td></tr>
      </table>
      <p style="text-align:center;margin:24px 0">
        <a href="${process.env.SITE_URL || 'https://paygo.co.mz'}/dashboard.html" class="button">Ver no Dashboard</a>
      </p>
      <p style="font-size:14px;color:#64748b">Precisa de ajuda? Responda este email ou contacte-nos no WhatsApp: +258 83 752 2255</p>
    </div>
    <div class="footer">&copy; 2026 PayGo Moçambique. Todos direitos reservados.</div>
  </div>
</body>
</html>`;
}

// ✅ Texto simples (fallback)
function generateOrderConfirmationText(order) {
  return `Olá ${order.name || 'Cliente'},\n\nSeu pedido foi registrado!\n\nID: ${order.orderId}\nTotal: ${order.total?.toLocaleString('pt-MZ') || 'N/A'} MT\nPagamento: ${order.paymentMethod === 'mpesa' ? 'M-Pesa' : 'e-Mola'}\n\nAcesse: ${process.env.SITE_URL || 'https://paygo.co.mz'}/dashboard.html\n\nPrecisa de ajuda? WhatsApp: +258 83 752 2255\n\n© 2026 PayGo Moçambique`;
}
