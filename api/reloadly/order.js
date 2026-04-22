import {
  setCors,
  json,
  normalizeBody,
  getAuthenticatedUser,
  getFirebase,
  getSettings,
  calculatePayGoFee,
  reloadlyPost,
  recordSuccessfulReloadlyOrder
} from './_shared.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return json(res, 405, { success: false, error: 'Método não permitido.' });

  try {
    const body = normalizeBody(req);
    const user = await getAuthenticatedUser(req);
    const { db } = getFirebase();
    const settings = await getSettings(db);

    const amount = Number(body.amount || body.unitPrice || 0);
    const exchangeRate = Number(body.exchangeRate || settings.exchangeRate || 85);
    const feeMt = Number(body.feeMt ?? calculatePayGoFee(amount, settings));
    const totalMt = Number(body.totalMt ?? ((amount * exchangeRate) + feeMt));

    if (!body.productId) return json(res, 400, { success: false, error: 'productId é obrigatório.' });
    if (!amount || amount <= 0) return json(res, 400, { success: false, error: 'amount é obrigatório.' });
    if (!body.recipientEmail || !body.recipientName) {
      return json(res, 400, { success: false, error: 'recipientEmail e recipientName são obrigatórios.' });
    }

    const payload = {
      productId: Number.isNaN(Number(body.productId)) ? body.productId : Number(body.productId),
      quantity: Number(body.quantity || 1),
      unitPrice: amount,
      senderName: body.senderName || user.name || 'PayGo',
      senderEmail: body.senderEmail || user.email,
      recipientEmail: body.recipientEmail,
      recipientName: body.recipientName,
      recipientPhone: body.recipientPhone || user.phone || undefined,
      customIdentifier: body.customIdentifier || `PAYGO-${Date.now()}`,
      countryCode: body.recipientCountryCode || 'US'
    };

    const reloadlyOrder = await reloadlyPost('/orders', payload);
    const recorded = await recordSuccessfulReloadlyOrder({
      user,
      body,
      reloadlyOrder,
      exchangeRate,
      feeMt,
      totalMt
    });

    return json(res, 200, {
      success: true,
      message: 'Gift card comprado com sucesso.',
      transactionId: reloadlyOrder.transactionId || null,
      referenceId: reloadlyOrder.referenceId || null,
      orderId: recorded.orderId,
      totalMt,
      feeMt,
      exchangeRate
    });
  } catch (error) {
    return json(res, 500, {
      success: false,
      error: error.message || 'Falha ao concluir pedido Reloadly.'
    });
  }
}
