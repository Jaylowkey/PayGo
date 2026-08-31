import { requireZumboAdmin } from "./zumbopay/login.js";

const ZUMBO_URL = (process.env.ZUMBOPAY_API_URL || "https://zumbopay.com/api/public/v1").replace(/\/+$/, "");
const NETSHOP_URL = (process.env.NETSHOP_API_URL || "https://www.netshop.co.mz/api/v1").replace(/\/+$/, "");

function money(value) {
  const n = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function walletBalance(wallet) {
  for (const key of [
    "available_balance",
    "availableBalance",
    "balance",
    "current_balance",
    "currentBalance",
    "available",
    "amount",
    "wallet_balance",
  ]) {
    const n = numberValue(wallet?.[key]);
    if (n !== null) return money(n);
  }

  if (wallet?.balance && typeof wallet.balance === "object") {
    return walletBalance(wallet.balance);
  }

  return 0;
}

function normalizeWallets(data) {
  const raw = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.data?.wallets)
      ? data.data.wallets
      : Array.isArray(data?.wallets)
        ? data.wallets
        : Array.isArray(data)
          ? data
          : [];

  return raw
    .map((w) => ({
      id: String(w.id || w.wallet_id || w.walletId || ""),
      name: w.name || w.wallet_name || w.label || w.currency || "Wallet",
      method: String(w.method || w.type || w.channel || "").toLowerCase(),
      balance: walletBalance(w),
      currency: w.currency || "MZN",
      isActive: w.is_active ?? w.active ?? true,
    }))
    .filter((w) => w.id);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(20000),
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Resposta inválida do provider (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return data;
}

async function getZumboPay() {
  const key = process.env.ZUMBOPAY_API_KEY;
  const merchant = process.env.ZUMBOPAY_MERCHANT_ID;

  if (!key || !merchant) {
    return {
      configured: false,
      balance: 0,
      wallets: [],
      error: "Credenciais ZumboPay não configuradas.",
    };
  }

  try {
    const data = await request(`${ZUMBO_URL}/wallets`, {
      headers: {
        Authorization: `Bearer ${key}`,
        "X-Merchant-Id": merchant,
        Accept: "application/json",
      },
    });

    const wallets = normalizeWallets(data);
    const balance = money(wallets.reduce((sum, wallet) => sum + wallet.balance, 0));

    return {
      configured: true,
      balance,
      wallets,
      error: wallets.length ? "" : "A API ZumboPay não devolveu wallets para este merchant.",
    };
  } catch (error) {
    return {
      configured: true,
      balance: 0,
      wallets: [],
      error: error?.message || "Não foi possível consultar o saldo ZumboPay.",
    };
  }
}

async function getNetShop() {
  const key = process.env.NETSHOP_API_KEY;
  if (!key) {
    return {
      configured: false,
      balance: 0,
      wallets: [],
      error: "NETSHOP_API_KEY não configurada.",
    };
  }

  try {
    const headers = {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    };

    const candidates = [
      `${NETSHOP_URL}/wallets`,
      `${NETSHOP_URL}/balance`,
      `${NETSHOP_URL}/wallet/balance`,
    ];

    let lastError = "A API NetShop não disponibilizou o saldo.";

    for (const url of candidates) {
      try {
        const data = await request(url, { headers });
        const wallets = normalizeWallets(data);
        const direct = money(
          data?.balance ??
            data?.available_balance ??
            data?.availableBalance ??
            data?.data?.balance ??
            data?.data?.available_balance ??
            data?.data?.availableBalance,
        );
        const balance = direct || money(wallets.reduce((sum, wallet) => sum + wallet.balance, 0));

        return {
          configured: true,
          balance,
          wallets,
          error: balance || wallets.length ? "" : "A API NetShop não expôs o saldo neste endpoint.",
        };
      } catch (error) {
        lastError = error?.message || lastError;
      }
    }

    return {
      configured: true,
      balance: 0,
      wallets: [],
      error: lastError,
    };
  } catch (error) {
    return {
      configured: true,
      balance: 0,
      wallets: [],
      error: error?.message || "Não foi possível consultar o saldo NetShop.",
    };
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (!(await requireZumboAdmin(req))) {
    return res.status(401).json({ success: false, error: "Acesso administrativo necessário." });
  }
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Método não permitido." });
  }

  const [zumbopay, netshop] = await Promise.all([getZumboPay(), getNetShop()]);

  return res.status(200).json({
    success: true,
    zumbopay,
    netshop,
    fetchedAt: new Date().toISOString(),
  });
}
