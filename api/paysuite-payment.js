// api/paysuite-payment.js
export default async function handler(req, res) {
  // ✅ 1. Configurar CORS (Permitir que o seu site comunique com a API)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Responder logo aos pedidos OPTIONS (Pre-flight do navegador)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Apenas aceitar o método POST
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método não permitido' });
  }

  try {
    // ✅ 2. Receber os dados do Frontend
    const { 
      orderId, 
      amount, 
      phone, 
      method, 
      description,
      email,
      name,
      orderType,
      userId 
    } = req.body;

    // ✅ 3. Validações Básicas
    if (!orderId || !amount || !method) {
      return res.status(400).json({ 
        success: false,
        error: 'Faltam campos obrigatórios (orderId, amount, method)' 
      });
    }

    if (isNaN(amount) || amount < 1) {
      return res.status(400).json({ success: false, error: 'O valor mínimo é 1 MT' });
    }

    // Garantir que o método vai no formato exato que a PaySuite exige
    const cleanMethod = (method === 'mpesa' || method === 'm-pesa') ? 'mpesa' : 'emola';

    // Normalizar telefone (remover espaços, traços, etc.)
    const cleanPhone = phone ? phone.replace(/\D/g, '') : undefined;

    // ✅ 4. Construir o Payload Exato da Documentação da PaySuite
    const paysuitePayload = {
      amount: parseFloat(amount),
      method: cleanMethod,
      // 👈 CORREÇÃO: Removemos o traço do orderId (ex: de PG-123456 para PG123456)
      reference: orderId.replace(/[^a-zA-Z0-9]/g, ''), 
      description: description || `Pedido PayGo #${orderId}`,
      callback_url: `${process.env.SITE_URL || 'https://www.paygo.co.mz'}/api/paysuite-webhook`,
      return_url: `${process.env.SITE_URL || 'https://www.paygo.co.mz'}`,
      // Opcional: telefone para USSD Push direto
      ...(cleanPhone && { phone: cleanPhone }),
      // Metadados extras para rastreio interno
      metadata: {
        customerName: name || '',
        customerEmail: email || '',
        orderType: orderType || 'compra',
        userId: userId || null,
        platform: 'paygo-web',
        timestamp: new Date().toISOString()
      }
    };

    console.log('💳 [paysuite-payment] Iniciando pagamento:', {
      orderId,
      amount,
      method: cleanMethod,
      phone: cleanPhone ? '***' : null
    });

    // ✅ 5. Chamar a API Oficial da PaySuite
    const response = await fetch('https://paysuite.tech/api/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        // ATENÇÃO: A variável PAYSUITE_API_KEY deve estar configurada no Vercel
        'Authorization': `Bearer ${process.env.PAYSUITE_API_KEY}` 
      },
      body: JSON.stringify(paysuitePayload),
      // Timeout de 30 segundos para evitar requests pendentes
      signal: AbortSignal.timeout(30000)
    });

    const result = await response.json();

    // ✅ 6. Lidar com Erros da PaySuite
    if (!response.ok || result.status === 'error') {
      console.error('❌ [paysuite-payment] Erro da API PaySuite:', {
        status: response.status,
        statusText: response.statusText,
        error: result
      });

      return res.status(400).json({ 
        success: false,
        error: result.message || 'O servidor da PaySuite rejeitou o pagamento.',
        details: process.env.NODE_ENV === 'development' ? result : undefined
      });
    }

    console.log('✅ [paysuite-payment] Pagamento criado:', {
      paymentId: result.data?.id,
      status: result.data?.status,
      reference: result.data?.reference
    });

    // ✅ 7. Retornar Sucesso para o Frontend
    return res.status(200).json({
      success: true,
      data: {
        paymentId: result.data?.id,
        status: result.data?.status,
        reference: result.data?.reference,
        checkoutUrl: result.data?.checkout_url,
        method: cleanMethod,
        amount: result.data?.amount,
        createdAt: result.data?.created_at
      },
      message: 'Pagamento iniciado com sucesso'
    });

  } catch (err) {
    // Log de erro completo para debugging
    console.error('❌ [paysuite-payment] Erro Crítico:', {
      name: err.name,
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
      cause: err.cause
    });

    return res.status(500).json({
      success: false,
      error: 'Erro interno do servidor',
      message: process.env.NODE_ENV === 'development' ? err.message : 'Tente novamente mais tarde'
    });
  }
}

// ✅ Config para Vercel Edge (opcional - remove se não usar Edge Runtime)
export const config = {
  runtime: 'nodejs' // ou 'edge' se preferir Edge Functions
};
