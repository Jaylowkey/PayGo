// api/notify-order.js
import { Resend } from 'resend';

// Inicializar Resend com chave de ambiente
const resend = new Resend(process.env.RESEND_API_KEY);

// ✅ Configurações Globais - URLs SEM espaços
const WHATSAPP_NUMBER = "258871002255";
const SITE_URL = process.env.SITE_URL || 'https://paygo.co.mz';
const FROM_EMAIL = 'PayGo Moçambique <noreply@paygo.co.mz>';

export default async function handler(req, res) {
  // ✅ CORS headers para segurança
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // ✅ Handle preflight request (OPTIONS)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ✅ Apenas método POST permitido
  if (req.method !== 'POST') {
    console.warn(`⚠️ [notify-order] Método não permitido: ${req.method}`);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { orderData, sendEmail = true, sendLark = true, action = 'new_order' } = req.body;
    const results = { email: null, lark: null };
    
    // Determinar tipo de ação
    const isPaymentConfirmed = action === 'payment_confirmed';
    const orderId = orderData?.orderId || 'N/A';

    console.log(`📦 [notify-order] Processando: ${orderId} | Ação: ${action}`);

    // ========================================================================
    // ✅ 1. ENVIAR EMAIL AO CLIENTE (Resend)
    // ========================================================================
    if (sendEmail && orderData?.email && process.env.RESEND_API_KEY) {
      try {
        console.log(`📧 [notify-order] Enviando email para: ${orderData.email}`);

        const emailSubject = isPaymentConfirmed 
          ? `✅ Pagamento Recebido - Pedido ${orderId} - PayGo`
          : `🛒 Pedido ${orderId} Registado - PayGo`;

        const emailHTML = isPaymentConfirmed 
          ? generatePaymentSuccessHTML(orderData) 
          : generateOrderConfirmationHTML(orderData);

        const emailText = isPaymentConfirmed 
          ? generatePaymentSuccessText(orderData) 
          : generateOrderConfirmationText(orderData);

        const { data, error } = await resend.emails.send({
          from: FROM_EMAIL,
          to: [orderData.email],
          subject: emailSubject,
          html: emailHTML,
          text: emailText,
          // Headers opcionais para melhor deliverability
          headers: {
            'X-Priority': '3',
            'X-Mailer': 'PayGo Notification Service'
          }
        });

        if (error) {
          console.error(`❌ [notify-order] Erro no email:`, error);
          results.email = { success: false, error: error.message };
        } else {
          console.log(`✅ [notify-order] Email enviado: ${data?.id}`);
          results.email = { success: true, data: { id: data?.id } };
        }
      } catch (err) {
        console.error(`❌ [notify-order] Exceção no email:`, err);
        results.email = { success: false, error: err.message };
      }
    } else if (sendEmail && orderData?.email && !process.env.RESEND_API_KEY) {
      console.warn('⚠️ [notify-order] RESEND_API_KEY não configurada - email ignorado');
      results.email = { success: false, error: 'RESEND_API_KEY not configured' };
    }

    // ========================================================================
    // ✅ 2. ENVIAR NOTIFICAÇÃO LARK PARA ADMIN
    // ========================================================================
    if (sendLark && process.env.LARK_WEBHOOK_URL) {
      try {
        console.log('🔔 [notify-order] Enviando notificação Lark');

        const larkTemplate = isPaymentConfirmed ? "green" : "blue";
        const larkTitle = isPaymentConfirmed 
          ? "✅ PAGAMENTO RECEBIDO" 
          : "🛒 Novo Pedido PayGo";
        
        // Campos dinâmicos do card
        const larkFields = [
          { is_short: true, text: { tag: "lark_md", content: `**ID:**\n#${orderId}` }},
          { is_short: true, text: { tag: "lark_md", content: `**Cliente:**\n${orderData.name || 'N/A'}` }},
          { is_short: true, text: { tag: "lark_md", content: `**Total:**\n${orderData.total} MT` }},
          { is_short: true, text: { tag: "lark_md", content: `**Método:**\n${(orderData.paymentMethod || 'N/A').toUpperCase()}` }},
          { is_short: false, text: { tag: "lark_md", content: `**WhatsApp:**\n${orderData.whatsapp || 'N/A'}` }},
        ];

        // Campo adicional se for pagamento confirmado
        if (isPaymentConfirmed && orderData.paysuitePaymentId) {
          larkFields.push({ 
            is_short: false, 
            text: { tag: "lark_md", content: `**Ref PaySuite:**\n${orderData.paysuitePaymentId}` }
          });
        }

        // Detalhe do pedido (truncado)
        const detailPreview = (orderData.detail || '').substring(0, 150);
        larkFields.push({ 
          is_short: false, 
          text: { tag: "lark_md", content: `**Detalhe:**\n${detailPreview}${detailPreview.length >= 150 ? '...' : ''}` }
        });

        // Payload do card interativo Lark
        const larkPayload = {
          msg_type: "interactive",
          card: {
            config: { wide_screen_mode: true },
            header: { 
              template: larkTemplate, 
              title: { content: larkTitle, tag: "plain_text" } 
            },
            elements: [
              { tag: "div", fields: larkFields },
              {
                tag: "action",
                actions: [{
                  tag: "button",
                  text: { tag: "plain_text", content: "Ver no Admin" },
                  type: "primary",
                  // ✅ URL SEM espaços
                  url: `${SITE_URL}/admin/`
                }]
              },
              {
                tag: "note",
                elements: [{ 
                  tag: "plain_text", 
                  content: `🕐 ${new Date().toLocaleString('pt-MZ')}` 
                }]
              }
            ]
          }
        };

        const response = await fetch(process.env.LARK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(larkPayload),
          timeout: 10000 // 10 segundos timeout
        });

        const responseText = await response.text();
        let larkResult;
        try {
          larkResult = JSON.parse(responseText);
        } catch {
          larkResult = { raw: responseText };
        }

        console.log('📥 [notify-order] Resposta Lark:', {
          status: response.status,
          ok: response.ok,
          result: larkResult
        });

        // ✅ Lark retorna code: 0 para sucesso
        if (larkResult.code === 0 || larkResult.StatusCode === 0 || (!larkResult.code && response.ok)) {
          console.log('✅ [notify-order] Notificação Lark enviada com sucesso');
          results.lark = { success: true, result: larkResult };
        } else {
          console.error('❌ [notify-order] Erro na API Lark:', larkResult);
          results.lark = { success: false, error: 'Lark API error', result: larkResult };
        }

      } catch (err) {
        console.error('❌ [notify-order] Exceção no Lark:', err);
        results.lark = { success: false, error: err.message };
      }
    } else if (sendLark && !process.env.LARK_WEBHOOK_URL) {
      console.warn('⚠️ [notify-order] LARK_WEBHOOK_URL não configurada - notificação ignorada');
      results.lark = { success: false, error: 'LARK_WEBHOOK_URL not configured' };
    }

    // ========================================================================
    // ✅ RESPOSTA FINAL
    // ========================================================================
    console.log('✅ [notify-order] Processamento concluído:', {
      orderId,
      email: results.email?.success,
      lark: results.lark?.success
    });

    return res.status(200).json({
      success: true,
      message: 'Notificações processadas',
      results,
      debug: {
        sendEmail,
        sendLark,
        hasResendKey: !!process.env.RESEND_API_KEY,
        hasLarkWebhook: !!process.env.LARK_WEBHOOK_URL,
        action
      }
    });

  } catch (err) {
    console.error('❌ [notify-order] Erro crítico:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
}

// ============================================================================
// 🛠️ FUNÇÕES AUXILIARES E TEMPLATES
// ============================================================================

/**
 * Gera link do WhatsApp com mensagem pré-preenchida
 */
function getWhatsAppLink(order) {
  const isTransfer = order.paymentMethod?.includes('transferencia');
  const actionText = isTransfer 
    ? "enviar o comprovativo do meu pagamento" 
    : "finalizar o meu pedido";
  
  const msg = `*OLÁ PAYGO!* 👋\n\nGostaria de ${actionText}.\n\n*DADOS DO PEDIDO:*\n🆔 ID: #${order.orderId}\n👤 Cliente: ${order.name}\n💰 Valor: ${order.total} MT\n💳 Método: ${order.paymentMethod?.toUpperCase()}\n\n_Aguardo instruções._`;
  
  // ✅ URL SEM espaços após wa.me/
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;
}

/**
 * Template HTML para confirmação de novo pedido
 */
function generateOrderConfirmationHTML(order) {
  const waLink = getWhatsAppLink(order);
  const isBank = order.paymentMethod?.includes('transferencia');
  const totalFormatted = Number(order.total).toLocaleString('pt-MZ', { minimumFractionDigits: 2 });

  return `
<!DOCTYPE html>
<html lang="pt-MZ">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pedido ${order.orderId} - PayGo</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; color: #1e293b; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #3b82f6, #1d4ed8); padding: 32px 24px; text-align: center; color: #ffffff; }
    .header h1 { margin: 0; font-size: 24px; font-weight: 700; }
    .content { padding: 32px 24px; }
    .summary { background: #f8fafc; border: 1px solid #e2e8f0; padding: 20px; border-radius: 12px; margin: 20px 0; }
    .summary p { margin: 8px 0; font-size: 14px; }
    .alert { background: #fffbeb; border: 1px solid #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0; }
    .alert p { margin: 0; color: #92400e; font-size: 14px; }
    .cta { text-align: center; margin-top: 30px; }
    .btn { background-color: #25D366; color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 12px; font-weight: 600; display: inline-block; font-size: 16px; transition: background-color 0.2s; }
    .btn:hover { background-color: #128C7E; }
    .footer { background-color: #f8fafc; padding: 24px; text-align: center; color: #64748b; font-size: 12px; border-top: 1px solid #e2e8f0; }
    @media (max-width: 600px) {
      .content { padding: 24px 16px; }
      .header { padding: 24px 16px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🛒 Pedido Registado!</h1>
    </div>
    <div class="content">
      <p>Olá, <strong>${order.name || 'Cliente'}</strong>.</p>
      <p>O seu pedido <strong>#${order.orderId}</strong> foi recebido com sucesso e já está na nossa fila de processamento.</p>
      
      <div class="summary">
        <h3 style="margin-top: 0; font-size: 16px; color: #334155;">💰 Resumo do Pedido</h3>
        <p style="margin: 5px 0;"><strong>Total a Pagar:</strong> ${totalFormatted} MT</p>
        <p style="margin: 5px 0;"><strong>Método de Pagamento:</strong> ${(order.paymentMethod || 'N/A').toUpperCase()}</p>
        <p style="margin: 5px 0;"><strong>Categoria:</strong> ${(order.type === 'compra' ? '🛍️ Compras' : '🎮 Jogos')}</p>
        ${order.usd ? `<p style="margin: 5px 0;"><strong>Valor USD:</strong> $${Number(order.usd).toFixed(2)}</p>` : ''}
      </div>

      ${isBank ? `
        <div class="alert">
          <p style="margin: 0;">
            ⚠️ <strong>Atenção:</strong> Como escolheu transferência bancária, por favor clique no botão abaixo para <strong>enviar o comprovativo</strong> via WhatsApp para validação imediata.
          </p>
        </div>
      ` : `
        <p style="color: #64748b; font-size: 14px; text-align: center; margin: 20px 0;">
          🔔 Receberá em breve o pedido de PIN no seu telemóvel para autorizar a transação via ${(order.paymentMethod === 'mpesa' ? 'M-Pesa' : 'e-Mola')}.
        </p>
      `}

      <div class="cta">
        <a href="${waLink}" class="btn" target="_blank" rel="noopener noreferrer">
          💬 Finalizar via WhatsApp
        </a>
      </div>
      
      <p style="color: #94a3b8; font-size: 12px; text-align: center; margin-top: 24px;">
        Precisa de ajuda? Contacte-nos: contact@paygo.co.mz
      </p>
    </div>
    <div class="footer">
      <strong>PayGo Moçambique</strong> - O Mundo no seu Bolso 🇲🇿<br>
      Suporte: contact@paygo.co.mz | WhatsApp: +258 87 100 2255
    </div>
  </div>
</body>
</html>`;
}

/**
 * Template HTML para confirmação de pagamento recebido
 */
function generatePaymentSuccessHTML(order) {
  const totalFormatted = Number(order.total).toLocaleString('pt-MZ', { minimumFractionDigits: 2 });
  
  return `
<!DOCTYPE html>
<html lang="pt-MZ">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pagamento Confirmado - PayGo</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; color: #1e293b; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.1); border-top: 6px solid #22c55e; }
    .header { padding: 32px 24px; text-align: center; }
    .header h1 { color: #16a34a; margin: 0; font-size: 26px; font-weight: 700; }
    .content { padding: 0 24px 32px; }
    .success-box { background: #f0fdf4; border: 1px solid #bbf7d0; padding: 20px; border-radius: 12px; margin: 20px 0; text-align: center; }
    .success-box p { margin: 0; color: #166534; font-weight: 500; }
    .summary { background: #f8fafc; border: 1px solid #e2e8f0; padding: 20px; border-radius: 12px; margin: 20px 0; }
    .summary p { margin: 8px 0; font-size: 14px; }
    .cta { text-align: center; margin-top: 30px; }
    .btn { background-color: #3b82f6; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 12px; font-weight: 600; display: inline-block; font-size: 15px; transition: background-color 0.2s; }
    .btn:hover { background-color: #2563eb; }
    .footer { background-color: #f8fafc; padding: 24px; text-align: center; color: #64748b; font-size: 12px; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>✅ Pagamento Recebido!</h1>
    </div>
    <div class="content">
      <p>Olá, <strong>${order.name || 'Cliente'}</strong>.</p>
      <p>Recebemos o seu pagamento do pedido <strong>#${order.orderId}</strong>.</p>
      
      <div class="success-box">
        <p>🎉 O seu pagamento de <strong>${totalFormatted} MT</strong> foi confirmado!</p>
      </div>
      
      <p style="color: #475569; line-height: 1.6;">
        O seu pedido está agora <strong>em processamento</strong>. A nossa equipa irá efetuar a compra internacional e enviar-lhe os detalhes de conclusão em breve.
      </p>
      
      <div class="summary">
        <h3 style="margin-top: 0; font-size: 16px; color: #334155;">📋 Detalhes</h3>
        <p style="margin: 5px 0;"><strong>ID do Pedido:</strong> #${order.orderId}</p>
        <p style="margin: 5px 0;"><strong>Data:</strong> ${new Date().toLocaleDateString('pt-MZ')}</p>
        <p style="margin: 5px 0;"><strong>Status:</strong> 🔄 Em Processamento</p>
      </div>

      <div class="cta">
        <a href="https://wa.me/${WHATSAPP_NUMBER}" class="btn" target="_blank" rel="noopener noreferrer">
          📊 Acompanhar no WhatsApp
        </a>
      </div>
    </div>
    <div class="footer">
      <strong>PayGo Moçambique</strong> - Simples. Seguro. Moçambicano. 🇲🇿<br>
      Suporte: contact@paygo.co.mz
    </div>
  </div>
</body>
</html>`;
}

/**
 * Template texto simples para confirmação de novo pedido (fallback)
 */
function generateOrderConfirmationText(order) {
  const totalFormatted = Number(order.total).toLocaleString('pt-MZ', { minimumFractionDigits: 2 });
  const isBank = order.paymentMethod?.includes('transferencia');
  
  return `
PEDIDO REGISTADO - PAYGO MOÇAMBIQUE 🛒

Olá ${order.name || 'Cliente'},

O seu pedido #${order.orderId} foi registado com sucesso!

💰 RESUMO:
• Total: ${totalFormatted} MT
• Método: ${(order.paymentMethod || 'N/A').toUpperCase()}
• Categoria: ${order.type === 'compra' ? 'Compras' : 'Jogos'}

${isBank 
  ? '⚠️ ATENÇÃO: Envie o comprovativo da transferência para o WhatsApp +258 87 100 2255 para validação.' 
  : '🔔 Aguarde o pedido de PIN no seu telemóvel para autorizar o pagamento.'
}

Precisa de ajuda?
• WhatsApp: +258 87 100 2255
• Email: contact@paygo.co.mz

PayGo - O Mundo no seu Bolso 🇲🇿
  `.trim();
}

/**
 * Template texto simples para confirmação de pagamento (fallback)
 */
function generatePaymentSuccessText(order) {
  const totalFormatted = Number(order.total).toLocaleString('pt-MZ', { minimumFractionDigits: 2 });
  
  return `
PAGAMENTO CONFIRMADO - PAYGO ✅

Olá ${order.name || 'Cliente'},

Recebemos o seu pagamento de ${totalFormatted} MT para o pedido #${order.orderId}.

🔄 O seu pedido está agora EM PROCESSAMENTO.
A nossa equipa irá efetuar a compra internacional e enviar-lhe os detalhes em breve.

Acompanhe no WhatsApp: +258 87 100 2255

PayGo - Simples. Seguro. Moçambicano. 🇲🇿
  `.trim();
}


