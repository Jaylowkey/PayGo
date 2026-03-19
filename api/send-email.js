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
    
    // 🔐 RECUPERAÇÃO DE SENHA
    case 'password-reset': {
      return `${htmlStart}
        <h2>Recuperação de Senha 🔐</h2>
        <p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>.</p>
        <p>Recebemos um pedido para redefinir a palavra-passe da sua conta PayGo. Clique no botão abaixo para criar uma nova senha de forma segura.</p>
        <a href="${escape(vars.reset_link)}" class="btn">Redefinir Palavra-passe</a>
        <p style="font-size: 13px; color: #94a3b8; margin-top: 24px; text-align: center;">Se não solicitou esta alteração, por favor ignore este e-mail. A sua conta permanecerá segura.</p>
      ${htmlEnd}`;
    }

    // 🆕 CONFIRMAÇÃO DE PEDIDO INICIAL
    case 'order-confirmation': {
      return `${htmlStart}
        <h2>O seu pedido foi registado. 🛒</h2>
        <p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>. O seu pedido <strong>#${escape(vars.order_id || 'N/A')}</strong> deu entrada no nosso sistema de forma segura.</p>
        
        <div class="data-card">
          <h3>Resumo Financeiro</h3>
          <table>
            <tr><td class="label">Valor em USD</td><td class="value">$${escape(vars.usd_amount || '0.00')}</td></tr>
            <tr><td class="label">Taxa PayGo</td><td class="value">${escape(vars.tax_amount || '0.00 MT')}</td></tr>
            <tr class="total-row">
              <td class="label">TOTAL A PAGAR</td>
              <td class="value total-value">${escape(vars.total_amount || '0.00 MT')}</td>
            </tr>
          </table>
        </div>

        <div style="background: #eef2ff; border-radius: 12px; padding: 24px; margin-top: 24px;">
          <h4 style="margin: 0 0 12px 0; color: #1e3a8a; font-size: 14px; text-transform: uppercase; text-align: center;">📥 Como Finalizar</h4>
          <p style="font-size: 14px; color: #1e40af; text-align: center;">Para iniciarmos a compra, aceda ao link abaixo para realizar o pagamento através da PaySuite ou envie o valor para as nossas contas oficiais:</p>
          <div style="background: #ffffff; padding: 16px; border-radius: 8px; margin: 16px 0; text-align: center;">
            <p style="margin: 0; font-size: 16px; font-weight: 700; color: #0f172a;">e-Mola: 87 100 2255</p>
            <p style="margin: 8px 0 0 0; font-size: 16px; font-weight: 700; color: #0f172a;">M-Pesa: 84 100 2255</p>
          </div>
          <a href="${baseUrl}/login.html" class="btn" style="margin: 0; background: #2563eb;">Aceder à Minha Conta</a>
        </div>
      ${htmlEnd}`;
    }

    // 💸 PAGAMENTO CONFIRMADO
    case 'payment-confirmed': {
      return `${htmlStart}
        <h2>Pagamento Recebido! 💸</h2>
        <p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>.</p>
        <p>Confirmamos a receção do seu pagamento. O seu pedido encontra-se agora na nossa fila prioritária de processamento.</p>
        
        <div class="data-card">
          <h3>Detalhes da Transação</h3>
          <table>
            <tr><td class="label">Pedido N.º</td><td class="value">#${escape(vars.order_id || 'N/A')}</td></tr>
            <tr><td class="label">Valor Validado</td><td class="value total-value">${escape(vars.amount || '0.00 MT')}</td></tr>
            <tr><td class="label">Status</td><td class="value" style="color:#2563eb;">Na Fila ⏳</td></tr>
          </table>
        </div>
        
        <div class="notice">
          <p><strong>O que se segue?</strong> A nossa equipa administrativa já está a efetuar a compra internacional. Receberá atualizações assim que houver novidades.</p>
        </div>
        <a href="${baseUrl}/login.html" class="btn">Acompanhar Pedido</a>
      ${htmlEnd}`;
    }

    // 🔄 PEDIDO EM PROCESSAMENTO
    case 'order-processing': {
      return `${htmlStart}
        <h2>Pedido em Processamento 🔄</h2>
        <p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>.</p>
        <p>A sua compra (Pedido <strong>#${escape(vars.order_id || 'N/A')}</strong>) está neste momento a ser efetuada pelos nossos agentes na plataforma de destino (AliExpress, Amazon, etc).</p>
        
        <div class="data-card" style="border-color: #bfdbfe; background: #eff6ff;">
          <h3 style="color: #1e40af;">Status Atualizado</h3>
          <table>
            <tr><td class="label" style="color: #1e40af;">Fase Atual</td><td class="value" style="color: #1e3a8a;">Processamento Internacional</td></tr>
          </table>
        </div>
        <p style="text-align: center; margin-top: 24px;">Se houver um código de rastreio (tracking code), este será disponibilizado na sua conta em breve.</p>
        <a href="${baseUrl}/login.html" class="btn">Ver Detalhes da Conta</a>
      ${htmlEnd}`;
    }

    // 🎉 PEDIDO CONCLUÍDO
    case 'order-completed': {
      return `${htmlStart}
        <h2>Pedido Concluído! 🎉</h2>
        <p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>.</p>
        <p>Boas notícias! O seu pedido <strong>#${escape(vars.order_id || 'N/A')}</strong> foi processado e finalizado com sucesso pela nossa equipa.</p>
        
        <div class="data-card" style="border-color: #bbf7d0; background: #f0fdf4;">
          <h3 style="color: #166534;">Resumo Final</h3>
          <table>
            <tr><td class="label" style="color: #166534;">Status</td><td class="value" style="color: #14532d;">Finalizado / Despachado ✅</td></tr>
            <tr><td class="label" style="color: #166534;">Data</td><td class="value" style="color: #14532d;">${new Date().toLocaleDateString('pt-MZ')}</td></tr>
          </table>
        </div>
        
        <p style="text-align: center; margin-top: 32px;">Se a sua compra incluiu produtos físicos, verifique o código de rastreio na sua conta PayGo. Obrigado pela confiança!</p>
        <a href="${baseUrl}" class="btn btn-success">Fazer Nova Compra</a>
      ${htmlEnd}`;
    }

    // ❌ PEDIDO CANCELADO
    case 'order-cancelled': {
      return `${htmlStart}
        <h2>Pedido Cancelado ❌</h2>
        <p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>.</p>
        <p>Informamos que o seu pedido <strong>#${escape(vars.order_id || 'N/A')}</strong> foi cancelado pelo nosso sistema administrativo.</p>
        
        <div class="data-card" style="border-color: #fecaca; background: #fef2f2;">
          <h3 style="color: #991b1b;">Informação Logística</h3>
          <table>
            <tr><td class="label" style="color: #991b1b;">Status</td><td class="value" style="color: #7f1d1d;">Cancelado</td></tr>
          </table>
        </div>
        <p style="text-align: center; margin-top: 24px;">Isto pode ocorrer devido a produtos esgotados, links inválidos ou falhas no pagamento. Por favor, contacte o nosso suporte para mais detalhes ou reembolso.</p>
        <a href="https://wa.me/258871002255" class="btn" style="background: #dc2626;">Falar com o Suporte</a>
      ${htmlEnd}`;
    }

    // 🛡 VERIFICAÇÃO DE EMAIL
    case 'email-verification': {
      const verifyLink = `${baseUrl}/verify-email.html?token=${vars.verificationToken || 'DEMO_TOKEN'}&email=${encodeURIComponent(vars.email || '')}`;
      return `${htmlStart}
        <h2>Confirme o seu e-mail 🛡️</h2>
        <p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>.</p>
        <p>Para garantir a segurança máxima da sua conta PayGo e ativar os seus pagamentos, precisamos que valide este endereço de e-mail.</p>
        <a href="${verifyLink}" class="btn">Validar a Minha Conta</a>
        <p style="font-size: 12px; text-align: center; color: #94a3b8; margin-top: 20px;">Este link de segurança expira em 24 horas.</p>
      ${htmlEnd}`;
    }

    // 🚀 BEM-VINDO
    case 'welcome': {
      const hasAffiliateCode = vars.affiliate_code && vars.affiliate_code.trim() !== '' && vars.affiliate_code !== 'null';
      return `${htmlStart}
        <h2>Bem-vindo à PayGo! 🚀</h2>
        <p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>. A sua conta foi ativada com sucesso e já faz parte da nossa plataforma.</p>
        <p>A partir de agora, o comércio global não tem fronteiras. Compre no AliExpress, Amazon, Shein, pague serviços ou subscreva plataformas diretamente com o seu M-Pesa ou e-Mola.</p>
        <a href="${baseUrl}/login.html" class="btn">Aceder à Plataforma</a>
        
        ${hasAffiliateCode ? `
        <div style="text-align: center; margin-top: 40px; border-top: 1px solid #e2e8f0; padding-top: 32px;">
          <p style="font-size: 12px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em;">🎁 O seu Código Promocional</p>
          <div class="code-highlight">${escape(vars.affiliate_code)}</div>
          <p style="font-size: 14px; color: #475569;">Indique amigos usando o seu código e ganhe comissões na primeira compra deles!</p>
        </div>
        ` : ''}
      ${htmlEnd}`;
    }

    // 📧 DEFAULT (Fallback Customizado do Admin Dashboard)
    default:
      // Aqui inserimos a mensagem sem usar o escape() para permitir a formatação HTML vinda do painel de administração
      return `${htmlStart}
        <h2>Notificação Oficial PayGo</h2>
        <div style="background: #f8fafc; padding: 24px; border-radius: 12px; color: #1e293b; line-height: 1.6; border: 1px solid #e2e8f0;">
          ${vars.message || 'Recebeu uma nova notificação administrativa do nosso sistema.'}
        </div>
        <a href="${baseUrl}/login.html" class="btn" style="margin-bottom:0;">Aceder à Minha Conta</a>
      ${htmlEnd}`;
  }
}

// ==========================================
// 📝 GERADOR DE TEXTO PLAIN (Fallback)
// ==========================================
function generateEmailText(template, vars) {
  const escape = (str) => {
    if (str === null || str === undefined) return '';
    return String(str);
  };

  const footer = `\n\n---\nPayGo Moçambique - Simples. Seguro. Moçambicano. 🇲🇿\nSuporte: contact@paygo.co.mz | WhatsApp: +258 87 100 2255`;
  const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://paygo.co.mz';

  switch (template) {
    case 'password-reset':
      return `RECUPERAÇÃO DE SENHA\n\nOlá ${escape(vars.customer_name)},\nRecebemos um pedido para redefinir a sua senha. Acesse o link abaixo para criar uma nova:\n${escape(vars.reset_link)}${footer}`;

    case 'order-confirmation':
      return `PEDIDO #${escape(vars.order_id)} REGISTADO ✅\n\nOlá ${escape(vars.customer_name)},\nValor do Produto: $${escape(vars.usd_amount)}\nTotal a Pagar: ${escape(vars.total_amount)}\n\nAceda à sua conta para proceder ao pagamento.${footer}`;

    case 'payment-confirmed':
      return `PAGAMENTO RECEBIDO 💸\n\nOlá ${escape(vars.customer_name)},\nConfirmamos a receção de ${escape(vars.amount)} referente ao pedido #${escape(vars.order_id)}.\nO seu pedido encontra-se agora na nossa fila de processamento.${footer}`;
    
    case 'order-processing':
      return `PEDIDO EM PROCESSAMENTO 🔄\n\nOlá ${escape(vars.customer_name)},\nO seu pedido #${escape(vars.order_id)} está neste momento a ser efetuado pelos nossos agentes na plataforma de destino.${footer}`;

    case 'order-completed':
      return `PEDIDO CONCLUÍDO 🎉\n\nOlá ${escape(vars.customer_name)},\nO seu pedido #${escape(vars.order_id)} foi finalizado com sucesso.\nObrigado por escolher a PayGo!${footer}`;

    case 'order-cancelled':
      return `PEDIDO CANCELADO ❌\n\nOlá ${escape(vars.customer_name)},\nO seu pedido #${escape(vars.order_id)} foi cancelado pelo nosso sistema. Contacte o suporte para mais informações.${footer}`;

    case 'email-verification': 
      return `CONFIRME O SEU E-MAIL 🛡️\n\nOlá ${escape(vars.customer_name)},\nPara ativar a conta, aceda a: ${baseUrl}/verify-email.html?token=${vars.verificationToken}&email=${encodeURIComponent(vars.email)}${footer}`;
    
    case 'welcome': 
      let msg = `BEM-VINDO À PAYGO! 🚀\n\nA sua conta está ativada. Pode aceder em: ${baseUrl}`;
      if (vars.affiliate_code) msg += `\n\n🎁 Seu código promocional: ${escape(vars.affiliate_code)}`;
      return msg + footer;
      
    default:
      const cleanText = (vars.message || '').replace(/<[^>]*>?/gm, '');
      return `${cleanText}${footer}`;
  }
}
