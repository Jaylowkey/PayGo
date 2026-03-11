// api/send-email.js
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
    console.warn('⚠️ [send-email] Method not allowed:', req.method);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { to, subject, template, variables, type } = req.body;

    // ✅ Validações básicas
    if (!to || !subject || !template) {
      console.error('❌ [send-email] Missing fields:', { to, subject, template });
      return res.status(400).json({ 
        error: 'Missing required fields: to, subject, template',
        received: { to, subject, template }
      });
    }

    console.log('📧 [send-email] Processing:', { template, to, type }); 

    // ✅ Gerar HTML e texto baseado no template
    const html = generateEmailHTML(template, variables || {});
    const text = generateEmailText(template, variables || {});

    if (!html || html.trim() === '') {
      console.error('❌ [send-email] Empty HTML generated for template:', template);
      return res.status(500).json({ error: 'Failed to generate email content', template });
    }

    // ✅ Enviar email via Resend
    const { data, error } = await resend.emails.send({
      from: 'PayGo Moçambique <noreply@paygo.co.mz>',
      to: [to],
      subject: subject,
      html: html,
      text: text,
      headers: {
        'X-PayGo-Template': template,
        'X-PayGo-Type': type || 'transactional',
        'X-PayGo-Version': '2.1'
      }
    });

    if (error) {
      console.error('❌ [send-email] Resend API error:', error);
      return res.status(500).json({ error: error.message, resendError: error });
    }

    console.log('✅ [send-email] Email sent:', { to, template, dataId: data?.id });
    return res.status(200).json({ 
      success: true, 
      data,
      message: 'Email enviado com sucesso',
      sentTo: to,
      template: template
    });

  } catch (err) {
    console.error('❌ [send-email] Critical error:', err);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
}

// ==========================================
// 🎨 GERADOR DE HTML - EMAILS PREMIUM
// ==========================================
function generateEmailHTML(template, vars) {
  // ✅ Função de escape segura para evitar XSS, mas mantendo o layout
  const escape = (str) => {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  // ✅ CSS Base - Design Fintech Minimalista e Moderno
  const baseStyles = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
      
      body { 
        font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
        background-color: #f8fafc; 
        margin: 0; 
        padding: 40px 20px; 
        color: #1e293b; 
        -webkit-font-smoothing: antialiased;
      }
      .wrapper {
        max-width: 520px;
        margin: 0 auto;
        background: #ffffff;
        border-radius: 20px;
        overflow: hidden;
        box-shadow: 0 10px 40px -10px rgba(0,0,0,0.08);
        border: 1px solid #f1f5f9;
      }
      .header-gradient {
        background: linear-gradient(135deg, #2563eb, #06b6d4);
        padding: 4px;
      }
      .logo-container {
        padding: 32px 32px 16px 32px;
        text-align: center;
      }
      .logo-container h1 {
        margin: 0;
        color: #0f172a;
        font-size: 28px;
        font-weight: 800;
        letter-spacing: -1px;
      }
      .logo-container h1 span { color: #3b82f6; }
      .content { padding: 0 32px 32px 32px; }
      h2 {
        margin: 0 0 16px 0;
        font-size: 22px;
        font-weight: 700;
        color: #0f172a;
        line-height: 1.3;
        text-align: center;
      }
      p {
        margin: 0 0 20px 0;
        font-size: 15px;
        line-height: 1.6;
        color: #475569;
      }
      .btn { 
        display: block; 
        background: #0f172a; 
        color: #ffffff !important; 
        padding: 16px 24px; 
        border-radius: 12px; 
        text-decoration: none; 
        font-weight: 600; 
        font-size: 15px; 
        text-align: center;
        transition: transform 0.2s, box-shadow 0.2s;
        margin: 32px 0;
        box-shadow: 0 10px 15px -3px rgba(15, 23, 42, 0.1);
      }
      .btn-success { background: #16a34a; box-shadow: 0 10px 15px -3px rgba(22, 163, 74, 0.2); }
      .data-card {
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 16px;
        padding: 24px;
        margin: 24px 0;
      }
      .data-card h3 {
        margin: 0 0 16px 0;
        font-size: 12px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: #64748b;
      }
      table { width: 100%; border-collapse: collapse; }
      td { padding: 10px 0; font-size: 14px; border-bottom: 1px dashed #e2e8f0; }
      tr:last-child td { border-bottom: none; padding-bottom: 0; }
      .label { color: #64748b; width: 40%; font-weight: 500; }
      .value { color: #0f172a; font-weight: 600; text-align: right; }
      .total-row td {
        padding-top: 16px;
        border-top: 2px solid #cbd5e1;
        font-size: 18px;
        font-weight: 800;
      }
      .total-value { color: #16a34a; }
      .notice {
        background: #eff6ff;
        border-left: 4px solid #3b82f6;
        padding: 16px;
        border-radius: 4px 12px 12px 4px;
        margin: 24px 0;
      }
      .notice p { margin: 0; font-size: 14px; color: #1e40af; }
      .code-highlight {
        background: #f0fdf4;
        border: 2px dashed #22c55e;
        color: #166534;
        padding: 20px;
        border-radius: 12px;
        text-align: center;
        font-size: 24px;
        font-weight: 800;
        letter-spacing: 2px;
        margin: 24px 0;
      }
      .footer { 
        padding: 32px; 
        background: #f8fafc;
        text-align: center; 
        border-top: 1px solid #e2e8f0; 
      }
      .footer p { 
        margin: 0 0 8px 0; 
        font-size: 12px; 
        color: #94a3b8; 
      }
      .brand-claim {
        font-weight: 700;
        color: #64748b !important;
      }
      a { color: #3b82f6; text-decoration: none; }
    </style>
  `;

  // URL base adaptável (local ou produção)
  const baseUrl = process.env.VERCEL_URL 
    ? `https://${process.env.VERCEL_URL}` 
    : (process.env.NEXT_PUBLIC_SITE_URL || 'https://paygo.co.mz');

  const htmlStart = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${baseStyles}</head><body><div class="wrapper"><div class="header-gradient"></div><div class="logo-container"><h1>Pay<span>Go</span></h1></div><div class="content">`;
  const htmlEnd = `</div><div class="footer"><p class="brand-claim">Simples. Seguro. Moçambicano. 🇲🇿</p><p>PayGo Serviços Digitais &copy; ${new Date().getFullYear()}</p><p>Suporte: contact@paygo.co.mz | WhatsApp: +258 87 100 2255</p></div></div></body></html>`;

  switch (template) {
    
    // 💸 PAGAMENTO CONFIRMADO (Novo Template)
    case 'payment-confirmed': {
      return `${htmlStart}
        <h2>💸 Pagamento Recebido!</h2>
        <p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>.</p>
        <p>Confirmamos a receção do seu pagamento. O seu pedido está agora a ser processado pela nossa equipa.</p>
        
        <div class="data-card">
          <h3>Detalhes da Transação</h3>
          <table>
            <tr><td class="label">Pedido N.º</td><td class="value">#${escape(vars.order_id || 'N/A')}</td></tr>
            <tr><td class="label">Valor Recebido</td><td class="value total-value">${escape(vars.amount || '0.00 MT')}</td></tr>
            <tr><td class="label">Status</td><td class="value" style="color:#d97706;">Em Processamento 🔄</td></tr>
          </table>
        </div>
        
        <div class="notice">
          <p><strong>Próximos Passos:</strong> A nossa equipa já está a tratar da sua compra/serviço. Receberá uma nova notificação assim que tudo estiver finalizado.</p>
        </div>
        <a href="${baseUrl}" class="btn">Acompanhar no Site</a>
      ${htmlEnd}`;
    }

    // 🎉 PEDIDO CONCLUÍDO (Novo Template)
    case 'order-completed': {
      return `${htmlStart}
        <h2>🎉 Pedido Concluído!</h2>
        <p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>.</p>
        <p>Temos boas notícias! O seu pedido foi processado e finalizado com sucesso.</p>
        
        <div class="data-card" style="border-color: #bbf7d0; background: #f0fdf4;">
          <h3 style="color: #166534;">Resumo do Pedido #${escape(vars.order_id || 'N/A')}</h3>
          <table>
            <tr><td class="label" style="color: #166534;">Serviço</td><td class="value" style="color: #14532d;">Entregue / Finalizado ✅</td></tr>
            <tr><td class="label" style="color: #166534;">Data</td><td class="value" style="color: #14532d;">${new Date().toLocaleDateString('pt-MZ')}</td></tr>
          </table>
        </div>
        
        <p style="text-align: center; margin-top: 32px;">Obrigado pela confiança na PayGo.<br>Estamos sempre aqui para ajudar nas suas compras globais!</p>
        <a href="${baseUrl}" class="btn btn-success">Fazer Novo Pedido</a>
      ${htmlEnd}`;
    }

    // ✅ CONFIRMAÇÃO DE PEDIDO (Nova Encomenda Inicial)
    case 'order-confirmation': {
      return `${htmlStart}
        <h2>O seu pedido foi recebido. 🛒</h2>
        <p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>. O seu pedido <strong>#${escape(vars.order_id || 'N/A')}</strong> deu entrada no nosso sistema.</p>
        
        <div class="data-card">
          <h3>Resumo Financeiro</h3>
          <table>
            <tr><td class="label">Valor Original</td><td class="value">$${escape(vars.usd_amount || '0.00')}</td></tr>
            <tr><td class="label">Taxa PayGo</td><td class="value">${escape(vars.tax_amount || '0.00 MT')}</td></tr>
            <tr class="total-row">
              <td class="label">TOTAL A PAGAR</td>
              <td class="value total-value">${escape(vars.total_amount || '0.00 MT')}</td>
            </tr>
          </table>
        </div>

        <div style="background: #eef2ff; border-radius: 12px; padding: 24px; margin-top: 24px;">
          <h4 style="margin: 0 0 12px 0; color: #1e3a8a; font-size: 14px; text-transform: uppercase; text-align: center;">📥 Como Finalizar</h4>
          <p style="font-size: 14px; color: #1e40af; text-align: center;">Para iniciarmos a compra, envie o valor total para uma das nossas contas e partilhe o comprovativo:</p>
          <div style="background: #ffffff; padding: 16px; border-radius: 8px; margin: 16px 0; text-align: center;">
            <p style="margin: 0; font-size: 16px; font-weight: 700; color: #0f172a;">e-Mola: 87 100 2255</p>
            <p style="margin: 8px 0 0 0; font-size: 16px; font-weight: 700; color: #0f172a;">M-Pesa: 84 100 2255</p>
          </div>
          <a href="https://wa.me/258871002255" class="btn" style="margin: 0; background: #25d366;">Enviar Comprovativo no WhatsApp</a>
        </div>
      ${htmlEnd}`;
    }

    // 🔐 VERIFICAÇÃO DE EMAIL
    case 'email-verification': {
      const verifyLink = `${baseUrl}/verify-email.html?token=${vars.verificationToken || 'DEMO_TOKEN'}&email=${encodeURIComponent(vars.email || '')}`;
      return `${htmlStart}
        <h2>Confirme o seu e-mail</h2>
        <p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>.</p>
        <p>Para garantir a segurança da sua conta e poder efetuar pagamentos, precisamos que valide este endereço.</p>
        <a href="${verifyLink}" class="btn">Validar o Meu E-mail</a>
        <p style="font-size: 12px; text-align: center; color: #94a3b8;">Este link expira em 24 horas.</p>
      ${htmlEnd}`;
    }

    // 🎉 BEM-VINDO (Após verificação)
    case 'welcome': {
      const hasAffiliateCode = vars.affiliate_code && vars.affiliate_code.trim() !== '' && vars.affiliate_code !== 'null';
      return `${htmlStart}
        <h2>Bem-vindo à PayGo! 🚀</h2>
        <p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>. A sua conta foi ativada com sucesso.</p>
        <p>Já pode fazer compras internacionais no AliExpress, Shein ou Amazon, pagando em Meticais com o seu M-Pesa ou e-Mola.</p>
        <a href="${baseUrl}" class="btn">Ir para a Plataforma</a>
        
        ${hasAffiliateCode ? `
        <div style="text-align: center; margin-top: 40px; border-top: 1px solid #e2e8f0; padding-top: 32px;">
          <p style="font-size: 12px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em;">🎁 O seu Código Promocional</p>
          <div class="code-highlight">${escape(vars.affiliate_code)}</div>
          <p style="font-size: 14px; color: #475569;">Indique amigos e ganhe <strong>3%</strong> na primeira compra deles!</p>
        </div>
        ` : ''}
      ${htmlEnd}`;
    }

    // 📧 DEFAULT (Fallback para mensagens dinâmicas)
    default:
      // O default original causava problemas com mensagens do dashboard, 
      // Por isso, aqui inserimos a mensagem sem usar o escape() para permitir formatação HTML vinda do dashboard
      return `${htmlStart}
        <h2>Notificação PayGo</h2>
        <div style="background: #f8fafc; padding: 24px; border-radius: 12px; color: #1e293b; line-height: 1.6; border: 1px solid #e2e8f0;">
          ${vars.message || 'Recebeu uma nova notificação do nosso sistema.'}
        </div>
        <a href="${baseUrl}" class="btn" style="margin-bottom:0;">Aceder à PayGo</a>
      ${htmlEnd}`;
  }
}

// ==========================================
// 📝 GERADOR DE TEXTO PLAIN (Fallback para clientes antigos)
// ==========================================
function generateEmailText(template, vars) {
  const escape = (str) => {
    if (str === null || str === undefined) return '';
    return String(str);
  };

  const footer = `\n\n---\nPayGo Moçambique - Simples. Seguro. Moçambicano. 🇲🇿\nSuporte: contact@paygo.co.mz | WhatsApp: +258 87 100 2255`;
  const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://paygo.co.mz';

  switch (template) {
    case 'payment-confirmed':
      return `PAGAMENTO RECEBIDO ✅\n\nOlá ${escape(vars.customer_name)},\nConfirmamos a receção do pagamento de ${escape(vars.amount)} referente ao pedido #${escape(vars.order_id)}.\nO seu pedido está agora em processamento.\n${footer}`;
    
    case 'order-completed':
      return `PEDIDO CONCLUÍDO 🎉\n\nOlá ${escape(vars.customer_name)},\nO seu pedido #${escape(vars.order_id)} foi finalizado e entregue com sucesso.\nObrigado por usar a PayGo!${footer}`;

    case 'email-verification': 
      return `CONFIRME O SEU E-MAIL - PAYGO\n\nOlá ${escape(vars.customer_name)},\nPara ativar a conta, aceda a: ${baseUrl}/verify-email.html?token=${vars.verificationToken}&email=${encodeURIComponent(vars.email)}${footer}`;
    
    case 'welcome': 
      let msg = `BEM-VINDO À PAYGO! 🚀\n\nA sua conta está ativada. Pode aceder em: ${baseUrl}`;
      if (vars.affiliate_code) msg += `\n\n🎁 Seu código de afiliado: ${escape(vars.affiliate_code)}`;
      return msg + footer;
    
    case 'order-confirmation':
      return `PEDIDO #${escape(vars.order_id)} REGISTADO ✅\n\nTotal a Pagar: ${escape(vars.total_amount)}\n\nEnvie o valor para e-Mola (871002255) ou M-Pesa (841002255) e mande o comprovativo no WhatsApp.${footer}`;
      
    default:
      // Remove tags HTML na versão de texto puro
      const cleanText = (vars.message || '').replace(/<[^>]*>?/gm, '');
      return `${cleanText}${footer}`;
  }
}
