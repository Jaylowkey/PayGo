import { Resend } from 'resend';

// Inicializar Resend com Log de Segurança para a Vercel
console.log("CHAVE RESEND DETETADA:", process.env.RESEND_API_KEY ? "SIM ✅" : "NÃO ❌");
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Configurações Globais
const WHATSAPP_NUMBER = "258871002255";
const SITE_URL = process.env.SITE_URL || 'https://paygo.co.mz';
const FROM_EMAIL = 'PayGo Moçambique <noreply@paygo.co.mz>';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const LARK_WEBHOOK_URL = process.env.LARK_WEBHOOK_URL;

    // ========================================================================
    // 🔄 ROTA 1: FORMATO ANTIGO "WEBHOOK-LARK" (Alertas de Sistema Interno)
    // ========================================================================
    if (body.type && body.data) {
      const { type, data } = body;
      if (!LARK_WEBHOOK_URL) return res.status(500).json({ error: 'LARK_WEBHOOK_URL not configured' });

      let payload = {};
      switch (type) {
        case 'new-order':
          payload = {
            msg_type: "interactive",
            card: {
              config: { wide_screen_mode: true },
              header: { template: "blue", title: { content: "🛒 Novo Pedido PayGo", tag: "plain_text" } },
              elements: [
                { tag: "div", fields: [
                    { is_short: true, text: { tag: "lark_md", content: `**ID:**\n${data.orderId}` }},
                    { is_short: true, text: { tag: "lark_md", content: `**Cliente:**\n${data.name}` }},
                    { is_short: true, text: { tag: "lark_md", content: `**Total:**\n${data.total} MT` }},
                    { is_short: true, text: { tag: "lark_md", content: `**Pagamento:**\n${data.paymentMethod === 'mpesa' ? '🔴 M-Pesa' : '🟡 e-Mola'}` }},
                    { is_short: false, text: { tag: "lark_md", content: `**WhatsApp:**\n${data.whatsapp}` }},
                    { is_short: false, text: { tag: "lark_md", content: `**Email:**\n${data.email}` }}
                ]},
                { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "Ver no Admin" }, type: "primary", url: `${SITE_URL}/admin.html` }] }
              ]
            }
          }; break;
        case 'payment-marked-paid':
          payload = { msg_type: "text", content: { text: `✅ **Pagamento Marcado como PAGO**\n• Pedido: ${data.order_id || 'N/A'}\n• Data: ${new Date().toLocaleString('pt-MZ')}\n• Admin: ${data.admin_email || 'N/A'}` } }; break;
        case 'order-deleted':
          payload = { msg_type: "text", content: { text: `🗑️ **Pedido Eliminado**\n• Pedido: ${data.order_id || 'N/A'}\n• Motivo: ${data.reason || 'N/A'}\n• Admin: ${data.admin_email || 'N/A'}` } }; break;
        case 'new-payment':
          payload = { msg_type: "text", content: { text: `💰 **Novo Pagamento Recebido**\n• Pedido: ${data.order_id || 'N/A'}\n• Cliente: ${data.customer || 'N/A'}\n• Total: ${data.total ? Number(data.total).toLocaleString('pt-MZ') + ' MT' : 'N/A'}\n• Pagamento: ${data.payment_method || 'N/A'}\n• Data: ${new Date().toLocaleString('pt-MZ')}` } }; break;
        case 'affiliate-approved':
          payload = {
            msg_type: "interactive",
            card: {
              config: { wide_screen_mode: true },
              header: { template: "green", title: { content: "✅ Afiliado Aprovado", tag: "plain_text" } },
              elements: [ { tag: "div", fields: [ { is_short: true, text: { tag: "lark_md", content: `**Nome:**\n${data.name}` }}, { is_short: true, text: { tag: "lark_md", content: `**Email:**\n${data.email}` }}, { is_short: true, text: { tag: "lark_md", content: `**Código:**\n${data.affiliateCode}` }}, { is_short: true, text: { tag: "lark_md", content: `**Comissão:**\n3% na 1ª compra` } } ] } ]
            }
          }; break;
        case 'password-reset':
          payload = { msg_type: "text", content: { text: `🔐 **Recuperação de Senha Solicitada**\n• Email: ${data.email}\n• Hora: ${new Date().toLocaleString('pt-MZ')}\n• IP: ${data.ip || 'N/A'}` } }; break;
        default:
          payload = { msg_type: "text", content: { text: `🔔 **Notificação PayGo**\nTipo: ${type}\nDados: ${JSON.stringify(data)}` } };
      }

      const response = await fetch(LARK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const responseText = await response.text();
      let result; try { result = JSON.parse(responseText); } catch { result = { raw: responseText }; }

      if (result.code === 0 || result.StatusCode === 0 || (!result.code && response.ok)) {
        return res.status(200).json({ success: true, message: 'Notificação Lark enviada' });
      } else {
        return res.status(500).json({ error: 'Lark API error', data: result });
      }
    }

    // ========================================================================
    // 🔄 ROTA 2: FORMATO "NOTIFY-ORDER" (Emails p/ Cliente + Lark Dinâmico)
    // ========================================================================
    const { orderData, sendEmail = true, sendLark = true, action = 'new_order', reason, extraAmount, mediaUrl } = body;
    if (!orderData) return res.status(400).json({ error: 'Payload não reconhecido.' });

    const results = { email: null, lark: null };
    const orderId = orderData.orderId || orderData.topupId || 'N/A';

    // 1. MOTOR DE TEMPLATES DINÂMICOS (Baseado na Action)
    let emailSubject, emailHTML, emailText;
    let larkTemplate = "blue", larkTitle = "🛒 Novo Pedido PayGo";

    if (action === 'payment_confirmed') {
      emailSubject = `✅ Pagamento Recebido - Pedido ${orderId} - PayGo`;
      emailHTML = generatePaymentSuccessHTML(orderData);
      emailText = generatePaymentSuccessText(orderData);
      larkTemplate = "green"; larkTitle = "✅ PAGAMENTO RECEBIDO";

    } else if (action === 'order_refunded') {
      emailSubject = `🟣 Reembolso Emitido - Pedido ${orderId} - PayGo`;
      emailHTML = generateRefundHTML(orderData, reason, mediaUrl);
      emailText = `REEMBOLSO EMITIDO - PAYGO\n\nOlá ${orderData.name},\nO valor de ${orderData.total || orderData.amount} MT foi reembolsado na sua Carteira PayGo.\n\nMotivo: ${reason}\n\nAceda à sua conta para utilizar o saldo.`;
      larkTemplate = "purple"; larkTitle = "🟣 REEMBOLSO EMITIDO";

    } else if (action === 'insufficient_funds') {
      emailSubject = `⚠️ Ação Necessária: Ajuste de Valor - Pedido ${orderId}`;
      emailHTML = generateInsufficientFundsHTML(orderData, extraAmount, reason);
      emailText = `ATENÇÃO: FALTA DE FUNDOS - PAYGO\n\nOlá ${orderData.name},\nFalta o valor de ${extraAmount} MT para processar o seu pedido #${orderId}.\n\nMotivo: ${reason}\n\nPor favor, recarregue a sua carteira o mais rápido possível.`;
      larkTemplate = "orange"; larkTitle = "⚠️ ALERTA: FALTA DE FUNDOS";

    } else {
      // Default: new_order
      emailSubject = `🛒 Pedido ${orderId} Registado - PayGo`;
      emailHTML = generateOrderConfirmationHTML(orderData);
      emailText = generateOrderConfirmationText(orderData);
    }

    // 2. ENVIAR EMAIL AO CLIENTE (Resend com proteção contra e-mails inválidos)
    if (sendEmail && orderData.email && orderData.email.includes('@') && resend) {
      console.log(`A tentar enviar email dinâmico (${action}) para: ${orderData.email}`);
      try {
        const { data, error } = await resend.emails.send({
          from: FROM_EMAIL, 
          to: [orderData.email], 
          subject: emailSubject, 
          html: emailHTML, 
          text: emailText
        });

        if (error) {
            console.error("❌ ERRO RESEND:", error);
            results.email = { success: false, error: error.message };
        } else {
            console.log("✅ EMAIL ENVIADO COM SUCESSO. ID:", data?.id);
            results.email = { success: true, data: { id: data?.id } };
        }
      } catch (err) { 
          console.error("❌ FALHA CRÍTICA NO ENVIO DE EMAIL:", err);
          results.email = { success: false, error: err.message }; 
      }
    } else {
        console.warn(`⚠️ AVISO: Email ignorado. Resend Key: ${!!resend} | Email válido: ${!!(orderData.email && orderData.email.includes('@'))}`);
    }

    // 3. ENVIAR NOTIFICAÇÃO LARK PARA ADMIN
    if (sendLark && LARK_WEBHOOK_URL) {
      try {
        const larkFields = [
          { is_short: true, text: { tag: "lark_md", content: `**ID:**\n#${orderId}` }},
          { is_short: true, text: { tag: "lark_md", content: `**Cliente:**\n${orderData.name || 'N/A'}` }},
          { is_short: true, text: { tag: "lark_md", content: `**Total:**\n${orderData.total || orderData.amount} MT` }},
          { is_short: true, text: { tag: "lark_md", content: `**Método:**\n${(orderData.paymentMethod || 'N/A').toUpperCase()}` }}
        ];

        if (reason) larkFields.push({ is_short: false, text: { tag: "lark_md", content: `**Motivo / Nota:**\n${reason}` }});
        if (extraAmount) larkFields.push({ is_short: false, text: { tag: "lark_md", content: `**Valor em Falta:**\n${extraAmount} MT` }});
        if (orderData.paysuitePaymentId) larkFields.push({ is_short: false, text: { tag: "lark_md", content: `**Ref PaySuite:**\n${orderData.paysuitePaymentId}` }});

        const detailPreview = (orderData.detail || '').substring(0, 150);
        larkFields.push({ is_short: false, text: { tag: "lark_md", content: `**Detalhe:**\n${detailPreview}${detailPreview.length >= 150 ? '...' : ''}` } });

        const larkPayload = {
          msg_type: "interactive",
          card: {
            config: { wide_screen_mode: true },
            header: { template: larkTemplate, title: { content: larkTitle, tag: "plain_text" } },
            elements: [
              { tag: "div", fields: larkFields },
              { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "Ver no Admin" }, type: "primary", url: `${SITE_URL}/admin/` }] },
              { tag: "note", elements: [{ tag: "plain_text", content: `🕐 ${new Date().toLocaleString('pt-MZ')}` }] }
            ]
          }
        };

        const response = await fetch(LARK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(larkPayload) });
        const responseText = await response.text();
        let larkResult; try { larkResult = JSON.parse(responseText); } catch { larkResult = { raw: responseText }; }

        if (larkResult.code === 0 || larkResult.StatusCode === 0 || (!larkResult.code && response.ok)) {
          results.lark = { success: true };
        } else results.lark = { success: false, error: 'Lark error' };
      } catch (err) { results.lark = { success: false, error: err.message }; }
    }

    return res.status(200).json({ success: true, message: 'Processado com sucesso', results });

  } catch (err) {
    console.error('❌ Erro crítico:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}

// ============================================================================
// 🛠️ FUNÇÕES AUXILIARES E TEMPLATES HTML
// ============================================================================

function getWhatsAppLink(order) {
  const isTransfer = order.paymentMethod?.includes('transferencia') || order.paymentMethod === 'bank';
  const actionText = isTransfer ? "enviar o comprovativo do meu pagamento" : "falar sobre o meu pedido";
  const msg = `*OLÁ PAYGO!* 👋\n\nGostaria de ${actionText}.\n\n*DADOS DO PEDIDO:*\n🆔 ID: #${order.orderId || order.topupId}\n👤 Cliente: ${order.name}\n💰 Valor: ${order.total || order.amount} MT\n\n_Aguardo instruções._`;
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;
}

// 1. TEMPLATE: PEDIDO NOVO
function generateOrderConfirmationHTML(order) {
  const waLink = getWhatsAppLink(order);
  const isBank = order.paymentMethod?.includes('transferencia') || order.paymentMethod === 'bank';
  const totalFormatted = Number(order.total || order.amount).toLocaleString('pt-MZ', { minimumFractionDigits: 2 });

  return `
<!DOCTYPE html>
<html lang="pt-MZ">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; color: #1e293b; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #3b82f6, #1d4ed8); padding: 32px 24px; text-align: center; color: #ffffff; }
    .content { padding: 32px 24px; }
    .summary { background: #f8fafc; border: 1px solid #e2e8f0; padding: 20px; border-radius: 12px; margin: 20px 0; }
    .alert { background: #fffbeb; border: 1px solid #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0; color: #92400e; }
    .btn { background-color: #25D366; color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 12px; font-weight: 600; display: inline-block; }
    .footer { background-color: #f8fafc; padding: 24px; text-align: center; color: #64748b; font-size: 12px; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1 style="margin:0;">🛒 Pedido Registado!</h1></div>
    <div class="content">
      <p>Olá, <strong>${order.name || 'Cliente'}</strong>.</p>
      <p>O seu pedido <strong>#${order.orderId || order.topupId}</strong> foi recebido com sucesso e está na nossa fila.</p>
      <div class="summary">
        <h3 style="margin-top: 0; color: #334155;">💰 Resumo da Operação</h3>
        <p><strong>Total a Pagar:</strong> ${totalFormatted} MT</p>
        <p><strong>Método:</strong> ${(order.paymentMethod || 'N/A').toUpperCase()}</p>
      </div>
      ${isBank ? `<div class="alert"><p>⚠️ <strong>Atenção:</strong> Como escolheu Banco, por favor envie o comprovativo no WhatsApp abaixo.</p></div>` 
               : `<p style="text-align: center; color: #64748b;">🔔 Se aplicável, receberá em breve o pedido de PIN no seu telemóvel.</p>`}
      <div style="text-align: center; margin-top: 30px;">
        <a href="${waLink}" class="btn" target="_blank">💬 Falar no WhatsApp</a>
      </div>
    </div>
    <div class="footer"><strong>PayGo Moçambique</strong><br>Suporte: contact@paygo.co.mz</div>
  </div>
</body>
</html>`;
}

// 2. TEMPLATE: PAGAMENTO RECEBIDO
function generatePaymentSuccessHTML(order) {
  const totalFormatted = Number(order.total || order.amount).toLocaleString('pt-MZ', { minimumFractionDigits: 2 });
  return `
<!DOCTYPE html>
<html lang="pt-MZ">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; color: #1e293b; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; border-top: 6px solid #22c55e; box-shadow: 0 4px 24px rgba(0,0,0,0.1); }
    .header { padding: 32px 24px; text-align: center; color: #16a34a; }
    .content { padding: 0 24px 32px; }
    .success-box { background: #f0fdf4; border: 1px solid #bbf7d0; padding: 20px; border-radius: 12px; margin: 20px 0; text-align: center; color: #166534; font-weight: 500; }
    .summary { background: #f8fafc; border: 1px solid #e2e8f0; padding: 20px; border-radius: 12px; margin: 20px 0; }
    .btn { background-color: #3b82f6; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 12px; font-weight: 600; display: inline-block; }
    .footer { background-color: #f8fafc; padding: 24px; text-align: center; color: #64748b; font-size: 12px; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1 style="margin:0;">✅ Pagamento Recebido!</h1></div>
    <div class="content">
      <p>Olá, <strong>${order.name || 'Cliente'}</strong>.</p>
      <div class="success-box"><p>🎉 O seu pagamento de <strong>${totalFormatted} MT</strong> foi confirmado!</p></div>
      <p style="color: #475569;">O seu pedido está agora <strong>em processamento</strong>.</p>
      <div class="summary">
        <p><strong>ID da Operação:</strong> #${order.orderId || order.topupId}</p>
        <p><strong>Status:</strong> 🔄 Em Processamento</p>
      </div>
      <div style="text-align: center; margin-top: 30px;">
        <a href="${SITE_URL}/dashboard.html" class="btn" target="_blank">Aceder à Minha Conta</a>
      </div>
    </div>
    <div class="footer"><strong>PayGo Moçambique</strong><br>Suporte: contact@paygo.co.mz</div>
  </div>
</body>
</html>`;
}

// 3. TEMPLATE: REEMBOLSO EMITIDO
function generateRefundHTML(order, reason, mediaUrl) {
  const totalFormatted = Number(order.total || order.amount).toLocaleString('pt-MZ', { minimumFractionDigits: 2 });
  const mediaBtn = mediaUrl ? `<div style="text-align: center; margin-top: 20px;"><a href="${mediaUrl}" target="_blank" style="background-color: #e2e8f0; color: #475569; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600;">📎 Ver Documento/Prova</a></div>` : '';
  
  return `
<!DOCTYPE html>
<html lang="pt-MZ">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; color: #1e293b; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; border-top: 6px solid #a855f7; box-shadow: 0 4px 24px rgba(0,0,0,0.1); }
    .header { padding: 32px 24px; text-align: center; color: #9333ea; }
    .content { padding: 0 24px 32px; }
    .refund-box { background: #faf5ff; border: 1px solid #e9d5ff; padding: 20px; border-radius: 12px; margin: 20px 0; text-align: center; color: #7e22ce; font-weight: 500; }
    .reason-box { background: #f8fafc; border-left: 4px solid #a855f7; padding: 15px; border-radius: 4px; margin: 20px 0; color: #334155; font-size: 14px; line-height: 1.5; }
    .btn { background-color: #9333ea; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 12px; font-weight: 600; display: inline-block; }
    .footer { background-color: #f8fafc; padding: 24px; text-align: center; color: #64748b; font-size: 12px; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1 style="margin:0;">🟣 Reembolso Emitido</h1></div>
    <div class="content">
      <p>Olá, <strong>${order.name || 'Cliente'}</strong>.</p>
      <div class="refund-box"><p>O valor de <strong>${totalFormatted} MT</strong> referente ao pedido #${order.orderId || order.topupId} foi integralmente devolvido à sua Carteira PayGo.</p></div>
      <p style="color: #475569; font-weight: bold; margin-bottom: 5px;">Motivo do Cancelamento/Reembolso:</p>
      <div class="reason-box">
        ${reason || 'O fornecedor cancelou a encomenda ou o produto encontra-se esgotado.'}
      </div>
      ${mediaBtn}
      <p style="margin-top: 30px; font-size: 14px;">Pode utilizar este saldo imediatamente para efetuar novas compras ou solicitar a transferência.</p>
      <div style="text-align: center; margin-top: 30px;">
        <a href="${SITE_URL}/dashboard.html" class="btn" target="_blank">Aceder à Minha Carteira</a>
      </div>
    </div>
    <div class="footer"><strong>PayGo Moçambique</strong><br>Suporte: contact@paygo.co.mz</div>
  </div>
</body>
</html>`;
}

// 4. TEMPLATE: FUNDOS INSUFICIENTES
function generateInsufficientFundsHTML(order, extraAmount, reason) {
  return `
<!DOCTYPE html>
<html lang="pt-MZ">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; color: #1e293b; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; border-top: 6px solid #f59e0b; box-shadow: 0 4px 24px rgba(0,0,0,0.1); }
    .header { padding: 32px 24px; text-align: center; color: #d97706; }
    .content { padding: 0 24px 32px; }
    .alert-box { background: #fffbeb; border: 1px solid #fde68a; padding: 20px; border-radius: 12px; margin: 20px 0; text-align: center; color: #b45309; font-weight: 500; font-size: 18px; }
    .reason-box { background: #f8fafc; border-left: 4px solid #f59e0b; padding: 15px; border-radius: 4px; margin: 20px 0; color: #334155; font-size: 14px; line-height: 1.5; }
    .btn { background-color: #f59e0b; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 12px; font-weight: 600; display: inline-block; }
    .footer { background-color: #f8fafc; padding: 24px; text-align: center; color: #64748b; font-size: 12px; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1 style="margin:0;">⚠️ Ação Necessária no seu Pedido</h1></div>
    <div class="content">
      <p>Olá, <strong>${order.name || 'Cliente'}</strong>.</p>
      <p>A nossa equipa estava a processar o seu pedido <strong>#${order.orderId || order.topupId}</strong>, mas houve uma alteração de custos.</p>
      <div class="alert-box">
        Falta o valor de <strong>${Number(extraAmount).toLocaleString('pt-MZ', {minimumFractionDigits:2})} MT</strong> para concluirmos a operação.
      </div>
      <p style="color: #475569; font-weight: bold; margin-bottom: 5px;">Justificação da Equipa:</p>
      <div class="reason-box">
        ${reason || 'Houve uma subida no câmbio ou taxa extra de transporte não prevista.'}
      </div>
      <p style="margin-top: 30px; font-size: 14px;">Por favor, aceda à sua conta e efetue um depósito ("Recarregar Carteira") com este valor exato. Assim que o saldo estiver disponível, nós debitamos a diferença e finalizamos a compra.</p>
      <div style="text-align: center; margin-top: 30px;">
        <a href="${SITE_URL}/dashboard.html" class="btn" target="_blank">Depositar Fundos na Conta</a>
      </div>
    </div>
    <div class="footer"><strong>PayGo Moçambique</strong><br>Suporte: contact@paygo.co.mz</div>
  </div>
</body>
</html>`;
}

function generateOrderConfirmationText(order) {
  const totalFormatted = Number(order.total || order.amount).toLocaleString('pt-MZ', { minimumFractionDigits: 2 });
  const isBank = order.paymentMethod?.includes('transferencia') || order.paymentMethod === 'bank';
  return `PEDIDO REGISTADO - PAYGO\n\nOlá ${order.name || 'Cliente'},\nO pedido #${order.orderId || order.topupId} foi registado.\n\n💰 Total: ${totalFormatted} MT\n💳 Método: ${(order.paymentMethod || 'N/A').toUpperCase()}\n\n${isBank ? '⚠️ Envie o comprovativo para o WhatsApp.' : '🔔 Aguarde o processamento.'}\n\nWhatsApp: +258 87 100 2255`;
}

function generatePaymentSuccessText(order) {
  const totalFormatted = Number(order.total || order.amount).toLocaleString('pt-MZ', { minimumFractionDigits: 2 });
  return `PAGAMENTO CONFIRMADO - PAYGO ✅\n\nOlá ${order.name || 'Cliente'},\nRecebemos o pagamento de ${totalFormatted} MT para o pedido #${order.orderId || order.topupId}.\n\n🔄 O seu pedido está EM PROCESSAMENTO.\n\nWhatsApp: +258 87 100 2255`;
}
