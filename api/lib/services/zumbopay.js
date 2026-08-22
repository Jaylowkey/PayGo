import crypto from "crypto";

const ZUMBO_API_URL =
  process.env.ZUMBOPAY_API_URL ||
  "https://zumbopay.com/api/public/v1";

function getConfig() {
  return {
    apiKey: process.env.ZUMBOPAY_API_KEY || "",
    merchantId: process.env.ZUMBOPAY_MERCHANT_ID || "",
    webhookSecret: process.env.ZUMBOPAY_WEBHOOK_SECRET || "",

    walletMpesa:
      process.env.ZUMBOPAY_WALLET_MPESA || "",

    walletEmola:
      process.env.ZUMBOPAY_WALLET_EMOLA || "",

    walletCard:
      process.env.ZUMBOPAY_WALLET_CARD || "",
  };
}

function requireConfig() {
  const config = getConfig();

  if (!config.apiKey) {
    throw new Error(
      "ZUMBOPAY_API_KEY não configurada."
    );
  }

  if (!config.merchantId) {
    throw new Error(
      "ZUMBOPAY_MERCHANT_ID não configurada."
    );
  }

  return config;
}

function normalizePhone(phone) {
  let value = String(phone || "")
    .replace(/\s+/g, "")
    .replace(/[^\d+]/g, "");

  if (value.startsWith("+")) {
    value = value.substring(1);
  }

  if (!value.startsWith("258")) {
    value = `258${value}`;
  }

  return value;
}

function getWalletId(method) {
  const config = requireConfig();

  switch (
    String(method || "")
      .toLowerCase()
      .trim()
  ) {
    case "mpesa":
      return config.walletMpesa;

    case "emola":
      return config.walletEmola;

    case "card":
    case "visa":
    case "mastercard":
      return config.walletCard;

    default:
      return "";
  }
}

async function zumboRequest(
  endpoint,
  options = {}
) {
  const config = requireConfig();

  const url =
    `${ZUMBO_API_URL.replace(/\/+$/, "")}` +
    `/${String(endpoint).replace(/^\/+/, "")}`;

  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    "X-Merchant-Id": config.merchantId,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  const response = await fetch(url, {
    ...options,
    headers,
    signal:
      options.signal ||
      AbortSignal.timeout(30000),
  });

  const text = await response.text();

  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Resposta inválida da ZumboPay (${response.status}).`
    );
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      `ZumboPay HTTP ${response.status}`;

    const error = new Error(message);

    error.status = response.status;
    error.code =
      data?.error?.code ||
      data?.code ||
      null;

    error.data = data;

    throw error;
  }

  return data;
}

// =========================================================
// PAYMENT — STK PUSH
// =========================================================

export async function createCharge({
  amount,
  phone,
  customerName,
  sourceId,
  method,
}) {
  const walletId = getWalletId(method);

  if (!walletId) {
    throw new Error(
      `Wallet ZumboPay não configurada para ${method}.`
    );
  }

  const normalizedPhone =
    normalizePhone(phone);

  const response = await zumboRequest(
    "/charges",
    {
      method: "POST",

      headers: {
        "Idempotency-Key": String(
          sourceId
        ),
      },

      body: JSON.stringify({
        wallet_id: walletId,
        amount: Number(amount),
        msisdn: normalizedPhone,
        customer_name:
          customerName || "Cliente PayGo",
        source_id: String(sourceId),
      }),
    }
  );

  const data = response?.data || {};

  return {
    success: true,

    paymentId:
      data.id ||
      data.payment_id ||
      null,

    reference:
      data.reference ||
      null,

    status:
      data.status ||
      "pending",

    amount:
      Number(data.amount) ||
      Number(amount),

    method,

    raw: response,
  };
}

// =========================================================
// PAYMENT — HOSTED CHECKOUT
// =========================================================

export async function createPayment({
  amount,
  reference,
  title,
  description,
  channels,
  method,
  walletId,
  maxUses = 1,
  expiresAt,
}) {
  const selectedWallet =
    walletId ||
    getWalletId(method || "mpesa");

  if (!selectedWallet) {
    throw new Error(
      "Wallet ZumboPay não configurada."
    );
  }

  const payload = {
    title:
      title ||
      `Pagamento PayGo #${reference}`,

    amount: Number(amount),

    currency: "MZN",

    channels:
      channels || [
        "mpesa",
        "emola",
        "card",
      ],

    wallet_id: selectedWallet,

    ...(description
      ? { description }
      : {}),

    max_uses: maxUses,

    ...(expiresAt
      ? { expires_at: expiresAt }
      : {}),
  };

  const response = await zumboRequest(
    "/payments",
    {
      method: "POST",

      body: JSON.stringify(payload),
    }
  );

  const data = response?.data || {};

  return {
    success: true,

    paymentId:
      data.id ||
      null,

    reference:
      data.reference ||
      reference ||
      null,

    status:
      data.status ||
      "active",

    checkoutUrl:
      data.checkout_url ||
      null,

    amount:
      Number(data.amount) ||
      Number(amount),

    method:
      method ||
      "checkout",

    raw: response,
  };
}

// =========================================================
// PAYMENT STATUS
// =========================================================

export async function getPaymentStatus(
  reference
) {
  if (!reference) {
    throw new Error(
      "Referência do pagamento é obrigatória."
    );
  }

  return await zumboRequest(
    `/payments/${encodeURIComponent(
      reference
    )}`,
    {
      method: "GET",
    }
  );
}

// =========================================================
// WALLETS
// =========================================================

export async function getWallets() {
  const response =
    await zumboRequest("/wallets", {
      method: "GET",
    });

  return response?.data || [];
}

export async function getWalletBalance(
  walletId
) {
  const wallets = await getWallets();

  const wallet = wallets.find(
    (item) =>
      String(item.id) ===
        String(walletId) ||
      String(item.wallet_code) ===
        String(walletId)
  );

  return wallet || null;
}

// =========================================================
// MERCHANT VALIDATION
// =========================================================

export async function validateMerchant() {
  return await zumboRequest(
    "/merchant/validate",
    {
      method: "GET",
    }
  );
}

// =========================================================
// PAYOUT
// =========================================================

export async function createPayout({
  amount,
  method,
  destination,
  notes,
  autoDispatch = false,
  walletId,
}) {
  const selectedWallet =
    walletId ||
    getWalletId(method);

  if (!selectedWallet) {
    throw new Error(
      `Wallet ZumboPay não configurada para ${method}.`
    );
  }

  if (!amount || Number(amount) <= 0) {
    throw new Error(
      "Valor do payout inválido."
    );
  }

  if (!destination) {
    throw new Error(
      "Número de destino é obrigatório."
    );
  }

  const normalizedDestination =
    normalizePhone(destination);

  const payload = {
    wallet_id: selectedWallet,

    amount: Number(amount),

    method,

    destination:
      normalizedDestination,

    ...(notes
      ? { notes }
      : {}),

    ...(method === "mpesa" &&
    autoDispatch === true
      ? {
          auto_dispatch: true,
        }
      : {}),
  };

  const idempotencyKey =
    `paygo-payout-${Date.now()}-${crypto
      .randomBytes(8)
      .toString("hex")}`;

  const response =
    await zumboRequest(
      "/payouts",
      {
        method: "POST",

        headers: {
          "Idempotency-Key":
            idempotencyKey,
        },

        body: JSON.stringify(payload),
      }
    );

  const data = response?.data || {};

  return {
    success: true,

    payoutId:
      data.id ||
      null,

    reference:
      data.reference ||
      null,

    providerReference:
      data.provider_reference ||
      null,

    status:
      data.status ||
      "pending",

    method:
      data.method ||
      method,

    destination:
      data.destination ||
      normalizedDestination,

    amount:
      Number(data.amount) ||
      Number(amount),

    feeAmount:
      Number(data.fee_amount) ||
      0,

    netAmount:
      Number(data.net_amount) ||
      0,

    currency:
      data.currency ||
      "MZN",

    autoDispatched:
      Boolean(
        data.auto_dispatched
      ),

    raw: response,
  };
}

// =========================================================
// WEBHOOK SIGNATURE
// =========================================================

export function verifyWebhookSignature(
  rawBody,
  signature
) {
  const config = getConfig();

  if (!config.webhookSecret) {
    console.error(
      "ZUMBOPAY_WEBHOOK_SECRET não configurado."
    );

    return false;
  }

  if (!signature) {
    return false;
  }

  const cleanSignature =
    String(signature)
      .replace(/^sha256=/i, "")
      .trim();

  if (
    !/^[a-fA-F0-9]{64}$/.test(
      cleanSignature
    )
  ) {
    return false;
  }

  const expected =
    crypto
      .createHmac(
        "sha256",
        config.webhookSecret
      )
      .update(rawBody)
      .digest("hex");

  const receivedBuffer =
    Buffer.from(
      cleanSignature,
      "hex"
    );

  const expectedBuffer =
    Buffer.from(
      expected,
      "hex"
    );

  if (
    receivedBuffer.length !==
    expectedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    receivedBuffer,
    expectedBuffer
  );
}

export {
  normalizePhone,
  getWalletId,
};
