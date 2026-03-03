// api/send-email.js
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  // ✅ Apenas POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { to, subject, template, variables } = req.body;

    // ✅ Validações básicas
    if (!to || !subject || !template) {
      return res.status(400).json({ 
        error: 'Missing required fields: to, subject, template' 
      });
    }

    // ✅ Gerar HTML baseado no template
    const html = generateEmailHTML(template, variables);
    const text = generateEmailText(template, variables);

    // ✅ Enviar email via Resend
    const { data, error } = await resend.emails.send({
      from: `PayGo <noreply@paygo.co.mz>`,
      to: [to],
      subject: subject,
      html: html,
      text: text,
      headers: {
        'X-PayGo-Template': template,
        'X-PayGo-Version': '1.0'
      }
    });

    if (error) {
      console.error('❌ Resend error:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log('✅ Email sent:', data);
    return res.status(200).json({ 
      success: true, 
      data: data,
      message: 'Email enviado com sucesso'
    });

  } catch (err) {
    console.error('❌ Send email error:', err);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: err.message 
    });
  }
}

// ✅ Gerador de HTML para templates - COM DESIGNS PROFISSIONAIS
function generateEmailHTML(template, vars) {
  switch (template) {
    
    // 🔐 PASSWORD RESET - Template Profissional
    case 'password-reset':
      return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Recuperação de Senha - PayGo</title>
</head>
<body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: auto; background: #f8fafc; padding: 20px;">
  <div style="border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); background: #fff;">
    
    <!-- Header -->
    <div style="background-color: #0052FF; padding: 35px 30px; text-align: center; color: white;">
      <h1 style="margin: 0; font-size: 24px; letter-spacing: -0.5px;">🔐 Recuperação de Senha</h1>
      <p style="margin: 10px 0 0; opacity: 0.9; font-size: 15px;">Olá, <strong>${vars.customer_name || 'Cliente'}</strong>. Recebemos sua solicitação.</p>
    </div>

    <!-- Content -->
    <div style="padding: 30px; color: #334155; line-height: 1.6;">
      <p style="margin-top: 0; font-size: 15px;">Recebemos uma solicitação para redefinir a senha da sua conta PayGo.</p>
      
      <!-- Reset Button -->
      <div style="text-align: center; margin: 32px 0;">
        <a href="${vars.reset_link || '#'}" style="display: inline-block; background: #0052FF; color: #fff; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-weight: 600; font-size: 16px; box-shadow: 0 4px 14px rgba(0,82,255,0.3);">
          🔗 Redefinir Senha
        </a>
      </div>
      
      <!-- Warning -->
      <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 16px; border-radius: 0 8px 8px 0; margin: 24px 0;">
        <p style="margin: 0; font-size: 14px; color: #92400e;">
          ⚠️ <strong>Este link expira em 1 hora.</strong><br>
          Se você não solicitou esta alteração, ignore este email ou contacte o suporte.
        </p>
      </div>
      
      <!-- Security Info -->
      <div style="background: #f1f5f9; padding: 16px; border-radius: 8px; margin-top: 24px;">
        <p style="margin: 0; font-size: 13px; color: #475569;">
          <strong>Dica de segurança:</strong> Nunca compartilhe seu link de recuperação com terceiros.
        </p>
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

    // ✅ ORDER CONFIRMATION - Template Profissional (NOVO DESIGN)
    case 'order-confirmation':
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
      <p style="margin: 10px 0 0; opacity: 0.9; font-size: 15px;">Olá, <strong>${vars.customer_name || 'Cliente'}</strong>. Recebemos o seu pedido.</p>
    </div>

    <!-- Content -->
    <div style="padding: 30px; color: #334155; line-height: 1.6;">
      <p style="margin-top: 0; font-size: 15px;">O seu pedido <strong>#${vars.order_id || 'N/A'}</strong> foi registado com sucesso e já está na nossa fila de processamento.</p>
      
      <!-- Order Details -->
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <h3 style="margin: 0 0 12px 0; color: #0052FF; font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px;">📋 Detalhes do Pedido</h3>
        <table style="width: 100%; font-size: 14px;">
          <tr><td style="padding: 6px 0; color: #64748b;">Data:</td><td style="color: #0f172a; font-weight: 500;">${vars.order_date || new Date().toLocaleDateString('pt-MZ')}</td></tr>
          <tr><td style="padding: 6px 0; color: #64748b;">Categoria:</td><td style="color: #0f172a; font-weight: 500;">${vars.category || 'Compras'}</td></tr>
          <tr><td style="padding: 6px 0; color: #64748b;">Produto:</td><td><a href="${vars.link_id || '#'}" style="color: #0052FF; font-weight: 600; text-decoration: none;" target="_blank">Ver Link 🔗</a></td></tr>
        </table>
      </div>

      <!-- Financial Summary -->
      <div style="border: 1px dashed #cbd5e1; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <h3 style="margin: 0 0 12px 0; color: #0052FF; font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px;">💰 Resumo Financeiro</h3>
        <table style="width: 100%; font-size: 14px;">
          <tr><td style="padding: 6px 0; color: #475569;">Valor USD:</td><td style="text-align: right; color: #0f172a; font-weight: 500;">$${vars.usd_amount || '0.00'}</td></tr>
          <tr><td style="padding: 6px 0; color: #475569;">Câmbio:</td><td style="text-align: right; color: #0f172a; font-weight: 500;">${vars.exchange_rate || '88.00 MT'}</td></tr>
          <tr><td style="padding: 6px 0; color: #475569;">Taxas:</td><td style="text-align: right; color: #0f172a; font-weight: 500;">${vars.tax_amount || '0.00 MT'}</td></tr>
          <tr style="font-size: 18px; font-weight: bold;">
            <td style="padding-top: 16px; border-top: 1px solid #e2e8f0; color: #0f172a;">TOTAL:</td>
            <td style="padding-top: 16px; border-top: 1px solid #e2e8f0; text-align: right; color: #059669;">${vars.total_amount || '0.00 MT'}</td>
          </tr>
        </table>
        <p style="font-size: 13px; margin: 12px 0 0 0; color: #64748b; text-align: right;">Método selecionado: <strong>${vars.payment_method || 'N/A'}</strong></p>
      </div>

      <!-- Payment Instructions -->
      <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-left: 4px solid #2563eb; padding: 20px; border-radius: 8px; margin-top: 28px;">
        <h4 style="margin: 0 0 12px 0; color: #1e3a8a; font-size: 16px;">📍 Ação Necessária: Pagamento Manual</h4>
        <p style="margin: 0 0 16px 0; font-size: 14px; color: #1e40af; line-height: 1.5;">Como o nosso sistema automático encontra-se temporariamente em manutenção, ativámos a via rápida manual para que o seu pedido não sofra atrasos.</p>
        
        <p style="margin: 0 0 8px 0; font-size: 14px; font-weight: bold; color: #1e3a8a;">1. Transfira o valor total (<strong>${vars.total_amount || '0.00 MT'}</strong>) para:</p>
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

    // 🎉 AFFILIATE APPROVED - Template Profissional
    case 'affiliate-approved':
      return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Afiliado Aprovado - PayGo</title>
</head>
<body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: auto; background: #f8fafc; padding: 20px;">
  
  <div style="border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); background: #fff;">
    
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #22c55e, #16a34a); padding: 35px 30px; text-align: center; color: white;">
      <h1 style="margin: 0; font-size: 24px; letter-spacing: -0.5px;">🎉 Afiliado Aprovado!</h1>
      <p style="margin: 10px 0 0; opacity: 0.9; font-size: 15px;">Parabéns, <strong>${vars.customer_name || 'Cliente'}</strong>! Sua candidatura foi aprovada.</p>
    </div>

    <!-- Content -->
    <div style="padding: 30px; color: #334155; line-height: 1.6;">
      <p style="margin-top: 0; font-size: 15px;">Sua candidatura ao programa de afiliados PayGo foi <strong>aprovada</strong>. Agora você pode começar a ganhar comissões!</p>
      
      <!-- Affiliate Code Box -->
      <div style="background: #f0fdf4; border: 2px solid #22c55e; border-radius: 12px; padding: 24px; margin: 24px 0; text-align: center;">
        <p style="margin: 0 0 8px 0; font-size: 14px; color: #166534; font-weight: 600;">Seu Código de Afiliado:</p>
        <p style="margin: 0; font-size: 24px; font-weight: bold; color: #22c55e; letter-spacing: 2px; font-family: monospace;">
          ${vars.affiliate_code || 'AFF-XXXX'}
        </p>
      </div>

      <!-- Commission Info -->
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <h3 style="margin: 0 0 12px 0; color: #0052FF; font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px;">💰 Sua Comissão</h3>
        <table style="width: 100%; font-size: 14px;">
          <tr><td style="padding: 6px 0; color: #64748b;">Taxa:</td><td style="color: #0f172a; font-weight: 500;">3% na primeira compra</td></tr>
          <tr><td style="padding: 6px 0; color: #64748b;">Aplicação:</td><td style="color: #0f172a; font-weight: 500;">Cada indicado que comprar</td></tr>
          <tr><td style="padding: 6px 0; color: #64748b;">Pagamento:</td><td style="color: #0f172a; font-weight: 500;">Via M-Pesa ou e-Mola</td></tr>
        </table>
      </div>

      <!-- CTA Button -->
      <div style="text-align: center; margin: 32px 0;">
        <a href="${vars.dashboard_link || '#'}" style="display: inline-block; background: #0052FF; color: #fff; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-weight: 600; font-size: 16px; box-shadow: 0 4px 14px rgba(0,82,255,0.3);">
          🚀 Acessar Dashboard de Afiliado
        </a>
      </div>

      <!-- Tips -->
      <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-left: 4px solid #2563eb; padding: 20px; border-radius: 8px;">
        <h4 style="margin: 0 0 12px 0; color: #1e3a8a; font-size: 16px;">💡 Dicas para Ganhar Mais</h4>
        <ul style="margin: 0; padding-left: 20px; font-size: 14px; color: #1e40af; line-height: 1.8;">
          <li>Compartilhe seu código em redes sociais</li>
          <li>Indique amigos e familiares no WhatsApp</li>
          <li>Crie conteúdo sobre compras internacionais</li>
        </ul>
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

    // 📧 DEFAULT - Template genérico
    default:
      return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Notificação - PayGo</title></head>
<body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: auto; background: #f8fafc; padding: 20px;">
  <div style="border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background: #fff;">
    <div style="background: linear-gradient(135deg, #3b82f6, #06b6d4); padding: 24px; text-align: center; color: #fff;">
      <h1 style="margin: 0; font-size: 24px;">PayGo</h1>
    </div>
    <div style="padding: 32px; color: #334155; line-height: 1.6;">
      <p style="margin: 0;">${vars.message || 'Notificação PayGo'}</p>
    </div>
    <div style="background: #f8fafc; padding: 20px; text-align: center; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 12px;">
      &copy; 2026 PayGo Moçambique
    </div>
  </div>
</body></html>`;
  }
}

// ✅ Versão texto simples (fallback para clientes sem HTML)
function generateEmailText(template, vars) {
  switch (template) {
    
    case 'password-reset':
      return `
RECUPERAÇÃO DE SENHA - PAYGO 🔐

Olá ${vars.customer_name || 'Cliente'},

Recebemos uma solicitação para redefinir a senha da sua conta PayGo.

Clique no link abaixo para redefinir:
${vars.reset_link || '#'}

⚠️ Este link expira em 1 hora.

Se você não solicitou esta alteração, ignore este email.

Dica de segurança: Nunca compartilhe seu link de recuperação.

PayGo Moçambique - Simples. Seguro. Moçambicano. 🇲🇿
Suporte: contact@paygo.co.mz | WhatsApp: +258 87 100 2255
      `.trim();

    case 'order-confirmation':
      return `
PEDIDO CONFIRMADO - PAYGO MOÇAMBIQUE ✅

Olá ${vars.customer_name || 'Cliente'},

O seu pedido #${vars.order_id || 'N/A'} foi registado com sucesso!

📋 DETALHES DO PEDIDO:
• Data: ${vars.order_date || new Date().toLocaleDateString('pt-MZ')}
• Categoria: ${vars.category || 'Compras'}
• Produto: ${vars.link_id || 'N/A'}

💰 RESUMO FINANCEIRO:
• Valor USD: $${vars.usd_amount || '0.00'}
• Câmbio: ${vars.exchange_rate || '88.00 MT'}
• Taxas: ${vars.tax_amount || '0.00 MT'}
• TOTAL: ${vars.total_amount || '0.00 MT'}
• Método: ${vars.payment_method || 'N/A'}

📍 AÇÃO NECESSÁRIA: PAGAMENTO MANUAL

Devido a manutenção temporária no sistema, por favor siga estes passos:

1. Transfira o valor total de ${vars.total_amount || '0.00 MT'} para:
   • e-Mola: 87 752 2255
   • M-Pesa: 84 162 7519

2. Envie o comprovativo para validação:
   WhatsApp: https://wa.me/258871002255

Precisa de ajuda? Contacte-nos:
• Email: contact@paygo.co.mz
• WhatsApp: +258 87 100 2255

PayGo Moçambique - Simples. Seguro. Moçambicano. 🇲🇿
      `.trim();

    case 'affiliate-approved':
      return `
AFILIADO APROVADO - PAYGO 🎉

Olá ${vars.customer_name || 'Cliente'},

Parabéns! Sua candidatura ao programa de afiliados PayGo foi APROVADA.

🔑 SEU CÓDIGO DE AFILIADO:
${vars.affiliate_code || 'AFF-XXXX'}

💰 SUA COMISSÃO:
• Taxa: 3% na primeira compra de cada indicado
• Aplicação: Cada pessoa que usar seu código
• Pagamento: Via M-Pesa ou e-Mola

🚀 PRÓXIMOS PASSOS:
1. Acesse seu dashboard: ${vars.dashboard_link || '#'}
2. Compartilhe seu código em redes sociais
3. Indique amigos e familiares no WhatsApp
4. Acompanhe seus ganhos em tempo real

💡 DICAS PARA GANHAR MAIS:
• Crie conteúdo sobre compras internacionais
• Compartilhe em grupos do WhatsApp e Facebook
• Ofereça ajuda para quem quer comprar online

Precisa de ajuda? Contacte-nos:
• Email: contact@paygo.co.mz
• WhatsApp: +258 87 100 2255

PayGo Moçambique - Simples. Seguro. Moçambicano. 🇲🇿
      `.trim();

    default:
      return `${vars.message || 'Notificação PayGo'}\n\nPayGo Moçambique\nSuporte: contact@paygo.co.mz`;
  }
}
