// api/webhook-lark.js
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
    console.warn('⚠️ [webhook-lark] Method not allowed:', req.method);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { type, data } = req.body;
    const LARK_WEBHOOK_URL = process.env.LARK_WEBHOOK_URL;

    if (!LARK_WEBHOOK_URL) {
      console.error('❌ [webhook-lark] LARK_WEBHOOK_URL not configured');
      return res.status(500).json({ error: 'LARK_WEBHOOK_URL not configured' });
    }

    console.log('🔔 [webhook-lark] Processing notification:', { type, hasData: !!data });

    let payload = {};

    switch (type) {
      case 'new-order':
        payload = {
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
                  { is_short: true, text: { tag: "lark_md", content: `**ID:**\n${data.orderId}` }},
                  { is_short: true, text: { tag: "lark_md", content: `**Cliente:**\n${data.name}` }},
                  { is_short: true, text: { tag: "lark_md", content: `**Total:**\n${data.total} MT` }},
                  { is_short: true, text: { tag: "lark_md", content: `**Pagamento:**\n${data.paymentMethod === 'mpesa' ? '🔴 M-Pesa' : '🟡 e-Mola'}` }},
                  { is_short: false, text: { tag: "lark_md", content: `**WhatsApp:**\n${data.whatsapp}` }},
                  { is_short: false, text: { tag: "lark_md", content: `**Email:**\n${data.email}` }}
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
              }
            ]
          }
        };
        break;

      case 'new-payment':
        payload = {
          msg_type: "text",
          content: {
            text: `💰 **Novo Pagamento Recebido**\n• Pedido: ${data.order_id || 'N/A'}\n• Cliente: ${data.customer || 'N/A'}\n• Total: ${data.total ? Number(data.total).toLocaleString('pt-MZ') + ' MT' : 'N/A'}\n• Pagamento: ${data.payment_method || 'N/A'}\n• Data: ${new Date().toLocaleString('pt-MZ')}`
          } 
        };
        break;

      case 'affiliate-approved':
        payload = {
          msg_type: "interactive",
          card: {
            config: { wide_screen_mode: true },
            header: {
              template: "green",
              title: { content: "✅ Afiliado Aprovado", tag: "plain_text" }
            },
            elements: [
              {
                tag: "div",
                fields: [
                  { is_short: true, text: { tag: "lark_md", content: `**Nome:**\n${data.name}` }},
                  { is_short: true, text: { tag: "lark_md", content: `**Email:**\n${data.email}` }},
                  { is_short: true, text: { tag: "lark_md", content: `**Código:**\n${data.affiliateCode}` }},
                  { is_short: true, text: { tag: "lark_md", content: `**Comissão:**\n3% na 1ª compra` }}
                ]
              }
            ]
          }
        };
        break;

      case 'password-reset':
        payload = {
          msg_type: "text",
          content: {
            text: `🔐 **Recuperação de Senha Solicitada**\n• Email: ${data.email}\n• Hora: ${new Date().toLocaleString('pt-MZ')}\n• IP: ${data.ip || 'N/A'}`
          } 
        };
        break;

      default:
        payload = {
          msg_type: "text",
          content: {
            text: `🔔 **Notificação PayGo**\nTipo: ${type}\nDados: ${JSON.stringify(data)}`
          }
        };
    }

    console.log('📤 [webhook-lark] Sending payload to Lark');

    const response = await fetch(LARK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      result = { raw: responseText };
    }

    console.log('📥 [webhook-lark] Lark response:', {
      status: response.status,
      statusText: response.statusText,
      result: result
    });

    // ✅ Lark retorna code: 0 para sucesso
    if (result.code === 0 || result.StatusCode === 0 || (!result.code && response.ok)) {
      console.log('✅ [webhook-lark] Notification sent successfully:', type);
      return res.status(200).json({ 
        success: true, 
        message: 'Notificação Lark enviada',
        data: result 
      });
    } else {
      console.error('❌ [webhook-lark] Lark API error:', result);
      return res.status(500).json({ error: 'Lark API error', data: result });
    }

  } catch (err) {
    console.error('❌ [webhook-lark] Critical error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
}
