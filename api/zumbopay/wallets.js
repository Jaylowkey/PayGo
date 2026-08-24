import { getApps, initializeApp, cert } from "firebase-admin/app";

const BASE_URL = (process.env.ZUMBOPAY_API_URL || "https://zumbopay.com/api/public/v1").replace(/\/+$/, "");

function getConfig() {
  const apiKey = process.env.ZUMBOPAY_API_KEY || "";
  const merchantId = process.env.ZUMBOPAY_MERCHANT_ID || "";
  if (!apiKey || !merchantId) throw new Error("Credenciais ZumboPay não configuradas.");
  return { apiKey, merchantId };
}

async function request(path) {
  const { apiKey, merchantId } = getConfig();
  const response = await fetch(`${BASE_URL}/${path.replace(/^\/+/, "")}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Merchant-Id": merchantId,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Resposta inválida da ZumboPay (${response.status}).`); }
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || `ZumboPay HTTP ${response.status}`);
    error.status = response.status;
    error.code = data?.error?.code || data?.code || null;
    throw error;
  }
  return data;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Método não permitido." });

  try {
    const response = await request("/wallets");
    const wallets = Array.isArray(response?.data) ? response.data : [];
    return res.status(200).json({ success: true, wallets });
  } catch (error) {
    console.error("[PayGo → ZumboPay] wallets error", error);
    return res.status(error?.status || 500).json({ success: false, error: error?.message || "Não foi possível consultar as wallets ZumboPay.", code: error?.code || null });
  }
}
