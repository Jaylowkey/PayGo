import * as netshop from "./providers/netshop.js";
import * as zumbopay from "./providers/zumbopay.js";

const PROVIDERS = Object.freeze({ netshop, zumbopay });

function normalizeProvider(value) {
  const v = String(value || "").toLowerCase().trim();
  if (v === "netshop" || v === "zumbopay") return v;
  return null;
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
 * Regra importante: a camada NÃO faz fallback automático depois que um
 * provider iniciou uma transação. Um timeout/erro ambíguo pode significar
 * que o cliente já foi cobrado. O failover deve acontecer apenas antes da
 * criação da operação ou por decisão explícita após reconciliação.
 */
export async function createCharge({ provider = "auto", ...payload }) {
  const requested = normalizeProvider(provider);
  const order = requested ? [requested] : configuredOrder();
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
      const result = await adapter.createCharge(payload);
      return { ...result, providerPriority: order.indexOf(name) + 1, attempts };
    } catch (error) {
      attempts.push({
        provider: name,
        error: error.message,
        code: error.code || null,
        retryable: Boolean(error.retryable),
      });

      // Nunca muda de provider depois de uma resposta ambígua/timeout.
      // Só permite passar ao próximo provider em erros explicitamente
      // classificados como indisponibilidade antes da criação.
      if (!error.retryable || order.indexOf(name) === order.length - 1) {
        error.paymentAttempts = attempts;
        throw error;
      }
    }
  }

  const error = new Error("Nenhum provider de pagamentos PayGo está configurado.");
  error.code = "NO_PAYMENT_PROVIDER";
  error.paymentAttempts = attempts;
  throw error;
}

export function getProvider(name) {
  const normalized = normalizeProvider(name);
  return normalized ? PROVIDERS[normalized] : null;
}

export default { createCharge, healthCheck, getPaymentProviders, getProvider };
