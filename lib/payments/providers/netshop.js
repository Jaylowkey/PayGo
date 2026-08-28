const BASE_URL = (process.env.NETSHOP_API_URL || "https://www.netshop.co.mz/api/v1").replace(/\/+$/, "");

function config() {
  return {
    apiKey: process.env.NETSHOP_API_KEY || "",
    wallets: {
      mpesa: process.env.NETSHOP_WALLET_MPESA || "",
      emola: process.env.NETSHOP_WALLET_EMOLA || "",
      mkesh: process.env.NETSHOP_WALLET_MKESH || "",
      card: process.env.NETSHOP_WALLET_CARD || "",
    },
    legacyWalletId: process.env.NETSHOP_WALLET_ID || "",
  };
}

function normalizeMethod(method) {
  const value = String(method || "").toLowerCase().trim();
  if (["m-pesa", "m_pesa"].includes(value)) return "mpesa";
  if (["e-mola", "e_mola"].includes(value)) return "emola";
  if (["m-kesh", "m_kesh", "m kesh"].includes(value)) return "mkesh";
  if (["visa", "mastercard", "cartao", "cartão", "card"].includes(value)) return "card";
  return value;
}

function walletForMethod(method) {
  const { wallets, legacyWalletId } = config();
  return wallets[method] || legacyWalletId || "";
}

function assertConfigured(method = "") {
  const { apiKey } = config();
  const walletId = walletForMethod(method);
  if (!apiKey) {
    throw Object.assign(new Error("NETSHOP_API_KEY não configurada."), {
      code: "PROVIDER_NOT_CONFIGURED",
      provider: "netshop",
      retryable: false,
    });
  }
  if (!walletId) {
    throw Object.assign(new Error(`NETSHOP_WALLET_${String(method || "").toUpperCase()} não configurada.`), {
      code: "PROVIDER_NOT_CONFIGURED",
      provider: "netshop",
      retryable: false,
    });
  }
}

async function request(path, options = {}, method = "") {
  assertConfigured(method);
  const { apiKey } = config();
  const walletId = walletForMethod(method);
  const response = await fetch(`${BASE_URL}/${String(path).replace(/^\/+/, "")}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Wallet-ID": String(walletId),
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(30000),
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error(`Resposta inválida do NetShop (HTTP ${response.status}).`), {
      provider: "netshop",
      status: response.status,
      retryable: false,
    });
  }

  if (!response.ok) {
    throw Object.assign(
      new Error(data?.error?.message || data?.message || `NetShop HTTP ${response.status}`),
      {
        provider: "netshop",
        status: response.status,
        code: data?.error?.code || data?.code || null,
        retryable: false,
        providerResponse: data,
      },
    );
  }

  return data;
}

export async function health() {
  const { apiKey, wallets, legacyWalletId } = config();
  const configuredWallets = Object.fromEntries(
    Object.entries(wallets).map(([method, value]) => [method, Boolean(value)]),
  );
  const anyWallet = Object.values(wallets).some(Boolean) || Boolean(legacyWalletId);

  if (!apiKey) {
    return {
      provider: "netshop",
      configured: false,
      healthy: false,
      error: "NETSHOP_API_KEY não configurada.",
      wallets: configuredWallets,
    };
  }

  if (!anyWallet) {
    return {
      provider: "netshop",
      configured: false,
      healthy: false,
      error: "Nenhuma wallet NetShop configurada.",
      wallets: configuredWallets,
    };
  }

  return {
    provider: "netshop",
    configured: true,
    healthy: true,
    wallets: configuredWallets,
  };
}

export async function createCharge({ amount, method, phone, reference, customerName }) {
  const normalizedMethod = normalizeMethod(method);
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw Object.assign(new Error("Valor de pagamento inválido."), {
      code: "INVALID_AMOUNT",
      provider: "netshop",
      retryable: false,
    });
  }

  // NetShop publica mínimo de 50 MT para Visa/Mastercard.
  if (normalizedMethod === "card" && numericAmount < 50) {
    throw Object.assign(new Error("O pagamento por cartão requer um mínimo de 50 MT."), {
      code: "CARD_MINIMUM_AMOUNT",
      provider: "netshop",
      retryable: false,
    });
  }

  const payload = {
    amount: numericAmount,
    currency: "MZN",
    method: normalizedMethod,
    ...(phone ? { msisdn: normalizePhone(phone) } : {}),
    reference: String(reference || `PAYGO-${Date.now()}`),
    ...(customerName ? { customer_name: String(customerName).slice(0, 160) } : {}),
  };

  const response = await request(
    "/charges",
    {
      method: "POST",
      headers: { "Idempotency-Key": payload.reference },
      body: JSON.stringify(payload),
    },
    normalizedMethod,
  );

  const data = response?.data || response;
  const checkoutUrl =
    data?.checkout_url ||
    data?.checkoutUrl ||
    data?.payment_url ||
    data?.paymentUrl ||
    response?.checkout_url ||
    response?.checkoutUrl ||
    response?.payment_url ||
    response?.paymentUrl ||
    null;

  if (normalizedMethod === "card" && !checkoutUrl) {
    throw Object.assign(new Error("O NetShop criou a cobrança, mas não devolveu o checkout de cartão."), {
      code: "CARD_CHECKOUT_URL_MISSING",
      provider: "netshop",
      retryable: false,
      providerResponse: response,
    });
  }

  return {
    success: true,
    provider: "netshop",
    paymentId: data?.id || data?.payment_id || null,
    reference: data?.reference || payload.reference,
    status: data?.status || "pending",
    amount: Number(data?.amount ?? amount),
    method: normalizedMethod,
    checkoutUrl,
    raw: response,
  };
}

function normalizePhone(phone) {
  let value = String(phone || "").replace(/\s+/g, "").replace(/[^\d+]/g, "");
  if (value.startsWith("+")) value = value.slice(1);
  if (!value.startsWith("258")) value = `258${value}`;
  if (!/^2588\d{8}$/.test(value)) throw new Error("Número de telefone inválido.");
  return `+${value}`;
}

export default { health, createCharge };
