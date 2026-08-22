import crypto from "crypto";

/**
 * =========================================================
 * PayGo → ZumboPay
 * =========================================================
 *
 * Integração server-side.
 *
 * Suporta:
 * - M-Pesa
 * - e-Mola
 * - Card
 * - STK/Charge
 * - Hosted Checkout
 * - Consulta de pagamento
 * - Wallets
 * - Payouts
 * - Webhooks HMAC-SHA256
 *
 * IMPORTANTE:
 * Nunca expor estas variáveis no frontend.
 *
 * ZUMBOPAY_API_URL
 * ZUMBOPAY_API_KEY
 * ZUMBOPAY_MERCHANT_ID
 * ZUMBOPAY_WEBHOOK_SECRET
 * ZUMBOPAY_WALLET_MPESA
 * ZUMBOPAY_WALLET_EMOLA
 * ZUMBOPAY_WALLET_CARD
 *
 * =========================================================
 */

const ZUMBOPAY_API_URL =
  process.env.ZUMBOPAY_API_URL ||
  "https://zumbopay.com/api/v1";

/**
 * =========================================================
 * CONFIG
 * =========================================================
 */

function getConfig() {
  return {
    apiUrl:
      String(
        ZUMBOPAY_API_URL
      ).replace(/\/+$/, ""),

    apiKey:
      process.env.ZUMBOPAY_API_KEY ||
      "",

    merchantId:
      process.env.ZUMBOPAY_MERCHANT_ID ||
      "",

    webhookSecret:
      process.env.ZUMBOPAY_WEBHOOK_SECRET ||
      "",

    walletMpesa:
      process.env.ZUMBOPAY_WALLET_MPESA ||
      "",

    walletEmola:
      process.env.ZUMBOPAY_WALLET_EMOLA ||
      "",

    walletCard:
      process.env.ZUMBOPAY_WALLET_CARD ||
      "",
  };
}

function requireConfig() {
  const config = getConfig();

  if (!config.apiKey) {
    throw new Error(
      "ZUMBOPAY_API_KEY não configurada."
    );
  }

  return config;
}

/**
 * =========================================================
 * UTILITÁRIOS
 * =========================================================
 */

/**
 * Normaliza telefone moçambicano.
 *
 * Aceita:
 *
 * 841234567
 * 258841234567
 * +258841234567
 * 0841234567
 *
 * Retorna:
 *
 * +258841234567
 */
export function normalizePhone(phone) {
  let value = String(phone || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^\d+]/g, "");

  if (!value) {
    throw new Error(
      "Número de telefone não informado."
    );
  }

  if (value.startsWith("00")) {
    value =
      "+" +
      value.substring(2);
  }

  if (value.startsWith("+")) {
    value =
      value.substring(1);
  }

  if (value.startsWith("258")) {
    return `+${value}`;
  }

  if (value.startsWith("0")) {
    value =
      value.substring(1);
  }

  if (/^8\d{8}$/.test(value)) {
    return `+258${value}`;
  }

  throw new Error(
    "Número de telefone moçambicano inválido."
  );
}

/**
 * Retorna somente números.
 *
 * Útil quando a API de payout/charge
 * exigir MSISDN sem +.
 */
export function normalizeMsisdn(phone) {
  return normalizePhone(phone)
    .replace("+", "");
}

/**
 * Normaliza método de pagamento.
 */
export function normalizePaymentMethod(
  method
) {
  const value =
    String(method || "")
      .trim()
      .toLowerCase()
      .replace(/[_\-\s]/g, "");

  if (
    [
      "mpesa",
      "mpesaapi",
      "mpsa",
    ].includes(value)
  ) {
    return "mpesa";
  }

  if (
    [
      "emola",
      "emolaapi",
      "e2mola",
    ].includes(value)
  ) {
    return "emola";
  }

  if (
    [
      "card",
      "visa",
      "mastercard",
      "cartao",
      "cartão",
    ].includes(value)
  ) {
    return "card";
  }

  if (
    [
      "mkesh",
      "mkeshapi",
    ].includes(value)
  ) {
    return "mkesh";
  }

  throw new Error(
    `Método de pagamento não suportado: ${method}`
  );
}

/**
 * Gera chave de idempotência.
 */
export function generateIdempotencyKey(
  prefix = "PAYGO"
) {
  return `${prefix}-${Date.now()}-${crypto
    .randomBytes(10)
    .toString("hex")}`;
}

/**
 * =========================================================
 * WALLET MAPPING
 * =========================================================
 */

export function getWalletId(
  method
) {
  const config =
    requireConfig();

  const cleanMethod =
    normalizePaymentMethod(
      method
    );

  switch (cleanMethod) {
    case "mpesa":
      return (
        config.walletMpesa || ""
      );

    case "emola":
      return (
        config.walletEmola || ""
      );

    case "card":
      return (
        config.walletCard || ""
      );

    default:
      return "";
  }
}

/**
 * =========================================================
 * HTTP CLIENT
 * =========================================================
 */

async function zumboRequest(
  endpoint,
  options = {}
) {
  const config =
    requireConfig();

  const cleanEndpoint =
    String(endpoint || "")
      .replace(/^\/+/, "");

  const url =
    `${config.apiUrl}/${cleanEndpoint}`;

  /**
   * A API pública atual usa Bearer.
   *
   * O X-Merchant-Id é enviado quando
   * configurado, permitindo compatibilidade
   * com endpoints administrativos da conta.
   */
  const headers = {
    Accept:
      "application/json",

    "Content-Type":
      "application/json",

    Authorization:
      `Bearer ${config.apiKey}`,

    ...(config.merchantId
      ? {
          "X-Merchant-Id":
            config.merchantId,
        }
      : {}),

    ...(options.headers || {}),
  };

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      30000
    );

  try {
    const response =
      await fetch(url, {
        method:
          options.method ||
          "GET",

        headers,

        body:
          options.body,

        signal:
          options.signal ||
          controller.signal,
      });

    const text =
      await response.text();

    let data = {};

    if (text) {
      try {
        data =
          JSON.parse(text);
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
    }

    if (!response.ok) {
      const message =
        data?.error?.message ||
        data?.error ||
        data?.message ||
        data?.detail ||
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

      throw error;
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * =========================================================
 * PAYMENT — STK / CHARGE
 * =========================================================
 *
 * M-Pesa / e-Mola
 *
 * Usa /charges conforme a documentação
 * da integração fornecida.
 *
 * =========================================================
 */

export async function createCharge({
  amount,
  phone,
  customerName,
  sourceId,
  method,
}) {
  if (
    amount === undefined ||
    amount === null
  ) {
    throw new Error(
      "Valor do pagamento não informado."
    );
  }

  const numericAmount =
    Number(amount);

  if (
    !Number.isFinite(
      numericAmount
    ) ||
    numericAmount <= 0
  ) {
    throw new Error(
      "Valor do pagamento inválido."
    );
  }

  const cleanMethod =
    normalizePaymentMethod(
      method
    );

  if (
    ![
      "mpesa",
      "emola",
    ].includes(cleanMethod)
  ) {
    throw new Error(
      "STK Charge suporta M-Pesa e e-Mola."
    );
  }

  const phoneIntl =
    normalizePhone(phone);

  const phoneMsisdn =
    normalizeMsisdn(phone);

  const walletId =
    getWalletId(
      cleanMethod
    );

  /**
   * Wallet pode ser obrigatória
   * dependendo da configuração da
   * conta/API da ZumboPay.
   */
  const payload = {
    amount:
      numericAmount,

    msisdn:
      phoneMsisdn,

    customer_name:
      customerName ||
      "Cliente PayGo",

    source_id:
      String(
        sourceId ||
          generateIdempotencyKey(
            "PAYGO-CHARGE"
          )
      ),

    method:
      cleanMethod,

    /**
     * Mantido para compatibilidade
     * com a documentação fornecida.
     */
    ...(walletId
      ? {
          wallet_id:
            walletId,
        }
      : {}),
  };

  const idempotencyKey =
    String(
      sourceId ||
        generateIdempotencyKey(
          "PAYGO-CHARGE"
        )
    );

  const response =
    await zumboRequest(
      "/charges",
      {
        method:
          "POST",

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
    response?.data ||
    response;

  return {
    success:
      true,

    provider:
      "zumbopay",

    type:
      "charge",

    paymentId:
      data?.id ||
      data?.payment_id ||
      data?.paymentId ||
      null,

    reference:
      data?.reference ||
      data?.transaction_id ||
      data?.transactionId ||
      null,

    status:
      data?.status ||
      "pending",

    amount:
      Number(
        data?.amount
      ) ||
      numericAmount,

    method:
      data?.method ||
      cleanMethod,

    phone:
      phoneIntl,

    raw:
      response,
  };
}

/**
 * =========================================================
 * PAYMENT — HOSTED CHECKOUT
 * =========================================================
 *
 * Endpoint:
 *
 * POST /api/v1/payments
 *
 * Payload baseado no formato atual
 * documentado pela ZumboPay.
 * =========================================================
 */

export async function createPayment({
  amount,
  reference,
  title,
  description,
  method,
  phone,
  callbackUrl,
  returnUrl,
}) {
  if (
    amount === undefined ||
    amount === null
  ) {
    throw new Error(
      "Valor do pagamento não informado."
    );
  }

  const numericAmount =
    Number(amount);

  if (
    !Number.isFinite(
      numericAmount
    ) ||
    numericAmount <= 0
  ) {
    throw new Error(
      "Valor do pagamento inválido."
    );
  }

  const cleanMethod =
    normalizePaymentMethod(
      method || "mpesa"
    );

  const payload = {
    amount:
      numericAmount,

    currency:
      "MZN",

    method:
      cleanMethod,

    customer: {
      ...(phone
        ? {
            phone:
              normalizePhone(
                phone
              ),
          }
        : {}),
    },

    callback_url:
      callbackUrl ||
      "https://api.paygo.co.mz/api/zumbopay-webhook",

    ...(returnUrl
      ? {
          return_url:
            returnUrl,
        }
      : {}),

    ...(title
      ? {
          title,
        }
      : {}),

    ...(description
      ? {
          description,
        }
      : {}),

    ...(reference
      ? {
          reference:
            String(
              reference
            ),
        }
      : {}),
  };

  /**
   * Remove customer vazio.
   */
  if (
    Object.keys(
      payload.customer
    ).length === 0
  ) {
    delete payload.customer;
  }

  const response =
    await zumboRequest(
      "/payments",
      {
        method:
          "POST",

        body:
          JSON.stringify(
            payload
          ),
      }
    );

  /**
   * A API pode retornar os dados
   * diretamente ou dentro de data.
   */
  const data =
    response?.data ||
    response;

  return {
    success:
      true,

    provider:
      "zumbopay",

    type:
      "payment",

    paymentId:
      data?.id ||
      data?.payment_id ||
      data?.paymentId ||
      null,

    reference:
      data?.reference ||
      data?.transaction_id ||
      data?.transactionId ||
      reference ||
      null,

    status:
      data?.status ||
      "pending",

    checkoutUrl:
      data?.checkout_url ||
      data?.checkoutUrl ||
      data?.url ||
      null,

    amount:
      Number(
        data?.amount
      ) ||
      numericAmount,

    method:
      data?.method ||
      cleanMethod,

    raw:
      response,
  };
}

/**
 * =========================================================
 * PAYMENT STATUS
 * =========================================================
 */

export async function getPaymentStatus(
  reference
) {
  if (!reference) {
    throw new Error(
      "Referência do pagamento é obrigatória."
    );
  }

  const response =
    await zumboRequest(
      `/payments/${encodeURIComponent(
        String(reference)
      )}`,
      {
        method:
          "GET",
      }
    );

  return {
    success:
      true,

    provider:
      "zumbopay",

    payment:
      response?.data ||
      response,

    raw:
      response,
  };
}

/**
 * =========================================================
 * WALLETS
 * =========================================================
 */

export async function getWallets() {
  const response =
    await zumboRequest(
      "/wallets",
      {
        method:
          "GET",
      }
    );

  const wallets =
    response?.data ||
    response?.wallets ||
    response;

  return Array.isArray(
    wallets
  )
    ? wallets
    : [];
}

export async function getWalletBalance(
  walletId
) {
  if (!walletId) {
    throw new Error(
      "walletId é obrigatório."
    );
  }

  const wallets =
    await getWallets();

  const wallet =
    wallets.find(
      (item) =>
        String(
          item?.id
        ) ===
          String(
            walletId
          ) ||
        String(
          item?.wallet_id
        ) ===
          String(
            walletId
          ) ||
        String(
          item?.wallet_code
        ) ===
          String(
            walletId
          )
    );

  return wallet ||
    null;
}

/**
 * Retorna um resumo financeiro
 * das wallets.
 */
export async function getWalletSummary() {
  const wallets =
    await getWallets();

  const normalized =
    wallets.map(
      (wallet) => ({
        id:
          wallet?.id ||
          wallet?.wallet_id ||
          null,

        walletCode:
          wallet?.wallet_code ||
          wallet?.code ||
          null,

        name:
          wallet?.name ||
          null,

        method:
          wallet?.method ||
          null,

        currency:
          wallet?.currency ||
          "MZN",

        balance:
          Number(
            wallet?.balance ||
              0
          ),

        availableBalance:
          Number(
            wallet?.available_balance ||
              wallet?.availableBalance ||
              wallet?.balance ||
              0
          ),

        isActive:
          Boolean(
            wallet?.is_active ??
              wallet?.isActive ??
              true
          ),
      })
    );

  const totalBalance =
    normalized.reduce(
      (
        total,
        wallet
      ) =>
        total +
        wallet.balance,
      0
    );

  return {
    success:
      true,

    currency:
      "MZN",

    totalBalance,

    wallets:
      normalized,

    updatedAt:
      new Date().toISOString(),

    raw:
      wallets,
  };
}

/**
 * =========================================================
 * MERCHANT VALIDATION
 * =========================================================
 */

export async function validateMerchant() {
  const response =
    await zumboRequest(
      "/merchant/validate",
      {
        method:
          "GET",
      }
    );

  return {
    success:
      true,

    provider:
      "zumbopay",

    data:
      response?.data ||
      response,

    raw:
      response,
  };
}

/**
 * =========================================================
 * PAYOUT
 * =========================================================
 *
 * Administração PayGo → ZumboPay.
 *
 * IMPORTANTE:
 * Este endpoint deve ser chamado
 * somente pelo backend protegido
 * da PayGo.
 *
 * =========================================================
 */

export async function createPayout({
  amount,
  method,
  destination,
  notes,
  autoDispatch = false,
  walletId,
}) {
  if (
    amount === undefined ||
    amount === null
  ) {
    throw new Error(
      "Valor do payout não informado."
    );
  }

  const numericAmount =
    Number(amount);

  if (
    !Number.isFinite(
      numericAmount
    ) ||
    numericAmount <= 0
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

  const cleanMethod =
    normalizePaymentMethod(
      method
    );

  if (
    ![
      "mpesa",
      "emola",
    ].includes(
      cleanMethod
    )
  ) {
    throw new Error(
      "Payout atualmente configurado para M-Pesa ou e-Mola."
    );
  }

  const selectedWallet =
    walletId ||
    getWalletId(
      cleanMethod
    );

  const normalizedDestination =
    normalizePhone(
      destination
    );

  const payload = {
    amount:
      numericAmount,

    method:
      cleanMethod,

    destination:
      normalizedDestination,

    ...(selectedWallet
      ? {
          wallet_id:
            selectedWallet,
        }
      : {}),

    ...(notes
      ? {
          notes:
            String(notes),
        }
      : {}),

    ...(cleanMethod ===
      "mpesa" &&
    autoDispatch === true
      ? {
          auto_dispatch:
            true,
        }
      : {}),
  };

  const idempotencyKey =
    generateIdempotencyKey(
      "PAYGO-PAYOUT"
    );

  const response =
    await zumboRequest(
      "/payouts",
      {
        method:
          "POST",

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
    response?.data ||
    response;

  return {
    success:
      true,

    provider:
      "zumbopay",

    payoutId:
      data?.id ||
      data?.payout_id ||
      data?.payoutId ||
      null,

    reference:
      data?.reference ||
      null,

    providerReference:
      data?.provider_reference ||
      data?.providerReference ||
      null,

    status:
      data?.status ||
      "pending",

    method:
      data?.method ||
      cleanMethod,

    destination:
      data?.destination ||
      normalizedDestination,

    amount:
      Number(
        data?.amount
      ) ||
      numericAmount,

    feeAmount:
      Number(
        data?.fee_amount ||
          data?.feeAmount ||
          0
      ),

    netAmount:
      Number(
        data?.net_amount ||
          data?.netAmount ||
          0
      ),

    currency:
      data?.currency ||
      "MZN",

    autoDispatched:
      Boolean(
        data?.auto_dispatched ??
          data?.autoDispatched ??
          autoDispatch
      ),

    raw:
      response,
  };
}

/**
 * =========================================================
 * PAYOUT STATUS
 * =========================================================
 */

export async function getPayoutStatus(
  payoutId
) {
  if (!payoutId) {
    throw new Error(
      "payoutId é obrigatório."
    );
  }

  const response =
    await zumboRequest(
      `/payouts/${encodeURIComponent(
        String(payoutId)
      )}`,
      {
        method:
          "GET",
      }
    );

  return {
    success:
      true,

    provider:
      "zumbopay",

    payout:
      response?.data ||
      response,

    raw:
      response,
  };
}

/**
 * =========================================================
 * WEBHOOK — SIGNATURE
 * =========================================================
 *
 * ZumboPay:
 *
 * HMAC-SHA256
 *
 * Header:
 *
 * x-zumbopay-signature
 *
 * =========================================================
 */

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

  /**
   * HMAC SHA256 =
   * 64 caracteres hexadecimais.
   */
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
      .update(
        rawBody,
        "utf8"
      )
      .digest(
        "hex"
      );

  const expectedBuffer =
    Buffer.from(
      expected,
      "hex"
    );

  const receivedBuffer =
    Buffer.from(
      cleanSignature,
      "hex"
    );

  if (
    expectedBuffer.length !==
    receivedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    expectedBuffer,
    receivedBuffer
  );
}

/**
 * =========================================================
 * WEBHOOK HELPERS
 * =========================================================
 */

export function getWebhookSignature(
  req
) {
  if (!req) {
    return "";
  }

  return (
    req.headers?.[
      "x-zumbopay-signature"
    ] ||
    req.headers?.[
      "X-ZumboPay-Signature"
    ] ||
    req.headers?.[
      "x-webhook-signature"
    ] ||
    ""
  );
}

export function getWebhookEvent(
  body = {}
) {
  return (
    body?.event ||
    body?.type ||
    body?.event_type ||
    body?.eventType ||
    null
  );
}

export function getWebhookPaymentData(
  body = {}
) {
  return (
    body?.data ||
    body?.payment ||
    body?.transaction ||
    body
  );
}

export function getWebhookPaymentId(
  body = {}
) {
  const data =
    getWebhookPaymentData(
      body
    );

  return (
    data?.id ||
    data?.payment_id ||
    data?.paymentId ||
    null
  );
}

export function getWebhookReference(
  body = {}
) {
  const data =
    getWebhookPaymentData(
      body
    );

  return (
    data?.reference ||
    data?.source_id ||
    data?.sourceId ||
    body?.reference ||
    null
  );
}

export function getWebhookAmount(
  body = {}
) {
  const data =
    getWebhookPaymentData(
      body
    );

  const amount =
    Number(
      data?.amount ??
        data?.gross_amount ??
        data?.grossAmount ??
        data?.value ??
        0
    );

  return Number.isFinite(
    amount
  )
    ? amount
    : 0;
}

export function getWebhookStatus(
  body = {}
) {
  const data =
    getWebhookPaymentData(
      body
    );

  return (
    data?.status ||
    body?.status ||
    null
  );
}

export function getWebhookPayoutData(
  body = {}
) {
  return (
    body?.data ||
    body?.payout ||
    body
  );
}

export function getWebhookPayoutId(
  body = {}
) {
  const data =
    getWebhookPayoutData(
      body
    );

  return (
    data?.id ||
    data?.payout_id ||
    data?.payoutId ||
    null
  );
}

export function getWebhookPayoutReference(
  body = {}
) {
  const data =
    getWebhookPayoutData(
      body
    );

  return (
    data?.reference ||
    data?.provider_reference ||
    data?.providerReference ||
    null
  );
}

/**
 * =========================================================
 * EVENT HELPERS
 * =========================================================
 */

export function isPaymentSuccessEvent(
  event
) {
  const value =
    String(
      event || ""
    ).toLowerCase();

  return [
    "payment.succeeded",
    "payment.success",
    "payment.completed",
    "charge.succeeded",
    "charge.success",
    "charge.completed",
  ].includes(
    value
  );
}

export function isPaymentFailedEvent(
  event
) {
  const value =
    String(
      event || ""
    ).toLowerCase();

  return [
    "payment.failed",
    "payment.failure",
    "payment.cancelled",
    "payment.canceled",
    "charge.failed",
    "charge.cancelled",
    "charge.canceled",
  ].includes(
    value
  );
}

export function isPaymentRefundedEvent(
  event
) {
  const value =
    String(
      event || ""
    ).toLowerCase();

  return [
    "payment.refunded",
    "payment.refund",
    "charge.refunded",
  ].includes(
    value
  );
}

export function isPayoutCompletedEvent(
  event
) {
  const value =
    String(
      event || ""
    ).toLowerCase();

  return [
    "payout.completed",
    "payout.success",
    "payout.succeeded",
  ].includes(
    value
  );
}

export function isPayoutFailedEvent(
  event
) {
  const value =
    String(
      event || ""
    ).toLowerCase();

  return [
    "payout.failed",
    "payout.failure",
    "payout.cancelled",
    "payout.canceled",
  ].includes(
    value
  );
}

/**
 * =========================================================
 * EXPORT DEFAULT
 * =========================================================
 */

const ZumboPay = {
  createCharge,

  createPayment,

  getPaymentStatus,

  getWallets,

  getWalletBalance,

  getWalletSummary,

  validateMerchant,

  createPayout,

  getPayoutStatus,

  normalizePhone,

  normalizeMsisdn,

  normalizePaymentMethod,

  generateIdempotencyKey,

  getWalletId,

  verifyWebhookSignature,

  getWebhookSignature,

  getWebhookEvent,

  getWebhookPaymentData,

  getWebhookPaymentId,

  getWebhookReference,

  getWebhookAmount,

  getWebhookStatus,

  getWebhookPayoutData,

  getWebhookPayoutId,

  getWebhookPayoutReference,

  isPaymentSuccessEvent,

  isPaymentFailedEvent,

  isPaymentRefundedEvent,

  isPayoutCompletedEvent,

  isPayoutFailedEvent,
};

export default ZumboPay;
