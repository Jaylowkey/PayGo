import * as netshop from "./providers/netshop.js";
import * as zumbopay from "./providers/zumbopay.js";

const PROVIDERS = Object.freeze({ netshop, zumbopay });

function normalizeProvider(value) {
  const v = String(value || "").toLowerCase().trim();
  if (v === "netshop" || v === "zumbopay") return v;
  return null;
}

function normalizeMethod(value) {
  const v = String(value || "").toLowerCase().trim();
  if (["m-pesa", "m_pesa"].includes(v)) return "mpesa";
  if (["e-mola", "e_mola"].includes(v)) return "emola";
  if (["m-kesh", "m_kesh", "m kesh"].includes(v)) return "mkesh";
  if (["visa", "mastercard", "cartao", "cartão", "card"].includes(v)) return "card";
  return v;
}

function configuredOrder() {
  const primary = normalizeProvider(process.env.PAYGO_PAYMENT_PRIMARY) || "netshop";
  const secondary = normalizeProvider(process.env.PAYGO_PAYMENT_SECONDARY) || "zumbopay";
  return [...new Set([primary, secondary])];
}

export function getPaymentProviders() {
  return configuredOrder().map((name, index) => ({
    name,
    priority: index + 1,
    configured: Boolean(PROVIDERS[name]),
  }));
}

export async function healthCheck(provider = null) {
  const names = provider ? [normalizeProvider(provider)].filter(Boolean) : configuredOrder();
  const result = {};
  for (const name of names) {
    result[name] = await PROVIDERS[name].health();
  }
  return result;
}

/**
 * Camada PayGo de pagamentos.
 *
 * Cartões são sempre encaminhados para o NetShop, que é o provider
 * atualmente integrado para Visa/Mastercard. O ZumboPay não deve receber
 * uma operação de cartão por fallback, pois o adapter público atual não
 * suporta charge por cartão.
 *
 * Regra importante: a camada NÃO faz fallback automático depois que um
 * provider iniciou uma transação. Um timeout/erro ambíguo pode significar
 * que o cliente já foi cobrado. O failover deve acontecer apenas antes da
 * criação da operação ou por decisão explícita após reconciliação.
 */
export async function createCharge({ provider = "auto", method: rawMethod, ...payload }) {
  const paymentMethod = normalizeMethod(rawMethod);
  const requested = normalizeProvider(provider);

  // Visa/Mastercard usam exclusivamente o checkout NetShop.
  const order = paymentMethod === "card"
    ? ["netshop"]
    : (requested ? [requested] : configuredOrder());

  const attempts = [];

  for (const name of order) {
    const adapter = PROVIDERS[name];
    if (!adapter) continue;

    const health = await adapter.health();
    if (!health.configured) {
      attempts.push({ provider: name, skipped: true, reason: health.error || "not_configured" });
      continue;
    }

    try {
      const result = await adapter.createCharge({
        ...payload,
        method: paymentMethod,
      });
      return { ...result, providerPriority: order.indexOf(name) + 1, attempts };
    } catch (error) {
      attempts.push({
        provider: name,
        error: error.message,
        code: error.code || null,
        retryable: Boolean(error.retryable),
      });

      // Nunca muda de provider depois de uma resposta ambígua/timeout.
      if (!error.retryable || order.indexOf(name) === order.length - 1) {
        error.paymentAttempts = attempts;
        throw error;
      }
    }
  }

  const error = new Error(
    paymentMethod === "card"
      ? "O checkout de cartão não está configurado no NetShop."
      : "Nenhum provider de pagamentos PayGo está configurado."
  );
  error.code = paymentMethod === "card" ? "CARD_PROVIDER_NOT_CONFIGURED" : "NO_PAYMENT_PROVIDER";
  error.paymentAttempts = attempts;
  throw error;
}

export function getProvider(name) {
  const normalized = normalizeProvider(name);
  return normalized ? PROVIDERS[normalized] : null;
}

export default { createCharge, healthCheck, getPaymentProviders, getProvider };
