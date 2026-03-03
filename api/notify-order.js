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

// ✅ HTML do Email de Confirmação - TEMPLATE PROFISSIONAL ATUALIZADO
function generateOrderConfirmationHTML(order) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pedido Confirmado - PayGo</title>
</head>
<body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: auto; background: #f8fafc; padding: 20px;">
  
  <div style="border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); background: #fff;">
    
    <!-- Header -->
    <div style="background-color: #0052FF; padding: 35px 30px; text-align: center; color: white;">
      <h1 style="margin: 0; font-size: 24px; letter-spacing: -0.5px;">Pedido Confirmado! ✅</h1>
      <p style="margin: 10px 0 0; opacity: 0.9; font-size: 15px;">Olá, <strong>${order.name || 'Cliente'}</strong>. Recebemos o seu pedido.</p>
    </div>

    <!-- Content -->
    <div style="padding: 30px; color: #334155; line-height: 1.6;">
      <p style="margin-top: 0; font-size: 15px;">O seu pedido <strong>#${order.orderId || 'N/A'}</strong> foi registado com sucesso e já está na nossa fila de processamento.</p>
      
      <!-- Order Details -->
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <h3 style="margin: 0 0 12px 0; color: #0052FF; font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px;">📋 Detalhes do Pedido</h3>
        <table style="width: 100%; font-size: 14px;">
          <tr><td style="padding: 6px 0; color: #64748b;">Data:</td><td style="color: #0f172a; font-weight: 500;">${order.createdAt ? new Date(order.createdAt).toLocaleDateString('pt-MZ') : new Date().toLocaleDateString('pt-MZ')}</td></tr>
          <tr><td style="padding: 6px 0; color: #64748b;">Categoria:</td><td style="color: #0f172a; font-weight: 500;">${order.type === 'compra' ? '🛍️ Compras' : '🎮 Jogos'}</td></tr>
          <tr><td style="padding: 6px 0; color: #64748b;">Produto:</td><td><a href="${order.detail || '#'}" style="color: #0052FF; font-weight: 600; text-decoration: none;" target="_blank">Ver Link 🔗</a></td></tr>
        </table>
      </div>

      <!-- Financial Summary -->
      <div style="border: 1px dashed #cbd5e1; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <h3 style="margin: 0 0 12px 0; color: #0052FF; font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px;">💰 Resumo Financeiro</h3>
        <table style="width: 100%; font-size: 14px;">
          <tr><td style="padding: 6px 0; color: #475569;">Valor USD:</td><td style="text-align: right; color: #0f172a; font-weight: 500;">$${(order.usd || 0).toFixed(2)}</td></tr>
          <tr><td style="padding: 6px 0; color: #475569;">Câmbio:</td><td style="text-align: right; color: #0f172a; font-weight: 500;">${order.exchangeRate || 88.00} MT</td></tr>
          <tr><td style="padding: 6px 0; color: #475569;">Taxas:</td><td style="text-align: right; color: #0f172a; font-weight: 500;">${(order.tax || 0).toLocaleString('pt-MZ', {minimumFractionDigits: 2})} MT</td></tr>
          <tr style="font-size: 18px; font-weight: bold;">
            <td style="padding-top: 16px; border-top: 1px solid #e2e8f0; color: #0f172a;">TOTAL:</td>
            <td style="padding-top: 16px; border-top: 1px solid #e2e8f0; text-align: right; color: #059669;">${(order.total || 0).toLocaleString('pt-MZ', {minimumFractionDigits: 2})} MT</td>
          </tr>
        </table>
        <p style="font-size: 13px; margin: 12px 0 0 0; color: #64748b; text-align: right;">Método selecionado: <strong>${order.paymentMethod === 'mpesa' ? '🔴 M-Pesa' : '🟡 e-Mola'}</strong></p>
      </div>

      <!-- Payment Instructions -->
      <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-left: 4px solid #2563eb; padding: 20px; border-radius: 8px; margin-top: 28px;">
        <h4 style="margin: 0 0 12px 0; color: #1e3a8a; font-size: 16px;">📍 Ação Necessária: Pagamento Manual</h4>
        <p style="margin: 0 0 16px 0; font-size: 14px; color: #1e40af; line-height: 1.5;">Como o nosso sistema automático encontra-se temporariamente em manutenção, ativámos a via rápida manual para que o seu pedido não sofra atrasos.</p>
        
        <p style="margin: 0 0 8px 0; font-size: 14px; font-weight: bold; color: #1e3a8a;">1. Transfira o valor total (<strong>${(order.total || 0).toLocaleString('pt-MZ', {minimumFractionDigits: 2})} MT</strong>) para:</p>
        <ul style="margin: 0 0 16px 0; padding-left: 20px; font-size: 14px; color: #1e40af; line-height: 1.8;">
          <li><strong>e-Mola:</strong> <span style="font-size: 15px; font-weight: bold; color: #1e3a8a;">87 752 2255</span></li>
          <li><strong>M-Pesa:</strong> <span style="font-size: 15px; font-weight: bold; color: #1e3a8a;">84 162 7519</span></li>
        </ul>

        <p style="margin: 0 0 8px 0; font-size: 14px; font-weight: bold; color: #1e3a8a;">2. Valide o pagamento:</p>
        <p style="margin: 0; font-size: 14px; color: #1e40af;">Envie a foto ou PDF do comprovativo para o nosso WhatsApp de validação clicando no botão abaixo:</p>
        
        <!-- ✅ Link WhatsApp SEM espaços -->
        <a href="https://wa.me/258871002255" style="display: inline-block; margin-top: 12px; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; font-size: 14px; box-shadow: 0 2px 4px rgba(37,99,235,0.2);">
          📲 Enviar Comprovativo (87 100 2255)
        </a>
      </div>
    </div>

    <!-- Footer -->
    <div style="background: #f8fafc; padding: 25px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; font-weight: bold; color: #0f172a; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">PayGo Moçambique</p>
      <p style="margin: 6px 0 0; font-size: 13px; color: #64748b;">Simples. Seguro. Moçambicano. 🇲🇿</p>
      <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8;">
        Suporte: contact@paygo.co.mz &nbsp;|&nbsp; WhatsApp: +258 87 100 2255
      </div>
    </div>
    
  </div>
</body>
</html>`;
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
