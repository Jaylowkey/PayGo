const BASE_URL = (process.env.ZUMBOPAY_API_URL || "https://zumbopay.com/api/public/v1").replace(/\/+$/, "");

function config() {
  return {
    apiKey: process.env.ZUMBOPAY_API_KEY || "",
    merchantId: process.env.ZUMBOPAY_MERCHANT_ID || "",
    walletMpesa: process.env.ZUMBOPAY_WALLET_MPESA || "",
    walletEmola: process.env.ZUMBOPAY_WALLET_EMOLA || "",
    walletMkesh: process.env.ZUMBOPAY_WALLET_MKESH || "",
    walletCard: process.env.ZUMBOPAY_WALLET_CARD || "",
  };
}

function method(value) {
  const v = String(value || "").toLowerCase().trim();
  if (["m-pesa", "m_pesa"].includes(v)) return "mpesa";
  if (["e-mola", "e_mola"].includes(v)) return "emola";
  if (["m-kesh", "m_kesh", "m kesh"].includes(v)) return "mkesh";
  if (["visa", "mastercard", "cartao", "cartão"].includes(v)) return "card";
  return v;
}

function configuredWallet(m) {
  const c = config();
  return ({ mpesa: c.walletMpesa, emola: c.walletEmola, mkesh: c.walletMkesh, card: c.walletCard })[m] || "";
}

function assertConfigured() {
  const c = config();
  if (!c.apiKey) throw Object.assign(new Error("ZUMBOPAY_API_KEY não configurada."), { code: "PROVIDER_NOT_CONFIGURED", provider: "zumbopay" });
  if (!c.merchantId) throw Object.assign(new Error("ZUMBOPAY_MERCHANT_ID não configurada."), { code: "PROVIDER_NOT_CONFIGURED", provider: "zumbopay" });
}

async function request(path, options = {}) {
  assertConfigured();
  const c = config();
  const response = await fetch(`${BASE_URL}/${String(path).replace(/^\/+/, "")}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${c.apiKey}`,
      "X-Merchant-Id": c.merchantId,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {
    throw Object.assign(new Error(`Resposta inválida da ZumboPay (HTTP ${response.status}).`), { provider: "zumbopay", status: response.status, retryable: response.status >= 500 });
  }
  if (!response.ok) {
    throw Object.assign(new Error(data?.error?.message || data?.message || `ZumboPay HTTP ${response.status}`), {
      provider: "zumbopay",
      status: response.status,
      code: data?.error?.code || data?.code || null,
      retryable: response.status === 429 || response.status >= 500,
      providerResponse: data,
    });
  }
  return data;
}

export async function health() {
  try {
    assertConfigured();
    return { provider: "zumbopay", configured: true, healthy: true };
  } catch (error) {
    return { provider: "zumbopay", configured: false, healthy: false, error: error.message };
  }
}

export async function createCharge({ amount, method: rawMethod, phone, reference, customerName }) {
  const m = method(rawMethod);
  if (!["mpesa", "emola", "mkesh"].includes(m)) throw Object.assign(new Error("Método não suportado pela ZumboPay para charge."), { provider: "zumbopay", code: "METHOD_NOT_SUPPORTED", retryable: false });

  const walletId = configuredWallet(m);
  if (!walletId) throw Object.assign(new Error(`Wallet ZumboPay não configurada para ${m}.`), { provider: "zumbopay", code: "WALLET_NOT_CONFIGURED", retryable: false });

  let msisdn = String(phone || "").replace(/\s+/g, "").replace(/[^\d+]/g, "");
  if (msisdn.startsWith("+")) msisdn = msisdn.slice(1);
  if (!msisdn.startsWith("258")) msisdn = `258${msisdn}`;
  if (!/^2588\d{8}$/.test(msisdn)) throw Object.assign(new Error("Número de telefone inválido."), { provider: "zumbopay", code: "INVALID_PHONE", retryable: false });

  const source = String(reference || `PAYGO-${Date.now()}`);
  const response = await request("/charges", {
    method: "POST",
    headers: { "Idempotency-Key": source },
    body: JSON.stringify({
      wallet_id: walletId,
      amount: Number(amount),
      msisdn,
      customer_name: customerName || "Cliente PayGo",
      source_id: source,
    }),
  });
  const data = response?.data || {};
  return {
    success: true,
    provider: "zumbopay",
    paymentId: data?.id || data?.payment_id || null,
    reference: data?.reference || source,
    status: data?.status || "pending",
    amount: Number(data?.amount ?? amount),
    method: m,
    raw: response,
  };
}

export default { health, createCharge };
