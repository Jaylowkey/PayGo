import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// ✅ Configurações Globais
const WHATSAPP_NUMBER = '258871002255';
const FROM_EMAIL = 'PayGo Moçambique <noreply@paygo.co.mz>';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { to, subject, template, variables, type, sendLark = false } = req.body;

    if (!to || !template) {
      return res.status(400).json({ error: 'Faltam campos obrigatórios: to, template' });
    }

    console.log(`📧 [send-email] Processando Template: ${template} para: ${to}`);

    const html = generateEmailHTML(template, variables || {});
    const text = generateEmailText(template, variables || {});
    const results = { email: null, lark: null };

    // ========================================================================
    // 1. ENVIAR EMAIL (RESEND)
    // ========================================================================
    if (process.env.RESEND_API_KEY) {
      const { data, error } = await resend.emails.send({
        from: FROM_EMAIL,
        to: [to],
        subject: subject || getFallbackSubject(template, variables || {}),
        html,
        text,
        headers: {
          'X-PayGo-Template': template,
          'X-PayGo-Type': type || 'transactional',
          'X-PayGo-Version': '2.2'
        }
      });

      if (error) {
        console.error('❌ [send-email] Erro Resend:', error);
        results.email = { success: false, error: error.message };
      } else {
        results.email = { success: true, id: data?.id };
      }
    } else {
      results.email = { success: false, error: 'Sem API KEY da Resend' };
    }

    // ========================================================================
    // 2. ENVIAR NOTIFICAÇÃO PARA O LARK
    // ========================================================================
    if (sendLark && process.env.LARK_WEBHOOK_URL) {
      results.lark = await sendLarkNotification(template, variables || {});
    }

    return res.status(200).json({ success: true, results, template });
  } catch (err) {
    console.error('❌ [send-email] Critical error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err.message
    });
  }
}

// ==========================================
// 🎨 GERADOR DE HTML
// ==========================================
function generateEmailHTML(template, vars) {
  const escape = (str) => {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_SITE_URL || 'https://paygo.co.mz';

  const waLink = getWhatsAppLink(
    vars.order_id,
    vars.customer_name,
    vars.total_amount,
    vars.payment_method
  );

  const totalFormatted = vars.total_amount
    ? Number(vars.total_amount).toLocaleString('pt-MZ', { minimumFractionDigits: 2 })
    : '0.00';

  const isBank = String(vars.payment_method || '').includes('transferencia');

  const baseStyles = `<style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
    body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #f8fafc; margin: 0; padding: 40px 20px; color: #1e293b; -webkit-font-smoothing: antialiased; }
    .wrapper { max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 20px; overflow: hidden; box-shadow: 0 10px 40px -10px rgba(0,0,0,0.08); border: 1px solid #f1f5f9; }
    .header-gradient { background: linear-gradient(135deg, #2563eb, #06b6d4); padding: 4px; }
    .logo-container { padding: 32px 32px 16px 32px; text-align: center; }
    .logo-container h1 { margin: 0; color: #0f172a; font-size: 28px; font-weight: 800; letter-spacing: -1px; }
    .logo-container h1 span { color: #3b82f6; }
    .content { padding: 0 32px 32px 32px; }
    h2 { margin: 0 0 16px 0; font-size: 22px; font-weight: 700; color: #0f172a; line-height: 1.3; text-align: center; }
    p { margin: 0 0 20px 0; font-size: 15px; line-height: 1.6; color: #475569; }
    .btn { display: block; background: #0f172a; color: #ffffff !important; padding: 16px 24px; border-radius: 12px; text-decoration: none; font-weight: 600; font-size: 15px; text-align: center; margin: 32px 0; box-shadow: 0 10px 15px -3px rgba(15, 23, 42, 0.1); }
    .btn-success { background: #16a34a; }
    .data-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 16px; padding: 24px; margin: 24px 0; }
    .data-card h3 { margin: 0 0 16px 0; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 10px 0; font-size: 14px; border-bottom: 1px dashed #e2e8f0; }
    tr:last-child td { border-bottom: none; padding-bottom: 0; }
    .label { color: #64748b; width: 40%; font-weight: 500; }
    .value { color: #0f172a; font-weight: 600; text-align: right; }
    .total-row td { padding-top: 16px; border-top: 2px solid #cbd5e1; font-size: 18px; font-weight: 800; }
    .total-value { color: #16a34a; }
    .footer { padding: 32px; background: #f8fafc; text-align: center; border-top: 1px solid #e2e8f0; }
    .footer p { margin: 0 0 8px 0; font-size: 12px; color: #94a3b8; }
    .brand-claim { font-weight: 700; color: #64748b !important; }
    a { color: #3b82f6; text-decoration: none; }
    .code-highlight { background: #f0fdf4; border: 2px dashed #22c55e; color: #166534; padding: 20px; border-radius: 12px; text-align: center; font-size: 24px; font-weight: 800; letter-spacing: 2px; margin: 24px 0; }
  </style>`;

  const htmlStart = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${baseStyles}</head><body><div class="wrapper"><div class="header-gradient"></div><div class="logo-container"><h1>Pay<span>Go</span></h1></div><div class="content">`;
  const htmlEnd = `</div><div class="footer"><p class="brand-claim">Simples. Seguro. Moçambicano. 🇲🇿</p><p>PayGo Serviços Digitais &copy; ${new Date().getFullYear()}</p><p>Suporte: contact@paygo.co.mz | WhatsApp: +258 87 100 2255</p></div></div></body></html>`;

  switch (template) {
    case 'order-confirmation':
      return `<!DOCTYPE html><html lang="pt-MZ"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f8fafc; margin: 0; padding: 20px; color: #1e293b; } .c { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.1); } .h { background: linear-gradient(135deg, #3b82f6, #1d4ed8); padding: 32px 24px; text-align: center; color: #fff; } .h h1 { margin: 0; font-size: 24px; font-weight: 700; } .p { padding: 32px 24px; } .s { background: #f8fafc; border: 1px solid #e2e8f0; padding: 20px; border-radius: 12px; margin: 20px 0; } .s p { margin: 8px 0; font-size: 14px; } .a { background: #fffbeb; border: 1px solid #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0; } .a p { margin: 0; color: #92400e; font-size: 14px; } .cta { text-align: center; margin-top: 30px; } .b { background: #25D366; color: #fff; padding: 16px 32px; text-decoration: none; border-radius: 12px; font-weight: 600; display: inline-block; font-size: 16px; } .f { background: #f8fafc; padding: 24px; text-align: center; color: #64748b; font-size: 12px; border-top: 1px solid #e2e8f0; }</style></head><body><div class="c"><div class="h"><h1>🛒 Pedido Registado!</h1></div><div class="p"><p>Olá, <strong>${escape(vars.customer_name)}</strong>.</p><p>O seu pedido <strong>#${escape(vars.order_id)}</strong> foi recebido e está na fila de processamento.</p><div class="s"><h3 style="margin-top: 0; font-size: 16px; color: #334155;">💰 Resumo do Pedido</h3><p><strong>Total a Pagar:</strong> ${totalFormatted} MT</p><p><strong>Método de Pagamento:</strong> ${escape(vars.payment_method || 'N/A').toUpperCase()}</p><p><strong>Categoria:</strong> ${vars.type === 'compra' ? '🛍️ Compras' : '🎮 Serviços'}</p>${vars.usd_amount ? `<p><strong>Valor USD:</strong> $${escape(vars.usd_amount)}</p>` : ''}</div>${isBank ? `<div class="a"><p>⚠️ <strong>Atenção:</strong> Como escolheu transferência bancária, envie o comprovativo via WhatsApp para validação.</p></div>` : `<p style="color: #64748b; font-size: 14px; text-align: center; margin: 20px 0;">🔔 Receberá em breve um pedido de PIN no seu telemóvel para autorizar a transação via M-Pesa/e-Mola.</p>`}<div class="cta"><a href="${waLink}" class="b" target="_blank">💬 Finalizar via WhatsApp</a></div></div><div class="f"><strong>PayGo Moçambique</strong> - O Mundo no seu Bolso 🇲🇿<br>Suporte: contact@paygo.co.mz | WhatsApp: +258 87 100 2255</div></div></body></html>`;

    case 'payment-confirmed':
      return `<!DOCTYPE html><html lang="pt-MZ"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body { font-family: -apple-system, sans-serif; background: #f8fafc; margin: 0; padding: 20px; color: #1e293b; } .c { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.1); border-top: 6px solid #22c55e; } .h { padding: 32px 24px; text-align: center; } .h h1 { color: #16a34a; margin: 0; font-size: 26px; } .p { padding: 0 24px 32px; } .sbox { background: #f0fdf4; border: 1px solid #bbf7d0; padding: 20px; border-radius: 12px; margin: 20px 0; text-align: center; } .sbox p { margin: 0; color: #166534; font-weight: 500; } .s { background: #f8fafc; border: 1px solid #e2e8f0; padding: 20px; border-radius: 12px; margin: 20px 0; } .cta { text-align: center; margin-top: 30px; } .b { background: #3b82f6; color: #fff; padding: 14px 28px; text-decoration: none; border-radius: 12px; font-weight: 600; display: inline-block; font-size: 15px; } .f { background: #f8fafc; padding: 24px; text-align: center; color: #64748b; font-size: 12px; border-top: 1px solid #e2e8f0; }</style></head><body><div class="c"><div class="h"><h1>✅ Pagamento Recebido!</h1></div><div class="p"><p>Olá, <strong>${escape(vars.customer_name)}</strong>.</p><p>Recebemos o seu pagamento do pedido <strong>#${escape(vars.order_id)}</strong>.</p><div class="sbox"><p>🎉 O seu pagamento de <strong>${totalFormatted} MT</strong> foi confirmado!</p></div><p style="color: #475569; line-height: 1.6;">O seu pedido está agora <strong>em processamento</strong>. A nossa equipa irá efetuar a compra e notificar-lhe em breve.</p><div class="s"><h3 style="margin-top: 0; font-size: 16px; color: #334155;">📋 Detalhes</h3><p style="margin: 5px 0;"><strong>ID do Pedido:</strong> #${escape(vars.order_id)}</p><p style="margin: 5px 0;"><strong>Status:</strong> 🔄 Em Processamento</p></div><div class="cta"><a href="${waLink}" class="b" target="_blank">📊 Acompanhar no WhatsApp</a></div></div><div class="f"><strong>PayGo Moçambique</strong> 🇲🇿</div></div></body></html>`;

    case 'order-processing':
      return `${htmlStart}<h2>Pedido em Processamento 🔄</h2><p>Olá, <strong>${escape(vars.customer_name)}</strong>.</p><p>A sua compra (Pedido <strong>#${escape(vars.order_id)}</strong>) está neste momento a ser efetuada pelos nossos agentes na plataforma de destino.</p><div class="data-card" style="border-color: #bfdbfe; background: #eff6ff;"><h3 style="color: #1e40af;">Status Atualizado</h3><table><tr><td class="label" style="color: #1e40af;">Fase Atual</td><td class="value" style="color: #1e3a8a;">Processamento Internacional</td></tr></table></div><p style="text-align: center; margin-top: 24px;">Se houver um código de rastreio, será disponibilizado na sua conta em breve.</p><a href="${baseUrl}/login.html" class="btn">Ver Detalhes da Conta</a>${htmlEnd}`;

    case 'order-completed':
      return `${htmlStart}<h2>Pedido Concluído! 🎉</h2><p>Olá, <strong>${escape(vars.customer_name)}</strong>.</p><p>Boas notícias! O seu pedido <strong>#${escape(vars.order_id)}</strong> foi finalizado com sucesso pela nossa equipa.</p><div class="data-card" style="border-color: #bbf7d0; background: #f0fdf4;"><h3 style="color: #166534;">Resumo Final</h3><table><tr><td class="label" style="color: #166534;">Status</td><td class="value" style="color: #14532d;">Despachado / Concluído ✅</td></tr></table></div><p style="text-align: center; margin-top: 32px;">Se a sua compra incluiu produtos físicos, verifique o código de rastreio na sua conta PayGo.</p><a href="${baseUrl}/login.html" class="btn btn-success">Aceder à Minha Conta</a>${htmlEnd}`;

    case 'password-reset':
      return `${htmlStart}<h2>Recuperação de Senha 🔐</h2><p>Recebemos um pedido para redefinir a palavra-passe da sua conta.</p><a href="${vars.reset_link || '#'}" class="btn">Redefinir Palavra-passe</a>${htmlEnd}`;

    case 'email-verification':
      return `${htmlStart}<h2>Verifique o seu E-mail 🛡️</h2><p>Confirme a sua conta para desbloquear todas as funcionalidades da PayGo.</p><a href="${baseUrl}/seguranca.html?mode=verifyEmail&oobCode=${escape(
        vars.verificationToken || ''
      )}" class="btn btn-success">Verificar E-mail</a>${htmlEnd}`;

    case 'welcome':
      return `${htmlStart}<h2>Bem-vindo à PayGo 🚀</h2><p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>.</p><p>A sua conta está ativa e pronta para usar.</p>${
        vars.affiliate_code
          ? `<div class="data-card"><h3>Código Promocional</h3><div class="code-highlight">${escape(vars.affiliate_code)}</div></div>`
          : ''
      }<a href="${baseUrl}/login.html" class="btn">Aceder à Conta</a>${htmlEnd}`;

    default:
      return `${htmlStart}<h2>Notificação PayGo</h2><p>${escape(vars.message || 'Mensagem indisponível.')}</p>${htmlEnd}`;
  }
}

// ==========================================
// 📝 GERADOR DE TEXTO
// ==========================================
function generateEmailText(template, vars) {
  const footer = `\n\n---\nPayGo Moçambique\nWhatsApp: +258 87 100 2255`;
  const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://paygo.co.mz';

  switch (template) {
    case 'order-confirmation':
      return `PEDIDO #${vars.order_id} REGISTADO ✅\nTotal a Pagar: ${vars.total_amount} MT\n\nAceda à sua conta para proceder ao pagamento.${footer}`;
    case 'payment-confirmed':
      return `PAGAMENTO RECEBIDO 💸\nRecebemos o seu pagamento de ${vars.total_amount} MT para o pedido #${vars.order_id}.\nO seu pedido encontra-se em processamento.${footer}`;
    case 'order-processing':
      return `PEDIDO EM PROCESSAMENTO 🔄\nO seu pedido #${vars.order_id} está a ser efetuado na plataforma de destino.${footer}`;
    case 'order-completed':
      return `PEDIDO CONCLUÍDO 🎉\nO seu pedido #${vars.order_id} foi finalizado com sucesso.${footer}`;
    case 'password-reset':
      return `RECUPERAÇÃO DE SENHA\nAcesse o link para criar uma nova: ${vars.reset_link}${footer}`;
    case 'email-verification':
      return `CONFIRME O SEU E-MAIL\nAceda a: ${baseUrl}/seguranca.html?mode=verifyEmail&oobCode=${vars.verificationToken}${footer}`;
    case 'welcome':
      return `BEM-VINDO À PAYGO! 🚀\nA sua conta está ativada. ${vars.affiliate_code ? `\n\n🎁 Seu código promocional: ${vars.affiliate_code}` : ''}${footer}`;
    default:
      return `${String(vars.message || '').replace(/<[^>]*>?/gm, '')}${footer}`;
  }
}

function getFallbackSubject(template, vars) {
  switch (template) {
    case 'order-confirmation':
      return `🛒 Pedido ${vars.order_id || ''} Registado - PayGo`;
    case 'payment-confirmed':
      return `✅ Pagamento Recebido - Pedido ${vars.order_id || ''}`;
    case 'order-processing':
      return `🔄 O seu Pedido ${vars.order_id || ''} está em processamento`;
    case 'order-completed':
      return `🎉 Pedido ${vars.order_id || ''} Concluído - PayGo`;
    case 'password-reset':
      return '🔐 Recuperação de Senha - PayGo';
    case 'email-verification':
      return '🛡️ Verifique o seu e-mail da PayGo';
    case 'welcome':
      return '🚀 Bem-vindo ao Mundo Global PayGo!';
    default:
      return 'Notificação PayGo Moçambique';
  }
}

function getWhatsAppLink(orderId, name, total, method) {
  const isTransfer = String(method || '').includes('transferencia');
  const actionText = isTransfer ? 'enviar o comprovativo do meu pagamento' : 'finalizar o meu pedido';
  const msg = `*OLÁ PAYGO!* 👋

Gostaria de ${actionText}.

*DADOS DO PEDIDO:*
🆔 ID: #${orderId || 'N/A'}
👤 Cliente: ${name || 'N/A'}
💰 Valor: ${total || '0'} MT
💳 Método: ${String(method || 'N/A').toUpperCase()}

_Aguardo instruções._`;

  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;
}

// ==========================================
// 🔔 MÓDULO DE NOTIFICAÇÃO LARK
// ==========================================
async function sendLarkNotification(template, vars) {
  try {
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.NEXT_PUBLIC_SITE_URL || 'https://paygo.co.mz';

    let larkTemplate = 'blue';
    let larkTitle = 'Nova Notificação PayGo';
    let larkFields = [];

    if (template === 'order-confirmation') {
      larkTemplate = 'blue';
      larkTitle = '🛒 Novo Pedido Registado';
      larkFields = [
        { is_short: true, text: { tag: 'lark_md', content: `**ID:**\n#${vars.order_id}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**Cliente:**\n${vars.customer_name}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**Total:**\n${vars.total_amount} MT` } },
        { is_short: true, text: { tag: 'lark_md', content: `**Método:**\n${String(vars.payment_method || 'N/A').toUpperCase()}` } }
      ];
    } else if (template === 'payment-confirmed') {
      larkTemplate = 'green';
      larkTitle = '✅ PAGAMENTO RECEBIDO';
      larkFields = [
        { is_short: true, text: { tag: 'lark_md', content: `**ID:**\n#${vars.order_id}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**Cliente:**\n${vars.customer_name}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**Confirmado:**\n${vars.total_amount} MT` } }
      ];
    } else {
      return { success: true, ignored: true };
    }

    const larkPayload = {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          template: larkTemplate,
          title: { content: larkTitle, tag: 'plain_text' }
        },
        elements: [
          { tag: 'div', fields: larkFields },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: 'Ver no Painel' },
                type: 'primary',
                url: `${baseUrl}/admin/pedidos.html`
              }
            ]
          }
        ]
      }
    };

    const res = await fetch(process.env.LARK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(larkPayload)
    });

    const result = await res.text();
    return { success: res.ok, result };
  } catch (err) {
    console.error('❌ Erro no Lark:', err);
    return { success: false, error: err.message };
  }
}
