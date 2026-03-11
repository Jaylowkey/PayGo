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
    // 🚀 Extraímos a 'action' (new_order ou payment_confirmed)
    const { orderData, sendEmail = true, sendLark = true, action = 'new_order' } = req.body;
    const results = { email: null, lark: null };

    const isPaymentConfirmed = action === 'payment_confirmed';

    console.log(`📦 [notify-order] Processing order: ${orderData?.orderId} | Action: ${action}`);

    // ✅ 1. Enviar Email ao Cliente (opcional)
    if (sendEmail && orderData?.email) {
      try {
        console.log('📧 [notify-order] Sending email to:', orderData.email);
        
        // Define o assunto e o conteúdo com base na ação
        const emailSubject = isPaymentConfirmed 
          ? `✅ Pagamento Recebido - Pedido ${orderData.orderId} - PayGo`
          : `🛒 Pedido ${orderData.orderId} Registado - PayGo`;

        const emailHTML = isPaymentConfirmed 
          ? generatePaymentSuccessHTML(orderData) 
          : generateOrderConfirmationHTML(orderData);

        const emailText = isPaymentConfirmed 
          ? generatePaymentSuccessText(orderData) 
          : generateOrderConfirmationText(orderData);

        const { data, error } = await resend.emails.send({
          from: 'PayGo Moçambique <noreply@paygo.co.mz>',
          to: [orderData.email],
          subject: emailSubject,
          html: emailHTML,
          text: emailText
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
        
        // Customiza o cartão Lark dependendo se o pagamento foi concluído ou não
        const larkTemplate = isPaymentConfirmed ? "green" : "blue";
        const larkTitle = isPaymentConfirmed ? "✅ PAGAMENTO RECEBIDO" : "🛒 Novo Pedido PayGo";
        
        // Campos base
        const larkFields = [
          { is_short: true, text: { tag: "lark_md", content: `**ID:**\n${orderData.orderId}` }},
          { is_short: true, text: { tag: "lark_md", content: `**Cliente:**\n${orderData.name}` }},
          { is_short: true, text: { tag: "lark_md", content: `**Total:**\n${orderData.total} MT` }},
          { is_short: true, text: { tag: "lark_md", content: `**WhatsApp:**\n${orderData.whatsapp}` }},
          { is_short: false, text: { tag: "lark_md", content: `**Email:**\n${orderData.email}` }},
        ];

        // Se o pagamento foi confirmado, adicionamos detalhes extra da PaySuite
        if (isPaymentConfirmed) {
            larkFields.push({ is_short: false, text: { tag: "lark_md", content: `**Status:**\nPago com sucesso via ${orderData.paymentMethod || 'PaySuite'} ✅` }});
            if (orderData.paysuitePaymentId) {
                larkFields.push({ is_short: true, text: { tag: "lark_md", content: `**Ref PaySuite:**\n${orderData.paysuitePaymentId}` }});
            }
        }

        // Adiciona o detalhe do link do produto no final
        larkFields.push({ is_short: false, text: { tag: "lark_md", content: `**Detalhe do Produto:**\n${(orderData.detail || '').substring(0, 150)}...` }});
        
        const larkPayload = {
          msg_type: "interactive",
          card: {
            config: { wide_screen_mode: true },
            header: {
              template: larkTemplate,
              title: { content: larkTitle, tag: "plain_text" }
            },
            elements: [
              {
                tag: "div",
                fields: larkFields
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
    }

    console.log('✅ [notify-order] Completed:', results);

    return res.status(200).json({
      success: true,
      message: 'Notificações processadas',
      results,
      debug: { sendEmail, sendLark }
    });

  } catch (err) {
    console.error('❌ [notify-order] Critical error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err.message
    });
  }
}

// ============================================================================
// TEMPLATES PARA "NEW ORDER" (Aguardando Pagamento)
// ============================================================================
function generateOrderConfirmationHTML(order) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #3b82f6, #06b6d4); padding: 32px; text-align: center; }
    .header h1 { color: #ffffff; margin: 0; font-size: 24px; }
    .content { padding: 32px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    td { padding: 12px; border-bottom: 1px solid #e2e8f0; }
    .btn { display: inline-block; background-color: #25D366; color: #ffffff !important; padding: 14px 28px; text-decoration: none; border-radius: 12px; margin: 20px 0; }
    .status-badge { display: inline-block; padding: 6px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; background-color: #fef3c7; color: #92400e; }
    .footer { background-color: #f8fafc; padding: 24px; text-align: center; color: #64748b; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🛒 Pedido Registado!</h1>
    </div>
    <div class="content">
      <p>Olá, <strong>${order.name || 'Cliente'}</strong>.</p>
      <p>O seu pedido <strong>#${order.orderId || 'N/A'}</strong> foi registado com sucesso no sistema PayGo.</p>
      
      <div style="text-align: center; margin: 24px 0;">
        <span class="status-badge">⏳ Aguardando Pagamento</span>
      </div>
      
      <h3>💰 Resumo Financeiro</h3>
      <table>
        <tr><td><strong>Valor USD:</strong></td><td>$${(order.usd || 0).toFixed(2)}</td></tr>
        <tr><td><strong>TOTAL:</strong></td><td><strong>${(order.total || 0).toLocaleString('pt-MZ', {minimumFractionDigits: 2})} MT</strong></td></tr>
      </table>
      
      <div style="background: linear-gradient(135deg, #f0fdf4, #dcfce7); border: 2px solid #22c55e; border-radius: 12px; padding: 20px; margin: 24px 0;">
        <h3 style="color: #166534; margin-top: 0;">🚀 Pagamento Automático</h3>
        <p style="color: #166534; margin-bottom: 16px;">Será notificado no seu celular <strong>${order.whatsapp || 'seu número'}</strong> para inserir o seu PIN e autorizar a transação.</p>
      </div>
      
      <div style="text-align: center; margin: 32px 0;">
        <a href="https://wa.me/258837522255" class="btn">💬 Fale Conosco</a>
      </div>
      <p style="text-align:center; font-size: 14px; color: #64748b;">Suporte: contact@paygo.co.mz</p>
    </div>
  </div>
</body>
</html>
  `;
}

function generateOrderConfirmationText(order) {
  return `PEDIDO REGISTADO - PAYGO\nOlá ${order.name},\nSeu pedido #${order.orderId} foi registado.\nAguarde a notificação no seu celular para colocar o PIN e autorizar o pagamento no valor de ${order.total} MT.`;
}

// ============================================================================
// TEMPLATES PARA "PAYMENT CONFIRMED" (Pagamento Efectuado com Sucesso)
// ============================================================================
function generatePaymentSuccessHTML(order) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.1); border-top: 6px solid #22c55e;}
    .header { padding: 32px; text-align: center; }
    .header h1 { color: #16a34a; margin: 0; font-size: 26px; }
    .content { padding: 0 32px 32px 32px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    td { padding: 12px; border-bottom: 1px solid #e2e8f0; }
    .status-badge { display: inline-block; padding: 8px 16px; border-radius: 20px; font-size: 14px; font-weight: bold; background-color: #dcfce7; color: #166534; }
    .btn { display: inline-block; background-color: #3b82f6; color: #ffffff !important; padding: 14px 28px; text-decoration: none; border-radius: 12px; margin: 20px 0; }
    .footer { background-color: #f8fafc; padding: 24px; text-align: center; color: #64748b; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>✅ Pagamento Recebido!</h1>
    </div>
    <div class="content">
      <p>Olá, <strong>${order.name || 'Cliente'}</strong>.</p>
      <p>Recebemos o seu pagamento referente ao pedido <strong>#${order.orderId || 'N/A'}</strong>.</p>
      
      <div style="text-align: center; margin: 24px 0;">
        <span class="status-badge">🔄 Em Processamento</span>
      </div>

      <p style="color: #475569; line-height: 1.6;">A nossa equipa já está a efectuar o pagamento internacional do seu produto/serviço. O código de rastreio ou os detalhes da sua conta serão enviados em breve.</p>
      
      <h3>🧾 Recibo</h3>
      <table>
        <tr><td><strong>Valor Pago:</strong></td><td><strong>${(order.total || 0).toLocaleString('pt-MZ', {minimumFractionDigits: 2})} MT</strong></td></tr>
        <tr><td><strong>Método:</strong></td><td>${order.paymentMethod === 'mpesa' ? 'M-Pesa' : 'e-Mola'}</td></tr>
        <tr><td><strong>Data do Pagamento:</strong></td><td>${new Date().toLocaleString('pt-MZ')}</td></tr>
        <tr><td><strong>Ref PaySuite:</strong></td><td>${order.paysuitePaymentId || 'N/A'}</td></tr>
      </table>
      
      <div style="text-align: center; margin: 32px 0;">
        <a href="${process.env.SITE_URL || 'https://paygo.co.mz'}/admin/dashboard.html" class="btn">📊 Acompanhar Pedido</a>
      </div>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} PayGo Moçambique.</p>
    </div>
  </div>
</body>
</html>
  `;
}

function generatePaymentSuccessText(order) {
  return `PAGAMENTO RECEBIDO - PAYGO ✅\nOlá ${order.name},\nRecebemos o seu pagamento de ${order.total} MT referente ao pedido #${order.orderId}.\n\nO seu pedido está agora EM PROCESSAMENTO.\nAcompanhe o status no Dashboard: ${process.env.SITE_URL || 'https://paygo.co.mz'}/dashboard.html`;
}
