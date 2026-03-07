// api/notify-order.js
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  // ✅ CORS headers para segurança
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // ✅ Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

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
          from: 'PayGo Moçambique <noreply@paygo.co.mz>', // ✅ SEM espaços
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
          results.email = { success: true, data };
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
        console.log('🔔 [notify-order] Sending Lark notification');
         
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
                    // ✅ URL SEM espaços no final
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
          results.lark = { success: true, result };
        } else {
          console.error('❌ [notify-order] Lark API error:', result);
          results.lark = { success: false, error: 'Lark API error', result };
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

// ✅ HTML do Email de Confirmação - TEMPLATE PROFISSIONAL
function generateOrderConfirmationHTML(order) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; padding: 20px; margin: 0; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #3b82f6, #06b6d4); padding: 32px; text-align: center; color: white; }
    .header h1 { margin: 0; font-size: 28px; }
    .content { padding: 32px; color: #334155; line-height: 1.6; }
    .order-details { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 20px 0; }
    .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e2e8f0; }
    .detail-row:last-child { border-bottom: none; }
    .total-row { background: #1e293b; color: white; padding: 12px 16px; border-radius: 8px; margin-top: 16px; }
    .total-row .detail-label, .total-row .detail-value { color: white; }
    .cta-button { display: inline-block; background: #25D366; color: #fff !important; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-weight: 600; margin: 20px 0; }
    .footer { background: #f8fafc; padding: 20px; text-align: center; color: #64748b; font-size: 12px; border-top: 1px solid #e2e8f0; }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>✅ Pedido Confirmado!</h1>
      <p style="margin: 8px 0 0; opacity: 0.9;">PayGo Moçambique</p>
    </div>
    <div class="content">
      <p>Olá <strong>${order.name || 'Cliente'}</strong>,</p>
      <p>O seu pedido <strong>#${order.orderId || 'N/A'}</strong> foi registado com sucesso e já está na nossa fila de processamento.</p>
      
      <div class="order-details">
        <h3 style="margin: 0 0 16px 0; color: #1e293b;">📋 Detalhes do Pedido</h3>
        <div class="detail-row">
          <span style="color: #64748b;">Data:</span>
          <span style="color: #1e293b; font-weight: 600;">${order.createdAt ? new Date(order.createdAt).toLocaleDateString('pt-MZ') : new Date().toLocaleDateString('pt-MZ')}</span>
        </div>
        <div class="detail-row">
          <span style="color: #64748b;">Categoria:</span>
          <span style="color: #1e293b; font-weight: 600;">${order.type === 'compra' ? '🛍️ Compras' : '🎮 Jogos'}</span>
        </div>
        <div class="detail-row">
          <span style="color: #64748b;">Produto:</span>
          <span style="color: #1e293b; font-weight: 600;"><a href="${order.detail || '#'}">Ver Link 🔗</a></span>
        </div>
      </div>

      <div class="order-details">
        <h3 style="margin: 0 0 16px 0; color: #1e293b;">💰 Resumo Financeiro</h3>
        <div class="detail-row">
          <span style="color: #64748b;">Valor USD:</span>
          <span style="color: #1e293b; font-weight: 600;">$${(order.usd || 0).toFixed(2)}</span>
        </div>
        <div class="detail-row">
          <span style="color: #64748b;">Câmbio:</span>
          <span style="color: #1e293b; font-weight: 600;">${order.exchangeRate || 88.00} MT</span>
        </div>
        <div class="detail-row">
          <span style="color: #64748b;">Taxas:</span>
          <span style="color: #1e293b; font-weight: 600;">${(order.tax || 0).toLocaleString('pt-MZ', {minimumFractionDigits: 2})} MT</span>
        </div>
        <div class="total-row">
          <div class="detail-row" style="border:none;">
            <span style="color: #94a3b8;">TOTAL A PAGAR:</span>
            <span style="color: #4ade80; font-weight: 700;">${(order.total || 0).toLocaleString('pt-MZ', {minimumFractionDigits: 2})} MT</span>
          </div>
        </div>
      </div>

      <p style="margin-top: 24px;"><strong>📍 Ação Necessária: Pagamento Manual</strong></p>
      <p style="color: #64748b; font-size: 14px;">Como o nosso sistema automático encontra-se temporariamente em manutenção, activámos a via rápida manual para que o seu pedido não sofra atrasos.</p>
      
      <ol style="color: #334155; line-height: 2;">
        <li>Transfira o valor total (<strong>${(order.total || 0).toLocaleString('pt-MZ', {minimumFractionDigits: 2})} MT</strong>) para:
          <ul style="margin: 8px 0;">
            <li><strong>e-Mola:</strong> 87 752 2255</li>
            <li><strong>M-Pesa:</strong> 84 162 7519</li>
          </ul>
        </li>
        <li>Valide o pagamento:
          <p>Envie a foto ou PDF do comprovativo para o nosso WhatsApp de validação clicando no botão abaixo:</p>
        </li>
      </ol>

      <div style="text-align: center; margin: 24px 0;">
        <a href="https://wa.me/258871002255" class="cta-button">📲 Enviar Comprovativo (87 100 2255)</a>
      </div>

      <p style="margin-top: 24px; color: #64748b; font-size: 14px;">
        Precisa de ajuda? Contacte-nos:<br>
        <strong>Email:</strong> contact@paygo.co.mz<br>
        <strong>WhatsApp:</strong> +258 87 100 2255
      </p>
    </div>
    <div class="footer">
      <p style="margin: 0;">PayGo Moçambique</p>
      <p style="margin: 8px 0 0;">Simples. Seguro. Moçambicano. 🇲🇿</p>
      <p style="margin: 8px 0 0; font-size: 11px;">Suporte: contact@paygo.co.mz | WhatsApp: +258 87 100 2255</p>
    </div>
  </div>
</body>
</html>
  `;
}

// ✅ Versão texto simples (fallback)
function generateOrderConfirmationText(order) {
  return `
PEDIDO CONFIRMADO - PAYGO MOÇAMBIQUE ✅

Olá ${order.name || 'Cliente'},

O seu pedido #${order.orderId || 'N/A'} foi registado com sucesso!

📋 DETALHES DO PEDIDO:
• Data: ${order.createdAt ? new Date(order.createdAt).toLocaleDateString('pt-MZ') : new Date().toLocaleDateString('pt-MZ')}
• Categoria: ${order.type === 'compra' ? 'Compras' : 'Jogos'}
• Produto: ${order.detail || 'N/A'}

💰 RESUMO FINANCEIRO:
• Valor USD: $${(order.usd || 0).toFixed(2)}
• Câmbio: ${order.exchangeRate || 88.00} MT
• Taxas: ${(order.tax || 0).toLocaleString('pt-MZ')} MT
• TOTAL: ${(order.total || 0).toLocaleString('pt-MZ')} MT
• Método: ${order.paymentMethod === 'mpesa' ? 'M-Pesa' : 'e-Mola'}

📍 AÇÃO NECESSÁRIA: PAGAMENTO MANUAL

Devido a manutenção temporária no sistema, por favor siga estes passos:

1. Transfira o valor total de ${(order.total || 0).toLocaleString('pt-MZ')} MT para:
   • e-Mola: 87 752 2255
   • M-Pesa: 84 162 7519

2. Envie o comprovativo para validação:
   WhatsApp: https://wa.me/258871002255

Precisa de ajuda? Contacte-nos:
• Email: contact@paygo.co.mz
• WhatsApp: +258 87 100 2255

PayGo Moçambique - Simples. Seguro. Moçambicano. 🇲🇿
  `.trim();
}
