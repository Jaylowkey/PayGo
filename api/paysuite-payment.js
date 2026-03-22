export default async function handler(req, res) {
  // ✅ 1. Configurar CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Método não permitido' });

  try {
    // ✅ 2. Receber os dados do Frontend
    const { orderId, amount, method, description } = req.body;

    // ✅ 3. Validações Básicas
    if (!orderId || !amount || !method) {
      return res.status(400).json({ success: false, error: 'Faltam campos obrigatórios (orderId, amount, method)' });
    }

    if (isNaN(amount) || amount < 1) {
      return res.status(400).json({ success: false, error: 'O valor mínimo é 1 MT' });
    }

    const cleanMethod = (method === 'mpesa' || method === 'm-pesa') ? 'mpesa' : 'emola';
    
    // Removemos os traços da referência para garantir compatibilidade máxima com a PaySuite
    const cleanReference = orderId.replace(/[^a-zA-Z0-9]/g, '');

    // ✅ 4. O PAYLOAD CIRÚRGICO (Exatamente como a documentação exige, sem invenções!)
    const paysuitePayload = {
      amount: parseFloat(amount),
      method: cleanMethod,
      reference: cleanReference, 
      description: description || `Pedido PayGo #${orderId}`,
      callback_url: 'https://www.paygo.co.mz/api/paysuite-webhook', // 👈 O ÁRBITRO FINAL
      return_url: 'https://www.paygo.co.mz/index.html' // Para onde o cliente volta após pagar
    };

    console.log('💳 [paysuite-payment] Iniciando pagamento rigoroso:', paysuitePayload);

    // ✅ 5. Chamar a API Oficial da PaySuite
    const response = await fetch('https://paysuite.tech/api/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${process.env.PAYSUITE_API_KEY}` 
      },
      body: JSON.stringify(paysuitePayload),
      signal: AbortSignal.timeout(30000)
    });

    const result = await response.json();

    // ✅ 6. Lidar com Erros
    if (!response.ok || result.status === 'error') {
      console.error('❌ Erro da API PaySuite:', result);
      return res.status(400).json({ 
        success: false, 
        error: result.message || 'O servidor da PaySuite rejeitou o pagamento.' 
      });
    }

    console.log('✅ Pagamento criado na PaySuite. URL gerado:', result.data?.checkout_url);

    // ✅ 7. Retornar Sucesso para o Frontend
    return res.status(200).json({
      success: true,
      data: {
        paymentId: result.data?.id,
        status: result.data?.status,
        reference: result.data?.reference,
        checkoutUrl: result.data?.checkout_url, // 👈 O CLIENTE TEM DE SER REDIRECIONADO PARA AQUI!
        method: cleanMethod,
        amount: result.data?.amount
      },
      message: 'Redirecione o cliente para o checkoutUrl'
    });

  } catch (err) {
    console.error('❌ Erro Crítico:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
}
