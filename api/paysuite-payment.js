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
      description 
    } = req.body;

    // ✅ 3. Validações Básicas
    if (!orderId || !amount || !method) {
      return res.status(400).json({ 
        success: false,
        error: 'Faltam campos obrigatórios (orderId, amount, method)' 
      });
    }

    if (amount < 1) {
      return res.status(400).json({ success: false, error: 'O valor mínimo é 1 MT' });
    }

    // Garantir que o método vai no formato exato que a PaySuite exige ('mpesa' ou 'emola', sem traços)
    const cleanMethod = (method === 'mpesa' || method === 'm-pesa') ? 'mpesa' : 'emola';

    // ✅ 4. Construir o Payload Exato da Documentação da PaySuite
    const paysuitePayload = {
      amount: parseFloat(amount),
      method: cleanMethod,
      reference: orderId, // OBRIGATÓRIO (Identificador único do pedido)
      description: description || `Pedido PayGo #${orderId}`,
      callback_url: `${process.env.SITE_URL || 'https://www.paygo.co.mz'}/api/paysuite-webhook`,
      // Enviamos o telefone para o caso de a operadora forçar o USSD Push direto
      phone: phone ? phone.replace(/\D/g, '') : undefined 
    };

    console.log('💳 [paysuite-payment] A iniciar pagamento na PaySuite:', paysuitePayload);

    // ✅ 5. Chamar a API Oficial da PaySuite
    const response = await fetch('https://paysuite.tech/api/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        // ATENÇÃO: Confirme que a variável PAYSUITE_API_KEY está configurada no painel do Vercel
        'Authorization': `Bearer ${process.env.PAYSUITE_API_KEY}` 
      },
      body: JSON.stringify(paysuitePayload)
    });

    const result = await response.json();

    // ✅ 6. Lidar com Erros da PaySuite (Se o status for "error")
    if (!response.ok || result.status === 'error') {
      console.error('❌ [paysuite-payment] Erro da API PaySuite:', result);
      return res.status(400).json({ 
        success: false,
        error: result.message || 'O servidor da PaySuite rejeitou o pagamento.',
        details: result 
      });
    }

    console.log('✅ [paysuite-payment] Pagamento criado com sucesso:', result.data);

    // ✅ 7. Retornar Sucesso para o seu site (Frontend)
    return res.status(200).json({
      success: true,
      data: {
        paymentId: result.data.id,
        status: result.data.status,
        checkoutUrl: result.data.checkout_url
      },
      message: 'Pagamento iniciado com sucesso'
    });

  } catch (err) {
    console.error('❌ [paysuite-payment] Erro Crítico no Servidor:', err);
    return res.status(500).json({
      success: false,
      error: 'Erro interno do servidor',
      message: err.message
    });
  }
}
