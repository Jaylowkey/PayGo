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
          from: 'PayGo Moçambique <noreply@paygo.co.mz>',
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

// ✅ HTML do Email de Confirmação - TEMPLATE PROFISSIONAL (PAGAMENTO AUTOMÁTICO)
function generateOrderConfirmationHTML(order) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #3b82f6, #06b6d4); padding: 32px; text-align: center; }
    .header h1 { color: #ffffff; margin: 0; font-size: 24px; }
    .content { padding: 32px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    td { padding: 12px; border-bottom: 1px solid #e2e8f0; }
    .btn { display: inline-block; background-color: #25D366; color: #ffffff !important; padding: 14px 28px; text-decoration: none; border-radius: 12px; margin: 20px 0; }
    .btn-secondary { display: inline-block; background-color: #3b82f6; color: #ffffff !important; padding: 14px 28px; text-decoration: none; border-radius: 12px; margin: 10px 0; }
    .status-badge { display: inline-block; padding: 6px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .status-pending { background-color: #fef3c7; color: #92400e; }
    .status-paid { background-color: #dcfce7; color: #166534; }
    .footer { background-color: #f8fafc; padding: 24px; text-align: center; color: #64748b; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🛒 Pedido Confirmado!</h1>
    </div>
    <div class="content">
      <p>Olá, <strong>${order.name || 'Cliente'}</strong>.</p>
      <p>O seu pedido <strong>#${order.orderId || 'N/A'}</strong> foi registado com sucesso no sistema PayGo.</p>
      
      <!-- Status do Pedido -->
      <div style="text-align: center; margin: 24px 0;">
        <span class="status-badge status-pending">⏳ Aguardando Pagamento</span>
      </div>
      
      <h3>📋 Detalhes do Pedido</h3>
      <table>
        <tr><td><strong>Data:</strong></td><td>${order.createdAt ? new Date(order.createdAt).toLocaleDateString('pt-MZ') : new Date().toLocaleDateString('pt-MZ')}</td></tr>
        <tr><td><strong>Categoria:</strong></td><td>${order.type === 'compra' ? '🛍️ Compras' : '🎮 Jogos'}</td></tr>
        <tr><td><strong>Produto:</strong></td><td><a href="${order.detail || '#'}" style="color: #3b82f6;">Ver Link 🔗</a></td></tr>
      </table>
      
      <h3>💰 Resumo Financeiro</h3>
      <table>
        <tr><td><strong>Valor USD:</strong></td><td>$${(order.usd || 0).toFixed(2)}</td></tr>
        <tr><td><strong>Câmbio:</strong></td><td>${order.exchangeRate || 88.00} MT</td></tr>
        <tr><td><strong>Taxas:</strong></td><td>${(order.tax || 0).toLocaleString('pt-MZ', {minimumFractionDigits: 2})} MT</td></tr>
        <tr><td><strong>TOTAL:</strong></td><td><strong>${(order.total || 0).toLocaleString('pt-MZ', {minimumFractionDigits: 2})} MT</strong></td></tr>
      </table>
      
      <p><strong>Método de Pagamento:</strong> ${order.paymentMethod === 'mpesa' ? '🔴 M-Pesa' : '🟡 e-Mola'}</p>
      
      <!-- ✅ NOVA SEÇÃO: PAGAMENTO AUTOMÁTICO -->
      <div style="background: linear-gradient(135deg, #f0fdf4, #dcfce7); border: 2px solid #22c55e; border-radius: 12px; padding: 20px; margin: 24px 0;">
        <h3 style="color: #166534; margin-top: 0;">🚀 Pagamento Automático PaySuite</h3>
        <p style="color: #166534; margin-bottom: 16px;">O seu pagamento será processado automaticamente via <strong>PaySuite</strong>. Você receberá uma notificação USSD no seu celular para confirmar a transação.</p>
        
        <ol style="color: #166534; margin: 0; padding-left: 20px;">
          <li style="margin-bottom: 8px;">Aguarde a notificação USSD no seu celular <strong>${order.whatsapp || 'seu número'}</strong></li>
          <li style="margin-bottom: 8px;">Insira o seu PIN para autorizar o pagamento</li>
          <li>Pronto! Seu pedido será processado imediatamente após confirmação</li>
        </ol>
      </div>
      
      <div style="background-color: #f1f5f9; border-radius: 12px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0; font-size: 14px; color: #475569;">
          <strong>💡 Dica:</strong> Mantenha seu celular próximo e com saldo suficiente. O processo leva menos de 2 minutos.
        </p>
      </div>
      
      <!-- Botões de Ação -->
      <div style="text-align: center; margin: 32px 0;">
        <a href="https://wa.me/258837522255" class="btn">💬 Precisa de Ajuda? Fale Conosco</a>
        <br>
        <a href="${process.env.SITE_URL || 'https://paygo.co.mz'}/dashboard.html" class="btn-secondary">📊 Ver Meu Pedido no Dashboard</a>
      </div>
      
      <p style="border-top: 1px solid #e2e8f0; padding-top: 24px; margin-top: 24px;">
        <strong>PayGo Moçambique</strong><br>
        Simples. Seguro. Moçambicano. 🇲🇿
      </p>
      <p style="margin: 0; font-size: 14px; color: #64748b;">
        Suporte: contact@paygo.co.mz | WhatsApp: +258 83 752 2255
      </p>
    </div>
    <div class="footer">
      <p style="margin: 0;">&copy; ${new Date().getFullYear()} PayGo Serviços Digitais. Todos direitos reservados.</p>
      <p style="margin: 8px 0 0 0; font-size: 11px;">Este é um email automático. Por favor, não responda.</p>
    </div>
  </div>
</body>
</html>
  `;
}

// ✅ Versão texto simples (fallback) - PAGAMENTO AUTOMÁTICO
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

🚀 PAGAMENTO AUTOMÁTICO PAYSUITE:

O seu pagamento será processado automaticamente via PaySuite. Siga estes passos:

1. Aguarde a notificação USSD no seu celular: ${order.whatsapp || 'seu número'}
2. Insira o seu PIN para autorizar o pagamento
3. Pronto! Seu pedido será processado imediatamente após confirmação

💡 Dica: Mantenha seu celular próximo e com saldo suficiente. O processo leva menos de 2 minutos.

Precisa de ajuda? Contacte-nos:
• Email: contact@paygo.co.mz
• WhatsApp: +258 83 752 2255
• Dashboard: ${process.env.SITE_URL || 'https://paygo.co.mz'}/dashboard.html

PayGo Moçambique - Simples. Seguro. Moçambicano. 🇲🇿
  `.trim();
}
