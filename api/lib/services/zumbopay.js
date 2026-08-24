import crypto from "crypto";

/**
 * ============================================================
 * PayGo → ZumboPay
 * ============================================================
 *
 * Integração server-side com ZumboPay.
 *
 * Suporta:
 * - M-Pesa STK Push
 * - e-Mola STK Push
 * - Visa / Mastercard via Hosted Checkout
 * - Consulta de pagamentos
 * - Consulta de wallets
 * - Payouts
 * - Validação do merchant
 * - Webhook HMAC-SHA256
 *
 * IMPORTANTE:
 * A API Key NUNCA deve chegar ao frontend.
 */

const ZUMBO_API_URL =
  process.env.ZUMBOPAY_API_URL ||
  "https://zumbopay.com/api/public/v1";

// ============================================================
// CONFIGURAÇÃO
// ============================================================

function getConfig() {
  return {
    apiKey:
      process.env.ZUMBOPAY_API_KEY || "",

    merchantId:
      process.env.ZUMBOPAY_MERCHANT_ID || "",

    webhookSecret:
      process.env.ZUMBOPAY_WEBHOOK_SECRET || "",

    walletMpesa:
      process.env.ZUMBOPAY_WALLET_MPESA || "",

    walletEmola:
      process.env.ZUMBOPAY_WALLET_EMOLA || "",

    walletMkesh:
      process.env.ZUMBOPAY_WALLET_MKESH || "",

    walletCard:
      process.env.ZUMBOPAY_WALLET_CARD || "",
  };
}

// ============================================================
// VALIDAR CONFIGURAÇÃO
// ============================================================

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

// ============================================================
// UUID
// ============================================================

function isUUID(value) {
  if (!value) {
    return false;
  }

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value).trim()
  );
}

// ============================================================
// NORMALIZAR TELEFONE
// ============================================================

export function normalizePhone(phone) {
  let value = String(phone || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^\d+]/g, "");

  if (!value) {
    throw new Error(
      "Número de telefone é obrigatório."
    );
  }

  if (value.startsWith("+")) {
    value = value.substring(1);
  }

  if (!value.startsWith("258")) {
    value = `258${value}`;
  }

  if (!/^2588\d{8}$/.test(value)) {
    throw new Error(
      "Número de telefone inválido. Use um número moçambicano válido."
    );
  }

  return value;
}

// ============================================================
// NORMALIZAR MÉTODO
// ============================================================

export function normalizePaymentMethod(method) {
  const value = String(method || "")
    .toLowerCase()
    .trim();

  switch (value) {
    case "mpesa":
    case "m-pesa":
    case "m_pesa":
      return "mpesa";

    case "emola":
    case "e-mola":
    case "e_mola":
    case "emola":
      return "emola";

    case "mkesh":
    case "m-kesh":
    case "m_kesh":
    case "m kesh":
      return "mkesh";

    case "card":
    case "visa":
    case "mastercard":
    case "cartao":
    case "cartão":
      return "card";

    default:
      return value;
  }
}

// ============================================================
// WALLET CONFIGURADA
// ============================================================

export function getWalletId(method) {
  const config = requireConfig();

  const normalizedMethod =
    normalizePaymentMethod(method);

  switch (normalizedMethod) {
    case "mpesa":
      return config.walletMpesa;

    case "emola":
      return config.walletEmola;

    case "mkesh":
      return config.walletMkesh;

    case "card":
      return config.walletCard;

    default:
      return "";
  }
}

// ============================================================
// REQUEST GENÉRICO ZUMBOPAY
// ============================================================

async function zumboRequest(
  endpoint,
  options = {}
) {
  const config = requireConfig();

  const baseUrl =
    ZUMBO_API_URL.replace(/\/+$/, "");

  const cleanEndpoint =
    String(endpoint)
      .replace(/^\/+/, "");

  const url =
    `${baseUrl}/${cleanEndpoint}`;

  const headers = {
    Authorization:
      `Bearer ${config.apiKey}`,

    "X-Merchant-Id":
      config.merchantId,

    Accept:
      "application/json",

    "Content-Type":
      "application/json",

    ...(options.headers || {}),
  };

  console.log(
    `[ZumboPay] ${options.method || "GET"} ${url}`
  );

  const response = await fetch(url, {
    ...options,
    headers,
    signal:
      options.signal ||
      AbortSignal.timeout(30000),
  });

  const text =
    await response.text();

  let data = {};

  try {
    data =
      text
        ? JSON.parse(text)
        : {};
  } catch {
    const error =
      new Error(
        `Resposta inválida da ZumboPay (${response.status}).`
      );

    error.status =
      response.status;

    error.raw =
      text;

    throw error;
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      `ZumboPay HTTP ${response.status}`;

    const error =
      new Error(message);

    error.status =
      response.status;

    error.code =
      data?.error?.code ||
      data?.code ||
      null;

    error.data =
      data;

    console.error(
      "[ZumboPay] API ERROR:",
      {
        status:
          response.status,

        code:
          error.code,

        message:
          message,

        data:
          data,
      }
    );

    throw error;
  }

  return data;
}

// ============================================================
// OBTER TODAS AS WALLETS
// ============================================================

export async function getWallets() {
  const response =
    await zumboRequest(
      "/wallets",
      {
        method: "GET",
      }
    );

  const wallets =
    Array.isArray(response?.data)
      ? response.data
      : [];

  console.log(
    "[ZumboPay] Wallets encontradas:",
    wallets.map(
      (wallet) => ({
        id:
          wallet.id,

        wallet_code:
          wallet.wallet_code,

        method:
          wallet.method,

        currency:
          wallet.currency,

        active:
          wallet.is_active,
      })
    )
  );

  return wallets;
}

// ============================================================
// RESOLVER WALLET AUTOMATICAMENTE
// ============================================================
//
// Esta é a parte que corrige o "Invalid uuid".
//
// Podemos receber:
//   UUID
//   wallet_code
//
// Exemplo:
//   ZUMBOPAY_WALLET_MPESA=553009
//
// A API /wallets retorna:
//   {
//      id: "uuid-real",
//      wallet_code: "553009",
//      method: "mpesa"
//   }
//
// E nós enviamos para /charges:
//   wallet_id: "uuid-real"
// ============================================================

export async function resolveWalletId(
  method,
  configuredWallet
) {
  const normalizedMethod =
    normalizePaymentMethod(method);

  const configured =
    String(
      configuredWallet ||
        getWalletId(normalizedMethod) ||
        ""
    ).trim();

  console.log(
    `[ZumboPay] Resolvendo wallet para ${normalizedMethod}`
  );

  // ----------------------------------------------------------
  // Se não existe configuração, procurar automaticamente
  // ----------------------------------------------------------

  if (!configured) {
    console.log(
      `[ZumboPay] Nenhuma wallet configurada para ${normalizedMethod}. Buscando automaticamente...`
    );

    const wallets =
      await getWallets();

    const wallet =
      wallets.find(
        (item) =>
          normalizePaymentMethod(
            item?.method
          ) === normalizedMethod &&
          item?.is_active === true
      );

    if (!wallet) {
      throw new Error(
        `Nenhuma wallet ativa encontrada na ZumboPay para ${normalizedMethod}.`
      );
    }

    if (!wallet.id) {
      throw new Error(
        `A wallet ${normalizedMethod} foi encontrada, mas não possui UUID.`
      );
    }

    console.log(
      `[ZumboPay] Wallet automática selecionada:`,
      {
        method:
          normalizedMethod,

        wallet_code:
          wallet.wallet_code,

        wallet_id:
          wallet.id,
      }
    );

    return wallet.id;
  }

  // ----------------------------------------------------------
  // Se já é UUID
  // ----------------------------------------------------------

  if (isUUID(configured)) {
    console.log(
      `[ZumboPay] Wallet configurada já é UUID: ${configured}`
    );

    return configured;
  }

  // ----------------------------------------------------------
  // Caso seja wallet_code
  // ----------------------------------------------------------

  console.log(
    `[ZumboPay] "${configured}" não é UUID. Procurando como wallet_code...`
  );

  const wallets =
    await getWallets();

  const wallet =
    wallets.find(
      (item) =>
        String(
          item?.wallet_code || ""
        ) === configured &&
        normalizePaymentMethod(
          item?.method
        ) === normalizedMethod &&
        item?.is_active === true
    );

  if (!wallet) {
    throw new Error(
      `Wallet "${configured}" não encontrada na ZumboPay para o método ${normalizedMethod}.`
    );
  }

  if (!wallet.id) {
    throw new Error(
      `A wallet "${configured}" foi encontrada, mas a ZumboPay não devolveu o UUID.`
    );
  }

  console.log(
    `[ZumboPay] Wallet resolvida com sucesso:`,
    {
      method:
        normalizedMethod,

      wallet_code:
        wallet.wallet_code,

      wallet_id:
        wallet.id,
    }
  );

  return wallet.id;
}

// ============================================================
// STK PUSH
// ============================================================

export async function createCharge({
  amount,
  phone,
  customerName,
  sourceId,
  method,
}) {
  const normalizedMethod =
    normalizePaymentMethod(method);

  if (
    normalizedMethod !== "mpesa" &&
    normalizedMethod !== "emola" &&
    normalizedMethod !== "mkesh"
  ) {
    throw new Error(
      "createCharge suporta apenas M-Pesa, e-Mola e mKesh."
    );
  }

  const normalizedPhone =
    normalizePhone(phone);

  // ----------------------------------------------------------
  // Resolver UUID REAL da wallet
  // ----------------------------------------------------------

  const walletId =
    await resolveWalletId(
      normalizedMethod
    );

  if (!walletId) {
    throw new Error(
      `Wallet não encontrada para ${normalizedMethod}.`
    );
  }

  // ----------------------------------------------------------
  // Idempotência
  // ----------------------------------------------------------

  const source =
    String(
      sourceId ||
        `paygo-${Date.now()}`
    );

  const payload = {
    wallet_id:
      walletId,

    amount:
      Number(amount),

    msisdn:
      normalizedPhone,

    customer_name:
      customerName ||
      "Cliente PayGo",

    source_id:
      source,
  };

  console.log(
    "[ZumboPay] Criando STK:",
    {
      method:
        normalizedMethod,

      amount:
        Number(amount),

      phone:
        normalizedPhone,

      sourceId:
        source,

      walletId:
        walletId,
    }
  );

  const response =
    await zumboRequest(
      "/charges",
      {
        method: "POST",

        headers: {
          "Idempotency-Key":
            source,
        },

        body:
          JSON.stringify(
            payload
          ),
      }
    );

  const data =
    response?.data || {};

  console.log(
    "[ZumboPay] STK response:",
    {
      status:
        data.status,

      reference:
        data.reference,

      channel:
        data.channel,

      code:
        data.code,
    }
  );

  return {
    success:
      true,

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
      Number(
        data.amount
      ) ||
      Number(amount),

    method:
      normalizedMethod,

    phone:
      normalizedPhone,

    channel:
      data.channel ||
      normalizedMethod,

    code:
      data.code ||
      null,

    raw:
      response,
  };
}

// ============================================================
// HOSTED CHECKOUT
// ============================================================

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
  const normalizedMethod =
    normalizePaymentMethod(
      method || "card"
    );

  // ----------------------------------------------------------
  // Para /payments podemos utilizar UUID.
  // Se não vier, resolvemos automaticamente.
  // ----------------------------------------------------------

  let selectedWallet;

  if (walletId) {
    selectedWallet =
      await resolveWalletId(
        normalizedMethod,
        walletId
      );
  } else {
    selectedWallet =
      await resolveWalletId(
        normalizedMethod
      );
  }

  if (!selectedWallet) {
    throw new Error(
      "Nenhuma wallet ZumboPay configurada."
    );
  }

  const payload = {
    title:
      title ||
      `Pagamento PayGo #${reference}`,

    amount:
      Number(amount),

    currency:
      "MZN",

    channels:
      channels || [
        "mpesa",
        "emola",
        "card",
      ],

    wallet_id:
      selectedWallet,

    max_uses:
      Number(maxUses) || 1,

    ...(description
      ? {
          description,
        }
      : {}),

    ...(expiresAt
      ? {
          expires_at:
            expiresAt,
        }
      : {}),
  };

  console.log(
    "[ZumboPay] Criando checkout:",
    {
      amount:
        payload.amount,

      reference:
        reference,

      channels:
        payload.channels,

      walletId:
        selectedWallet,
    }
  );

  const response =
    await zumboRequest(
      "/payments",
      {
        method: "POST",

        body:
          JSON.stringify(
            payload
          ),
      }
    );

  const data =
    response?.data || {};

  const checkoutUrl =
    data.checkout_url ||
    response.checkout_url ||
    null;

  console.log(
    "[ZumboPay] Checkout criado:",
    {
      reference:
        data.reference,

      checkoutUrl:
        checkoutUrl,

      status:
        data.status,
    }
  );

  return {
    success:
      true,

    paymentId:
      data.id ||
      null,

    reference:
      data.reference ||
      reference ||
      null,

    slug:
      data.slug ||
      null,

    status:
      data.status ||
      "active",

    checkoutUrl:
      checkoutUrl,

    amount:
      Number(
        data.amount
      ) ||
      Number(amount),

    method:
      normalizedMethod,

    raw:
      response,
  };
}

// ============================================================
// CONSULTAR PAGAMENTO
// ============================================================

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

// ============================================================
// LISTAR PAGAMENTOS
// ============================================================

export async function listPayments({
  limit = 50,
  status,
} = {}) {
  const params =
    new URLSearchParams();

  params.set(
    "limit",
    String(limit)
  );

  if (status) {
    params.set(
      "status",
      String(status)
    );
  }

  return await zumboRequest(
    `/payments?${params.toString()}`,
    {
      method: "GET",
    }
  );
}

// ============================================================
// WALLET ESPECÍFICA
// ============================================================

export async function getWalletBalance(
  walletIdOrCode,
  method
) {
  const wallets =
    await getWallets();

  const configured =
    String(
      walletIdOrCode || ""
    ).trim();

  const normalizedMethod =
    method
      ? normalizePaymentMethod(method)
      : null;

  const wallet =
    wallets.find(
      (item) => {
        const matchesId =
          String(item?.id || "") ===
          configured;

        const matchesCode =
          String(
            item?.wallet_code || ""
          ) === configured;

        const matchesMethod =
          !normalizedMethod ||
          normalizePaymentMethod(
            item?.method
          ) === normalizedMethod;

        return (
          (matchesId ||
            matchesCode) &&
          matchesMethod
        );
      }
    );

  return wallet || null;
}

// ============================================================
// SALDOS DAS WALLETS
// ============================================================

export async function getWalletBalances() {
  const wallets =
    await getWallets();

  return wallets.map(
    (wallet) => ({
      id:
        wallet.id ||
        null,

      walletCode:
        wallet.wallet_code ||
        null,

      name:
        wallet.name ||
        null,

      method:
        wallet.method ||
        null,

      currency:
        wallet.currency ||
        "MZN",

      balance:
        Number(
          wallet.balance
        ) || 0,

      isActive:
        Boolean(
          wallet.is_active
        ),

      createdAt:
        wallet.created_at ||
        null,
    })
  );
}

// ============================================================
// SALDO POR MÉTODO
// ============================================================

export async function getBalanceByMethod(
  method
) {
  const normalizedMethod =
    normalizePaymentMethod(method);

  const wallets =
    await getWallets();

  const wallet =
    wallets.find(
      (item) =>
        normalizePaymentMethod(
          item?.method
        ) === normalizedMethod &&
        item?.is_active === true
    );

  if (!wallet) {
    return null;
  }

  return {
    id:
      wallet.id,

    walletCode:
      wallet.wallet_code,

    method:
      wallet.method,

    currency:
      wallet.currency ||
      "MZN",

    balance:
      Number(
        wallet.balance
      ) || 0,

    isActive:
      Boolean(
        wallet.is_active
      ),
  };
}

// ============================================================
// VALIDAR MERCHANT
// ============================================================

export async function validateMerchant() {
  return await zumboRequest(
    "/merchant/validate",
    {
      method: "GET",
    }
  );
}

// ============================================================
// PAYOUT
// ============================================================

export async function createPayout({
  amount,
  method,
  destination,
  notes,
  autoDispatch = false,
  walletId,
}) {
  const normalizedMethod =
    normalizePaymentMethod(method);

  if (
    normalizedMethod !== "mpesa" &&
    normalizedMethod !== "emola"
  ) {
    throw new Error(
      "Método de payout inválido. Use mpesa ou emola."
    );
  }

  if (
    !amount ||
    Number(amount) <= 0
  ) {
    throw new Error(
      "Valor do payout inválido."
    );
  }

  if (!destination) {
    throw new Error(
      "Número de destino é obrigatório."
    );
  }

  // ----------------------------------------------------------
  // Wallet UUID
  // ----------------------------------------------------------

  const selectedWallet =
    await resolveWalletId(
      normalizedMethod,
      walletId
    );

  // ----------------------------------------------------------
  // Telefone
  // ----------------------------------------------------------

  const normalizedDestination =
    normalizePhone(
      destination
    );

  // ----------------------------------------------------------
  // Auto dispatch
  // Só M-Pesa
  // ----------------------------------------------------------

  const payload = {
    wallet_id:
      selectedWallet,

    amount:
      Number(amount),

    method:
      normalizedMethod,

    destination:
      normalizedDestination,

    ...(notes
      ? {
          notes,
        }
      : {}),

    ...(normalizedMethod ===
      "mpesa" &&
    autoDispatch === true
      ? {
          auto_dispatch:
            true,
        }
      : {}),
  };

  // ----------------------------------------------------------
  // Idempotency
  // ----------------------------------------------------------

  const idempotencyKey =
    `paygo-payout-${Date.now()}-${crypto
      .randomBytes(8)
      .toString("hex")}`;

  console.log(
    "[ZumboPay] Criando payout:",
    {
      amount:
        payload.amount,

      method:
        payload.method,

      destination:
        normalizedDestination,

      autoDispatch:
        autoDispatch,

      walletId:
        selectedWallet,
    }
  );

  const response =
    await zumboRequest(
      "/payouts",
      {
        method: "POST",

        headers: {
          "Idempotency-Key":
            idempotencyKey,
        },

        body:
          JSON.stringify(
            payload
          ),
      }
    );

  const data =
    response?.data || {};

  return {
    success:
      true,

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
      normalizedMethod,

    destination:
      data.destination ||
      normalizedDestination,

    amount:
      Number(
        data.amount
      ) ||
      Number(amount),

    feeAmount:
      Number(
        data.fee_amount
      ) || 0,

    netAmount:
      Number(
        data.net_amount
      ) || 0,

    currency:
      data.currency ||
      "MZN",

    autoDispatched:
      Boolean(
        data.auto_dispatched
      ),

    raw:
      response,
  };
}

// ============================================================
// VERIFICAR ASSINATURA DO WEBHOOK
// ============================================================

export function verifyWebhookSignature(
  rawBody,
  signature
) {
  const config =
    getConfig();

  if (
    !config.webhookSecret
  ) {
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
      .replace(
        /^sha256=/i,
        ""
      )
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

// ============================================================
// ALIAS PARA COMPATIBILIDADE
// ============================================================
//
// Caso algum arquivo antigo ainda importe:
// validateWebhookSignature
//
// continuará funcionando.
// ============================================================

export const validateWebhookSignature =
  verifyWebhookSignature;

// ============================================================
// EXPORTS
// ============================================================

export {
  isUUID,
  getConfig,
  requireConfig,
  zumboRequest,
};
