import { requireZumboAdmin } from "./login.js";

const BASE_URL = (process.env.ZUMBOPAY_API_URL || "https://zumbopay.com/api/public/v1").replace(/\/+$/, "");

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Método não permitido." });
  if (!(await requireZumboAdmin(req))) return res.status(401).json({ success: false, error: "Acesso administrativo necessário." });

  const apiKey = process.env.ZUMBOPAY_API_KEY;
  const merchantId = process.env.ZUMBOPAY_MERCHANT_ID;
  if (!apiKey || !merchantId) return res.status(500).json({ success: false, error: "Credenciais ZumboPay não configuradas." });

  try {
    const response = await fetch(`${BASE_URL}/wallets`, {
      headers: { Authorization: `Bearer ${apiKey}`, "X-Merchant-Id": merchantId, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {
      console.error("[PayGo Admin → ZumboPay] wallets invalid JSON", { status: response.status, contentType: response.headers.get("content-type"), body: text.slice(0, 500) });
      return res.status(502).json({ success: false, error: `Resposta inválida da ZumboPay (HTTP ${response.status}).` });
    }
    if (!response.ok) return res.status(response.status).json({ success: false, error: data?.error?.message || data?.message || `ZumboPay HTTP ${response.status}`, code: data?.error?.code || data?.code || null });
    return res.status(200).json({ success: true, wallets: Array.isArray(data?.data) ? data.data : [] });
  } catch (error) {
    console.error("[PayGo Admin → ZumboPay] wallets", error);
    return res.status(502).json({ success: false, error: "Não foi possível consultar as wallets ZumboPay." });
  }
}
