import crypto from 'crypto';

const BASE_URL = (process.env.ZUMBOPAY_API_BASE_URL || 'https://zumbopay.com/api/v1').replace(/\/+$/, '');
const API_KEY = process.env.ZUMBOPAY_API_KEY || process.env.ZUMBOPAY_SECRET_KEY || '';
const MERCHANT_ID = process.env.ZUMBOPAY_MERCHANT_ID || '';
const WEBHOOK_SECRET = process.env.ZUMBOPAY_WEBHOOK_SECRET || '';

function headers(extra = {}) {
  if (!API_KEY) throw new Error('ZUMBOPAY_API_KEY em falta.');
  return {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(MERCHANT_ID ? { 'X-Merchant-ID': MERCHANT_ID } : {}),
    ...extra,
  };
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: headers(options.headers || {}),
  });

  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!response.ok) {
    const error = new Error(data?.message || data?.error || data?.detail || `ZumboPay HTTP ${response.status}`);
    error.status = response.status;
    error.code = data?.code || null;
    error.response = data;
    throw error;
  }

  return data;
}

function unwrap(data) {
  return data?.data ?? data?.result ?? data;
}

function normalizePhone(phone) {
  const raw = String(phone || '').replace(/\D/g, '');
  if (!raw) return '';
  return raw.startsWith('258') ? `+${raw}` : `+258${raw}`;
}

export async function createCharge({ amount, phone, customerName = 'Cliente PayGo', sourceId, method = 'mpesa' }) {
  const body = {
    amount: Number(amount),
    currency: 'MZN',
    method,
    customer: {
      phone: normalizePhone(phone),
      name: customerName,
    },
    reference: sourceId,
  };

  const data = unwrap(await request('/payments', {
    method: 'POST',
    body: JSON.stringify(body),
  }));

  return {
    paymentId: data?.id || data?.payment_id || data?.paymentId || null,
    reference: data?.reference || sourceId,
    status: data?.status || data?.state || 'pending',
    amount: Number(data?.amount ?? amount),
    checkoutUrl: data?.checkout_url || data?.checkoutUrl || null,
    raw: data,
  };
}

export async function createPayment({ title, amount, reference, description, channels = ['mpesa', 'emola', 'card'], method }) {
  const selectedMethod = method && method !== 'default' ? method : channels?.[0] || 'mpesa';
  const body = {
    amount: Number(amount),
    currency: 'MZN',
    method: selectedMethod,
    reference,
    description: description || title || `Pagamento PayGo #${reference}`,
    customer: {},
  };

  const data = unwrap(await request('/payments', {
    method: 'POST',
    body: JSON.stringify(body),
  }));

  return {
    paymentId: data?.id || data?.payment_id || data?.paymentId || null,
    reference: data?.reference || reference,
    status: data?.status || data?.state || 'pending',
    checkoutUrl: data?.checkout_url || data?.checkoutUrl || null,
    amount: Number(data?.amount ?? amount),
    method: data?.method || selectedMethod,
    raw: data,
  };
}

export async function getPaymentStatus(reference) {
  const encoded = encodeURIComponent(String(reference));
  const data = unwrap(await request(`/payments/${encoded}`, { method: 'GET' }));
  return data;
}

export async function getWallets() {
  const data = unwrap(await request('/wallets', { method: 'GET' }));
  return Array.isArray(data) ? data : (data?.wallets || []);
}

export function verifyWebhookSignature(rawBody, signature) {
  if (!WEBHOOK_SECRET) return true;
  if (!signature) return false;

  const value = String(signature).trim();

  // Suporta o formato HMAC-SHA256 simples e o formato timestamp,v1=... usado por integrações modernas.
  let provided = value;
  let signedPayload = String(rawBody || '');

  if (value.includes('v1=')) {
    const parts = Object.fromEntries(value.split(',').map(part => {
      const [k, ...rest] = part.trim().split('=');
      return [k, rest.join('=')];
    }));
    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
    provided = parts.v1 || '';
    signedPayload = `${timestamp}.${rawBody || ''}`;
  } else if (value.startsWith('sha256=')) {
    provided = value.slice(7);
  }

  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(signedPayload).digest('hex');
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
