import { requireZumboAdmin } from "./zumbopay/login.js";

const ZUMBO_URL = (process.env.ZUMBOPAY_API_URL || "https://zumbopay.com/api/public/v1").replace(/\/+$/, "");
const NETSHOP_URL = (process.env.NETSHOP_API_URL || "https://www.netshop.co.mz/api/v1").replace(/\/+$/, "");

function money(value) {
  const n = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function normalizeWallets(data) {
  const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data?.wallets) ? data.wallets : [];
  return raw.map((w) => ({
    id: String(w.id || w.wallet_id || w.walletId || ""),
    name: w.name || w.wallet_name || w.label || "Wallet",
    method: String(w.method || w.type || w.channel || "").toLowerCase(),
    balance: money(w.balance ?? w.available_balance ?? w.availableBalance ?? w.amount),
    currency: w.currency || "MZN",
  })).filter((w) => w.id);
}

async function json(url, options = {}) {
  const r = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  let d = {};
  try { d = text ? JSON.parse(text) : {}; } catch { throw new Error(`Resposta inválida do provider (HTTP ${r.status}).`); }
  if (!r.ok) throw new Error(d?.error?.message || d?.message || `HTTP ${r.status}`);
  return d;
}

async function zumbo() {
  const key = process.env.ZUMBOPAY_API_KEY;
  const merchant = process.env.ZUMBOPAY_MERCHANT_ID;
  if (!key || !merchant) return { configured: false, balance: 0, wallets: [], error: "Credenciais ZumboPay não configuradas." };
  try {
    const d = await json(`${ZUMBO_URL}/wallets`, { headers: { Authorization: `Bearer ${key}`, "X-Merchant-Id": merchant, Accept: "application/json" } });
    const wallets = normalizeWallets(d);
    return { configured: true, balance: wallets.reduce((s, w) => s + w.balance, 0), wallets };
  } catch (e) { return { configured: true, balance: 0, wallets: [], error: e.message }; }
}

async function netshop() {
  const key = process.env.NETSHOP_API_KEY;
  if (!key) return { configured: false, balance: 0, wallets: [], error: "NETSHOP_API_KEY não configurada." };
  try {
    const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    const candidates = [`${NETSHOP_URL}/wallets`, `${NETSHOP_URL}/balance`, `${NETSHOP_URL}/wallet/balance`];
    for (const url of candidates) {
      try {
        const d = await json(url, { headers });
        const wallets = normalizeWallets(d);
        const explicit = money(d?.data?.balance ?? d?.balance ?? d?.data?.available_balance ?? d?.available_balance);
        return { configured: true, balance: explicit || wallets.reduce((s, w) => s + w.balance, 0), wallets };
      } catch {}
    }
    return { configured: true, balance: 0, wallets: [], error: "A API NetShop não disponibilizou um endpoint de saldo compatível." };
  } catch (e) { return { configured: true, balance: 0, wallets: [], error: e.message }; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!(await requireZumboAdmin(req))) return res.status(401).json({ success: false, error: "Acesso administrativo necessário." });
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Método não permitido." });
  const [zumbopay, netshop] = await Promise.all([zumbo(), netshop()]);
  return res.status(200).json({ success: true, zumbopay, netshop, fetchedAt: new Date().toISOString() });
}
