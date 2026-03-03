// api/send-email.js
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  // ✅ Apenas POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { to, subject, template, variables, type } = req.body;

    // ✅ Validações básicas
    if (!to || !subject || !template) {
      console.error('❌ Missing fields:', { to, subject, template });
      return res.status(400).json({ 
        error: 'Missing required fields: to, subject, template',
        received: { to, subject, template }
      });
    }

    console.log('📧 Processing email:', { template, to, type });

    // ✅ Gerar HTML e texto baseado no template
    const html = generateEmailHTML(template, variables || {});
    const text = generateEmailText(template, variables || {});

    if (!html || html.trim() === '') {
      console.error('❌ Empty HTML generated for template:', template);
      return res.status(500).json({ error: 'Failed to generate email content', template });
    }

    // ✅ Enviar email via Resend
    const { data, error } = await resend.emails.send({
      from: `PayGo Moçambique <noreply@paygo.co.mz>`,
      to: [to],
      subject: subject,
      html: html,
      text: text,
      headers: {
        'X-PayGo-Template': template,
        'X-PayGo-Type': type || 'transactional',
        'X-PayGo-Version': '2.0'
      }
    });

    if (error) {
      console.error('❌ Resend API error:', error);
      return res.status(500).json({ error: error.message, resendError: error });
    }

    console.log('✅ Email sent successfully:', { to, template, dataId: data?.id });
    return res.status(200).json({ 
      success: true, 
       data,
      message: 'Email enviado com sucesso',
      sentTo: to,
      template: template
    });

  } catch (err) {
    console.error('❌ API handler error:', err);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
}

// ==========================================
// 🎨 GERADOR DE HTML PREMIUM
// ==========================================
function generateEmailHTML(template, vars) {
  const escape = (str) => {
    if (!str && str !== 0) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  // ✅ CSS Base - Design de Fintech (Minimalista e Elegante)
  const baseStyles = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
      
      body { 
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
        background-color: #f3f4f6; 
        margin: 0; 
        padding: 40px 20px; 
        color: #1f2937; 
        -webkit-font-smoothing: antialiased;
      }
      .wrapper {
        max-width: 520px;
        margin: 0 auto;
        background: #ffffff;
        border-radius: 16px;
        overflow: hidden;
        box-shadow: 0 4px 24px rgba(0,0,0,0.04);
        border: 1px solid #f3f4f6;
      }
      .logo-container {
        padding: 32px 32px 0 32px;
        text-align: center;
      }
      .logo-container h1 {
        margin: 0;
        color: #2563eb;
        font-size: 28px;
        font-weight: 800;
        letter-spacing: -1px;
      }
      .content { 
        padding: 32px; 
      }
      h2 {
        margin: 0 0 16px 0;
        font-size: 20px;
        font-weight: 700;
        color: #111827;
        line-height: 1.3;
      }
      p {
        margin: 0 0 20px 0;
        font-size: 15px;
        line-height: 1.6;
        color: #4b5563;
      }
      .btn { 
        display: block; 
        background: #2563eb; 
        color: #ffffff !important; 
        padding: 14px 24px; 
        border-radius: 8px; 
        text-decoration: none; 
        font-weight: 600; 
        font-size: 15px; 
        text-align: center;
        transition: background 0.2s;
        margin: 32px 0;
      }
      .btn:hover { background: #1d4ed8; }
      .data-card {
        background: #f9fafb;
        border: 1px solid #f3f4f6;
        border-radius: 12px;
        padding: 24px;
        margin: 24px 0;
      }
      .data-card h3 {
        margin: 0 0 16px 0;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #6b7280;
      }
      table { width: 100%; border-collapse: collapse; }
      td { padding: 8px 0; font-size: 14px; border-bottom: 1px solid #f3f4f6; }
      tr:last-child td { border-bottom: none; padding-bottom: 0; }
      .label { color: #6b7280; width: 40%; }
      .value { color: #111827; font-weight: 500; text-align: right; }
      .total-row td {
        padding-top: 16px;
        border-top: 2px solid #e5e7eb;
        font-size: 16px;
        font-weight: 700;
      }
      .total-value { color: #059669; }
      .notice {
        background: #fffbeb;
        border-left: 4px solid #f59e0b;
        padding: 16px;
        border-radius: 4px 8px 8px 4px;
        margin: 24px 0;
      }
      .notice p { margin: 0; font-size: 13px; color: #92400e; }
      .code-highlight {
        background: #f0fdf4;
        border: 1px dashed #22c55e;
        color: #166534;
        padding: 16px;
        border-radius: 8px;
        text-align: center;
        font-size: 20px;
        font-weight: 700;
        letter-spacing: 2px;
        margin: 24px 0;
      }
      .footer { 
        padding: 24px 32px; 
        background: #f9fafb;
        text-align: center; 
        border-top: 1px solid #f3f4f6; 
      }
      .footer p { 
        margin: 0 0 8px 0; 
        font-size: 12px; 
        color: #9ca3af; 
      }
      .brand-claim {
        font-weight: 600;
        color: #4b5563 !important;
      }
    </style>
  `;

  // ✅ URL base para links - SEM ESPAÇOS
  const baseUrl = process.env.VERCEL_URL 
    ? `https://${process.env.VERCEL_URL}` 
    : (process.env.NEXT_PUBLIC_SITE_URL || 'https://paygo.co.mz');

  const htmlStart = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${baseStyles}</head><body><div class="wrapper"><div class="logo-container"><h1>PayGo</h1></div><div class="content">`;
  const htmlEnd = `</div><div class="footer"><p class="brand-claim">Simples. Seguro. Moçambicano. 🇲🇿</p><p>PayGo Serviços Digitais &copy; ${new Date().getFullYear()}</p><p>Suporte: contact@paygo.co.mz | WhatsApp: +258 87 100 2255</p></div></div></body></html>`;

  switch (template) {
    
    // 🔐 VERIFICAÇÃO DE EMAIL
    case 'email-verification': {
      const verifyLink = `${baseUrl}/verify-email.html?token=${vars.verificationToken || 'DEMO_TOKEN'}&email=${encodeURIComponent(vars.email || '')}`;
      return `${htmlStart}
        <h2>Confirme o seu e-mail</h2>
        <p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>.</p>
        <p>Para garantir a segurança da sua conta e começar a processar pagamentos internacionais, precisamos que valide este endereço de e-mail.</p>
        <a href="${verifyLink}" class="btn">Confirmar E-mail</a>
        <div class="notice">
          <p>⚠️ <strong>Atenção:</strong> Este link de segurança expira em 24 horas. Caso não tenha criado uma conta na PayGo, pode ignorar esta mensagem.</p>
        </div>
      ${htmlEnd}`;
    }

    // 🎉 BOAS-VINDAS - ✅ LÓGICA DE AFILIADO CORRIGIDA
    case 'welcome': {
      // ✅ IMPORTANTE: Só mostra código de afiliado se vars.affiliate_code EXISTIR e NÃO for vazio
      const hasAffiliateCode = vars.affiliate_code && 
                               vars.affiliate_code.trim() !== '' && 
                               vars.affiliate_code !== 'null' && 
                               vars.affiliate_code !== 'undefined';
      
      return `${htmlStart}
        <h2>Bem-vindo à PayGo! 🚀</h2>
        <p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>. A sua conta foi ativada com sucesso.</p>
        <p>A partir de agora, as suas compras internacionais no AliExpress, Shein ou Amazon estão à distância de um clique, pagando com o seu M-Pesa ou e-Mola.</p>
        
        <div class="data-card">
          <h3 style="color: #2563eb;">O que pode fazer agora:</h3>
          <ul style="margin:0; padding-left: 20px; font-size: 14px; color: #4b5563; line-height: 1.8;">
            <li>Fazer pagamentos internacionais sem cartão Visa</li>
            <li>Acompanhar o status dos seus pedidos em tempo real</li>
            <li>Convidar amigos e ganhar comissões</li>
          </ul>
        </div>

        <a href="${escape(vars.dashboard_link || baseUrl)}" class="btn">Aceder à Minha Conta</a>

        ${hasAffiliateCode ? `
        <div style="text-align: center; margin-top: 32px; border-top: 1px solid #f3f4f6; padding-top: 32px;">
          <p style="font-size: 13px; font-weight: 600; color: #6b7280; text-transform: uppercase;">🎁 O seu Código de Afiliado</p>
          <div class="code-highlight">${escape(vars.affiliate_code)}</div>
          <p style="font-size: 13px; color: #4b5563;">Partilhe e ganhe <strong>3%</strong> na primeira compra de cada amigo.</p>
        </div>
        ` : ''}
      ${htmlEnd}`;
    }

    // 🔐 RECUPERAÇÃO DE SENHA
    case 'password-reset': {
      return `${htmlStart}
        <h2>Recuperação de Senha</h2>
        <p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>.</p>
        <p>Recebemos um pedido de redefinição de senha para a conta associada a este e-mail.</p>
        <a href="${escape(vars.reset_link || '#')}" class="btn">Redefinir a Minha Senha</a>
        <div class="notice">
          <p>🔒 <strong>Segurança:</strong> O link acima é válido por apenas 1 hora. Se não fez este pedido, a sua conta permanece segura e pode ignorar este e-mail.</p>
        </div>
      ${htmlEnd}`;
    }

    // ✅ CONFIRMAÇÃO DE PEDIDO
    case 'order-confirmation': {
      return `${htmlStart}
        <h2>O seu pedido foi recebido. ✅</h2>
        <p>Olá, <strong>${escape(vars.customer_name || 'Cliente')}</strong>. O seu pedido <strong>#${escape(vars.order_id || 'N/A')}</strong> foi registado no nosso sistema.</p>
        
        <div class="data-card">
          <h3>Detalhes do Pedido</h3>
          <table>
            <tr><td class="label">Data</td><td class="value">${escape(vars.order_date || new Date().toLocaleDateString('pt-MZ'))}</td></tr>
            <tr><td class="label">Categoria</td><td class="value">${escape(vars.category || 'Compras')}</td></tr>
            <tr><td class="label">Produto</td><td class="value"><a href="${escape(vars.link_id || '#')}" style="color: #2563eb; text-decoration: none;">Ver Link do Produto</a></td></tr>
          </table>
        </div>

        <div class="data-card">
          <h3>Resumo Financeiro</h3>
          <table>
            <tr><td class="label">Valor USD</td><td class="value">$${escape(vars.usd_amount || '0.00')}</td></tr>
            <tr><td class="label">Câmbio Aplicado</td><td class="value">${escape(vars.exchange_rate || '88.00 MT')}</td></tr>
            <tr><td class="label">Taxa de Serviço</td><td class="value">${escape(vars.tax_amount || '0.00 MT')}</td></tr>
            <tr class="total-row">
              <td class="label" style="color: #111827;">TOTAL A PAGAR</td>
              <td class="value total-value">${escape(vars.total_amount || '0.00 MT')}</td>
            </tr>
          </table>
          <p style="font-size: 12px; margin-top: 16px; margin-bottom: 0; text-align: right; color: #6b7280;">Método: ${escape(vars.payment_method || 'N/A')}</p>
        </div>

        <div style="background: #eef2ff; border-radius: 8px; padding: 24px; border-left: 4px solid #2563eb; margin-top: 32px;">
          <h4 style="margin: 0 0 12px 0; color: #1e3a8a; font-size: 14px; text-transform: uppercase;">Ação Necessária: Finalizar Pagamento</h4>
          <p style="font-size: 14px; color: #1e40af; margin-bottom: 12px;">Para iniciarmos a sua compra, transfira o valor total e envie o comprovativo pelo WhatsApp.</p>
          <p style="font-size: 14px; color: #1e40af; font-weight: 600; margin-bottom: 4px;">e-Mola: 87 752 2255</p>
          <p style="font-size: 14px; color: #1e40af; font-weight: 600; margin-bottom: 16px;">M-Pesa: 84 162 7519</p>
          <a href="https://wa.me/258871002255" style="display: inline-block; background: #2563eb; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; font-size: 13px;">Enviar Comprovativo no WhatsApp</a>
        </div>
      ${htmlEnd}`;
    }

    // 🎉 AFILIADO APROVADO
    case 'affiliate-approved': {
      return `${htmlStart}
        <h2>Candidatura Aprovada! 🎉</h2>
        <p>Parabéns, <strong>${escape(vars.customer_name || 'Cliente')}</strong>. O seu perfil de afiliado foi aprovado.</p>
        <p>A partir de agora, é oficialmente parceiro da PayGo e já pode começar a monetizar a sua rede de contactos.</p>
        
        <div style="text-align: center; margin-top: 32px;">
          <p style="font-size: 13px; font-weight: 600; color: #6b7280; text-transform: uppercase;">O seu Código Exclusivo</p>
          <div class="code-highlight">${escape(vars.affiliate_code || 'AFF-XXXX')}</div>
        </div>

        <div class="data-card">
          <h3>Detalhes da Comissão</h3>
          <table>
            <tr><td class="label">Taxa</td><td class="value">3% na primeira compra</td></tr>
            <tr><td class="label">Validade</td><td class="value">Vitalícia por novo cliente</td></tr>
            <tr><td class="label">Pagamento</td><td class="value">Via M-Pesa ou e-Mola</td></tr>
          </table>
        </div>

        <a href="${escape(vars.dashboard_link || baseUrl)}" class="btn">Ir para o Dashboard</a>
      ${htmlEnd}`;
    }

    // 📧 DEFAULT
    default:
      return `${htmlStart}
        <h2>Notificação PayGo</h2>
        <p>${escape(vars.message || 'Recebeu uma nova notificação do sistema.')}</p>
      ${htmlEnd}`;
  }
}

// ==========================================
// 📝 GERADOR DE TEXTO (Para clientes sem HTML)
// ==========================================
function generateEmailText(template, vars) {
  const escape = (str) => {
    if (!str && str !== 0) return '';
    return String(str);
  };

  const footer = `\n\n---\nPayGo Moçambique - Simples. Seguro. Moçambicano. 🇲🇿\nSuporte: contact@paygo.co.mz | WhatsApp: +258 87 100 2255`;

  switch (template) {
    case 'email-verification': {
      const baseUrl = process.env.VERCEL_URL 
        ? `https://${process.env.VERCEL_URL}` 
        : (process.env.NEXT_PUBLIC_SITE_URL || 'https://paygo.co.mz');
      const verifyLink = `${baseUrl}/verify-email.html?token=${vars.verificationToken || 'DEMO_TOKEN'}&email=${encodeURIComponent(vars.email || '')}`;
      return `CONFIRME O SEU E-MAIL - PAYGO\n\nOlá ${escape(vars.customer_name || 'Cliente')},\n\nPara garantir a segurança da sua conta, valide o seu e-mail acedendo a este link:\n${verifyLink}\n\nAviso: Este link expira em 24 horas.${footer}`;
    }
    
    case 'welcome': {
      const hasAffiliateCode = vars.affiliate_code && 
                               vars.affiliate_code.trim() !== '' && 
                               vars.affiliate_code !== 'null' && 
                               vars.affiliate_code !== 'undefined';
      
      let message = `BEM-VINDO À PAYGO! 🚀\n\nOlá ${escape(vars.customer_name || 'Cliente')},\nA sua conta foi ativada. Já pode fazer compras internacionais pagando com M-Pesa ou e-Mola.\n\nAceda à sua conta: ${escape(vars.dashboard_link || 'https://paygo.co.mz')}`;
      
      if (hasAffiliateCode) {
        message += `\n\n🎁 O seu Código de Afiliado: ${escape(vars.affiliate_code)}\nPartilhe e ganhe 3% na primeira compra de cada amigo.`;
      }
      
      return message + footer;
    }
    
    case 'password-reset':
      return `RECUPERAÇÃO DE SENHA - PAYGO\n\nOlá ${escape(vars.customer_name || 'Cliente')},\n\nAceda ao link abaixo para redefinir a sua senha:\n${escape(vars.reset_link || '#')}\n\nAviso: Este link expira em 1 hora.${footer}`;
      
    case 'order-confirmation':
      return `PEDIDO RECEBIDO - PAYGO ✅\n\nO seu pedido #${escape(vars.order_id || 'N/A')} foi registado.\n\nVALOR TOTAL A PAGAR: ${escape(vars.total_amount || '0.00 MT')}\n\nPara finalizar, transfira o valor para:\ne-Mola: 87 752 2255\nM-Pesa: 84 162 7519\n\nEnvie o comprovativo para o WhatsApp: +258 87 100 2255${footer}`;
      
    case 'affiliate-approved':
      return `CANDIDATURA APROVADA - PAYGO 🎉\n\nParabéns ${escape(vars.customer_name || 'Cliente')}! O seu perfil de afiliado foi aprovado.\n\nO seu código: ${escape(vars.affiliate_code || 'AFF-XXXX')}\nComissão: 3% na primeira compra de cada amigo indicado.${footer}`;
      
    default:
      return `${escape(vars.message || 'Notificação PayGo')}${footer}`;
  }
}
