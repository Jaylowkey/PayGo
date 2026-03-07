// api/paysuite-payment.js
export default async function handler(req, res) {
  // ✅ CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { 
      orderId, 
      amount, 
      currency = 'MZN', 
      phone, 
      method, // 'mpesa' | 'emola'
      email,
      name,
      description 
    } = req.body;

    // ✅ Validações
    if (!orderId || !amount || !phone || !method) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        required: ['orderId', 'amount', 'phone', 'method'] 
      });
    }

    if (amount < 1 || amount > 100000) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // ✅ Preparar payload para PaySuite API
    const paysuitePayload = {
      merchant_id: process.env.PAYSUITE_MERCHANT_ID,
      transaction_id: orderId,
      amount: parseFloat(amount),
      currency: currency.toUpperCase(),
      description: description || `Pedido PayGo #${orderId}`,
      customer: {
        name: name || 'Cliente PayGo',
        phone: phone.replace(/\D/g, ''), // Apenas números
        email: email || null
      },
      payment_method: method === 'mpesa' ? 'm-pesa' : 'e-mola',
      return_url: process.env.PAYSUITE_RETURN_URL,
      cancel_url: process.env.PAYSUITE_CANCEL_URL,
      webhook_url: `${process.env.SITE_URL}/api/paysuite-webhook`,
      metadata: {
        platform: 'paygo',
        userId: req.body.userId || null,
        orderType: req.body.orderType || 'compra'
      }
    };

    console.log('💳 [paysuite-payment] Initiating payment:', {
      orderId,
      amount,
      method: paysuitePayload.payment_method,
      phone: paysuitePayload.customer.phone
    });

    // ✅ Chamar API PaySuite
    const response = await fetch('https://api.paysuite.tech/v1/payment/initiate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.PAYSUITE_API_KEY}`,
        'X-Merchant-ID': process.env.PAYSUITE_MERCHANT_ID
      },
      body: JSON.stringify(paysuitePayload)
    });

    const result = await response.json();

    if (!response.ok || result.status !== 'success') {
      console.error('❌ [paysuite-payment] API error:', result);
      return res.status(500).json({ 
        error: 'Payment initiation failed', 
        paysuiteError: result 
      });
    }

    console.log('✅ [paysuite-payment] Payment initiated:', {
      paymentId: result.data?.payment_id,
      status: result.data?.status
    });

    // ✅ Retornar dados para frontend
    return res.status(200).json({
      success: true,
      data: {
        paymentId: result.data.payment_id,
        status: result.data.status,
        paymentUrl: result.data.payment_url,
        qrCode: result.data.qr_code,
        instructions: result.data.instructions,
        expiresAt: result.data.expires_at,
        // Dados para modal
        amount: result.data.amount,
        currency: result.data.currency,
        method: result.data.payment_method
      },
      message: 'Pagamento iniciado com sucesso'
    });

  } catch (err) {
    console.error('❌ [paysuite-payment] Critical error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
}
