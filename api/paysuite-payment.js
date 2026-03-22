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

    if (!orderId || !amount || !method) {
      return res.status(400).json({ success: false, error: 'Faltam campos obrigatórios' });
    }

    const cleanMethod = (method === 'mpesa' || method === 'm-pesa') ? 'mpesa' : 'emola';
    const cleanReference = orderId.replace(/[^a-zA-Z0-9]/g, '');

    // ✅ 3. O PAYLOAD CIRÚRGICO DA PAYSUITE
    const paysuitePayload = {
      amount: parseFloat(amount),
      method: cleanMethod,
      reference: cleanReference, 
      description: description || `Pedido PayGo #${orderId}`,
      
      // 🚀 A LIGAÇÃO ABSOLUTA: Obriga a PaySuite a avisar a nossa Vercel!
      callback_url: 'https://www.paygo.co.mz/api/paysuite-webhook', 
      return_url: 'https://www.paygo.co.mz/pedidos.html'
    };

    console.log('💳 Iniciando pagamento na PaySuite:', paysuitePayload.reference);

    // ✅ 4. Chamar a API
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

    if (!response.ok || result.status === 'error') {
      console.error('❌ Erro da PaySuite:', result);
      return res.status(400).json({ success: false, error: result.message || 'Pagamento rejeitado pela PaySuite.' });
    }

    // ✅ 5. Retornar Sucesso e o Link de Pagamento
    return res.status(200).json({
      success: true,
      data: {
        paymentId: result.data?.id,
        status: result.data?.status,
        reference: result.data?.reference,
        checkoutUrl: result.data?.checkout_url, 
        method: cleanMethod,
        amount: result.data?.amount
      }
    });

  } catch (err) {
    console.error('❌ Erro Crítico:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
}
