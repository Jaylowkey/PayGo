// lib/services/zumbopay.js

import crypto from 'crypto';

const ZUMBOPAY_API_URL =
  process.env.ZUMBOPAY_API_URL || 'https://api.zumbopay.co.mz';

const ZUMBOPAY_API_KEY = process.env.ZUMBOPAY_API_KEY || '';
const ZUMBOPAY_WALLET_ID = process.env.ZUMBOPAY_WALLET_ID || '';

/**
 * =========================================================
 * ZumboPay Service - PayGo
 * =========================================================
 */

function getConfig() {
  if (!ZUMBOPAY_API_KEY) {
    throw new Error('ZUMBOPAY_API_KEY não configurada.');
  }

  if (!ZUMBOPAY_WALLET_ID) {
    throw new Error('ZUMBOPAY_WALLET_ID não configurada.');
  }

  return {
    apiUrl: ZUMBOPAY_API_URL.replace(/\/+$/, ''),
    apiKey: ZUMBOPAY_API_KEY,
    walletId: ZUMBOPAY_WALLET_ID,
  };
}

/**
 * Faz uma requisição autenticada à ZumboPay.
 */
async function zumbopayRequest(
  endpoint,
  {
    method = 'GET',
    body = null,
    idempotencyKey = null,
    headers = {},
  } = {}
) {
  const config = getConfig();

  const requestHeaders = {
    Accept: 'application/json',
    'Content-Type': 'application/json',

    // API Key nunca deve ir para o frontend.
    Authorization: `Bearer ${config.apiKey}`,

    ...headers,
  };

  if (idempotencyKey) {
    requestHeaders['Idempotency-Key'] = idempotencyKey;
  }

  const response = await fetch(
    `${config.apiUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`,
    {
      method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,

      signal: AbortSignal.timeout(30000),
    }
  );

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Resposta inválida da ZumboPay (${response.status}).`
    );
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error ||
      data?.detail ||
      `ZumboPay respondeu com HTTP ${response.status}.`;

    const error = new Error(message);

    error.status = response.status;
    error.provider = 'zumbopay';
    error.data = data;

    throw error;
  }

  return data;
}

/**
 * Normaliza métodos de pagamento.
 */
export function normalizeZumboPayMethod(method = '') {
  const value = String(method)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  if (['mpesa', 'mpesaapi', 'mpsa'].includes(value)) {
    return 'mpesa';
  }

  if (['emola', 'emolaapi'].includes(value)) {
    return 'emola';
  }

  if (['card', 'visa', 'mastercard'].includes(value)) {
    return 'card';
  }

  throw new Error(
    `Método de pagamento não suportado pela ZumboPay: ${method}`
  );
}

/**
 * Normaliza números moçambicanos.
 *
 * Exemplos:
 * 871002255
 * +258871002255
 * 258871002255
 *
 * Resultado:
 * +258871002255
 */
export function normalizeMozambiquePhone(phone = '') {
  let value = String(phone || '').replace(/[^\d+]/g, '');

  if (!value) {
    throw new Error('Número de telefone não informado.');
  }

  if (value.startsWith('00')) {
    value = `+${value.slice(2)}`;
  }

  if (value.startsWith('+258')) {
    return value;
  }

  if (value.startsWith('258')) {
    return `+${value}`;
  }

  if (value.startsWith('0')) {
    return `+258${value.slice(1)}`;
  }

  if (/^8\d{8}$/.test(value)) {
    return `+258${value}`;
  }

  throw new Error('Número de telefone moçambicano inválido.');
}

/**
 * Gera uma chave de idempotência.
 */
export function generateIdempotencyKey(prefix = 'PAYGO') {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * =========================================================
 * MERCHANT
 * =========================================================
 */

/**
 * Valida a configuração da conta PayGo na ZumboPay.
 */
export async function validateMerchant() {
  return zumbopayRequest('/merchant/validate');
}

/**
 * =========================================================
 * WALLETS
 * =========================================================
 */

/**
 * Obtém as wallets disponíveis para o merchant.
 */
export async function getWallets() {
  return zumbopayRequest('/wallets');
}

/**
 * Obtém uma wallet específica.
 */
export async function getWallet(walletId = ZUMBOPAY_WALLET_ID) {
  if (!walletId) {
    throw new Error('wallet_id não informado.');
  }

  return zumbopayRequest(`/wallets/${encodeURIComponent(walletId)}`);
}

/**
 * =========================================================
 * CHARGES
 * =========================================================
 */

/**
 * Cria uma cobrança direta.
 *
 * Ideal para:
 * - M-Pesa
 * - e-Mola
 *
 * O cliente recebe o pedido de autorização no telemóvel.
 */
export async function createCharge({
  amount,
  method,
  phone,
  reference,
  description,
  metadata = {},
  idempotencyKey,
} = {}) {
  const config = getConfig();

  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('Valor de pagamento inválido.');
  }

  if (!reference) {
    throw new Error('Referência do pagamento é obrigatória.');
  }

  const paymentMethod = normalizeZumboPayMethod(method);

  if (!['mpesa', 'emola'].includes(paymentMethod)) {
    throw new Error(
      'createCharge suporta apenas M-Pesa e e-Mola.'
    );
  }

  const normalizedPhone = normalizeMozambiquePhone(phone);

  const payload = {
    wallet_id: config.walletId,

    amount: numericAmount,

    method: paymentMethod,

    phone: normalizedPhone,

    reference: String(reference),

    ...(description
      ? {
          description: String(description),
        }
      : {}),

    ...(Object.keys(metadata).length
      ? {
          metadata,
        }
      : {}),
  };

  const key =
    idempotencyKey ||
    generateIdempotencyKey('PAYGO-CHARGE');

  const result = await zumbopayRequest('/charges', {
    method: 'POST',
    body: payload,
    idempotencyKey: key,
  });

  return {
    success: true,

    provider: 'zumbopay',

    type: 'charge',

    paymentId:
      result?.data?.id ||
      result?.data?.payment_id ||
      result?.payment_id ||
      result?.id ||
      null,

    reference:
      result?.data?.reference ||
      result?.reference ||
      reference,

    status:
      result?.data?.status ||
      result?.status ||
      'pending',

    amount:
      result?.data?.amount ||
      result?.amount ||
      numericAmount,

    method: paymentMethod,

    raw: result,
  };
}

/**
 * =========================================================
 * PAYMENTS / CHECKOUT
 * =========================================================
 */

/**
 * Cria um checkout hospedado pela ZumboPay.
 *
 * Pode ser usado quando queremos:
 * - M-Pesa
 * - e-Mola
 * - cartão
 * - checkout centralizado
 */
export async function createPayment({
  amount,
  method,
  reference,
  description,
  returnUrl,
  callbackUrl,
  metadata = {},
  idempotencyKey,
} = {}) {
  const config = getConfig();

  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('Valor de pagamento inválido.');
  }

  if (!reference) {
    throw new Error('Referência do pagamento é obrigatória.');
  }

  const paymentMethod = normalizeZumboPayMethod(method);

  const payload = {
    wallet_id: config.walletId,

    amount: numericAmount,

    method: paymentMethod,

    reference: String(reference),

    ...(description
      ? {
          description: String(description),
        }
      : {}),

    ...(returnUrl
      ? {
          return_url: returnUrl,
        }
      : {}),

    ...(callbackUrl
      ? {
          callback_url: callbackUrl,
        }
      : {}),

    ...(Object.keys(metadata).length
      ? {
          metadata,
        }
      : {}),
  };

  const key =
    idempotencyKey ||
    generateIdempotencyKey('PAYGO-PAYMENT');

  const result = await zumbopayRequest('/payments', {
    method: 'POST',
    body: payload,
    idempotencyKey: key,
  });

  return {
    success: true,

    provider: 'zumbopay',

    type: 'payment',

    paymentId:
      result?.data?.id ||
      result?.data?.payment_id ||
      result?.payment_id ||
      result?.id ||
      null,

    reference:
      result?.data?.reference ||
      result?.reference ||
      reference,

    status:
      result?.data?.status ||
      result?.status ||
      'pending',

    checkoutUrl:
      result?.data?.checkout_url ||
      result?.data?.checkoutUrl ||
      result?.checkout_url ||
      result?.checkoutUrl ||
      null,

    amount:
      result?.data?.amount ||
      result?.amount ||
      numericAmount,

    method: paymentMethod,

    raw: result,
  };
}

/**
 * =========================================================
 * PAYMENT STATUS
 * =========================================================
 */

/**
 * Consulta o estado de um pagamento.
 */
export async function getPaymentStatus(paymentId) {
  if (!paymentId) {
    throw new Error('paymentId é obrigatório.');
  }

  const result = await zumbopayRequest(
    `/payments/${encodeURIComponent(paymentId)}`
  );

  return {
    success: true,

    provider: 'zumbopay',

    paymentId,

    status:
      result?.data?.status ||
      result?.status ||
      'unknown',

    reference:
      result?.data?.reference ||
      result?.reference ||
      null,

    amount:
      result?.data?.amount ||
      result?.amount ||
      null,

    raw: result,
  };
}

/**
 * =========================================================
 * WEBHOOK
 * =========================================================
 */

/**
 * Verifica assinatura HMAC do webhook.
 *
 * A chave secreta deve ficar exclusivamente na Vercel:
 *
 * ZUMBOPAY_WEBHOOK_SECRET
 */
export function verifyWebhookSignature(
  rawBody,
  signature
) {
  const secret =
    process.env.ZUMBOPAY_WEBHOOK_SECRET || '';

  // Em produção queremos segredo configurado.
  if (!secret) {
    throw new Error(
      'ZUMBOPAY_WEBHOOK_SECRET não configurado.'
    );
  }

  if (!signature) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const provided = String(signature)
    .replace(/^sha256=/, '')
    .trim();

  if (expected.length !== provided.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(provided, 'utf8')
  );
}

/**
 * Extrai a assinatura de diferentes headers.
 */
export function getWebhookSignature(req) {
  return (
    req.headers?.['x-webhook-signature'] ||
    req.headers?.['x-zumbopay-signature'] ||
    req.headers?.['x-signature'] ||
    ''
  );
}

/**
 * =========================================================
 * WEBHOOK EVENT HELPERS
 * =========================================================
 */

export function getWebhookEvent(body = {}) {
  return (
    body?.event ||
    body?.type ||
    body?.data?.event ||
    null
  );
}

export function getWebhookPaymentData(body = {}) {
  return body?.data || body?.payment || body || {};
}

export function getWebhookPaymentId(body = {}) {
  const data = getWebhookPaymentData(body);

  return (
    data?.payment_id ||
    data?.paymentId ||
    data?.id ||
    null
  );
}

export function getWebhookReference(body = {}) {
  const data = getWebhookPaymentData(body);

  return (
    data?.reference ||
    body?.reference ||
    null
  );
}

export function getWebhookAmount(body = {}) {
  const data = getWebhookPaymentData(body);

  const amount = Number(
    data?.amount ??
      data?.gross_amount ??
      data?.grossAmount ??
      0
  );

  return Number.isFinite(amount)
    ? amount
    : 0;
}

/**
 * Verifica se o evento representa pagamento concluído.
 */
export function isSuccessfulWebhookEvent(event) {
  return [
    'payment.completed',
    'payment.success',
    'payment.succeeded',
    'charge.completed',
    'charge.success',
    'charge.succeeded',
  ].includes(String(event || '').toLowerCase());
}

/**
 * Verifica se o evento representa falha.
 */
export function isFailedWebhookEvent(event) {
  return [
    'payment.failed',
    'payment.cancelled',
    'payment.canceled',
    'charge.failed',
    'charge.cancelled',
    'charge.canceled',
  ].includes(String(event || '').toLowerCase());
}

/**
 * =========================================================
 * EXPORT DEFAULT
 * =========================================================
 */

const ZumboPay = {
  validateMerchant,
  getWallets,
  getWallet,

  createCharge,
  createPayment,

  getPaymentStatus,

  normalizeZumboPayMethod,
  normalizeMozambiquePhone,

  generateIdempotencyKey,

  verifyWebhookSignature,
  getWebhookSignature,

  getWebhookEvent,
  getWebhookPaymentData,
  getWebhookPaymentId,
  getWebhookReference,
  getWebhookAmount,

  isSuccessfulWebhookEvent,
  isFailedWebhookEvent,
};

export default ZumboPay;
