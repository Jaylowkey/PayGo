import crypto from "crypto";
import { requireZumboAdmin } from "./login.js";

const BASE_URL = (process.env.ZUMBOPAY_API_URL || "https://zumbopay.com/api/public/v1").replace(/\/+$/, "");

function normalizePhone(value) {
  let phone = String(value || "").replace(/\s+/g, "").replace(/[^\d+]/g, "");
  if (phone.startsWith("+")) phone = phone.slice(1);
  if (!phone.startsWith("258")) phone = `258${phone}`;
  return phone;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Método não permitido." });
  if (!requireZumboAdmin(req)) return res.status(401).json({ success: false, error: "Sessão administrativa necessária." });

  const apiKey = process.env.ZUMBOPAY_API_KEY;
  const merchantId = process.env.ZUMBOPAY_MERCHANT_ID;
  if (!apiKey || !merchantId) return res.status(500).json({ success: false, error: "Credenciais ZumboPay não configuradas." });

  try {
    const body = req.body || {};
    const amount = Number(body.amount);
    const method = String(body.method || "").toLowerCase().trim();
    const walletId = body.walletId || body.wallet_id;
    const destination = normalizePhone(body.destination || body.phone);
    const autoDispatch = body.autoDispatch === true || body.auto_dispatch === true;

    if (!walletId) return res.status(400).json({ success: false, error: "walletId é obrigatório." });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, error: "Valor do payout inválido." });
    if (!["mpesa", "emola", "mkesh", "card"].includes(method)) return res.status(400).json({ success: false, error: "Método de payout inválido." });
    if (!/^258\d{9}$/.test(destination)) return res.status(400).json({ success: false, error: "Número de destino inválido." });
    if (autoDispatch && method !== "mpesa") return res.status(400).json({ success: false, error: "Payout instantâneo só está disponível para M-Pesa." });

    const idempotencyKey = String(body.idempotencyKey || `paygo-admin-payout-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`);
    const payload = {
      wallet_id: walletId,
      amount,
      method,
      destination,
      ...(body.notes ? { notes: String(body.notes).slice(0, 500) } : {}),
      ...(autoDispatch ? { auto_dispatch: true } : {}),
    };

    const response = await fetch(`${BASE_URL}/payouts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Merchant-Id": merchantId,
        "Idempotency-Key": idempotencyKey,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });

    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      console.error("[PayGo Admin → ZumboPay] invalid JSON", {
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: text.slice(0, 500),
      });
      return res.status(502).json({
        success: false,
        error: `Resposta inválida da ZumboPay (HTTP ${response.status}).`,
        contentType: response.headers.get("content-type") || null,
      });
    }

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: data?.error?.message || data?.message || `ZumboPay HTTP ${response.status}`,
        code: data?.error?.code || data?.code || null,
      });
    }

    const payout = data?.data || {};
    return res.status(200).json({
      success: true,
      payout: {
        id: payout.id || null,
        reference: payout.reference || null,
        providerReference: payout.provider_reference || null,
        amount: Number(payout.amount ?? amount),
        feeAmount: Number(payout.fee_amount ?? 0),
        netAmount: Number(payout.net_amount ?? 0),
        currency: payout.currency || "MZN",
        method: payout.method || method,
        destination: payout.destination || destination,
        status: payout.status || "pending",
        autoDispatched: Boolean(payout.auto_dispatched),
      },
    });
  } catch (error) {
    console.error("[PayGo Admin → ZumboPay] payout", error);
    return res.status(502).json({ success: false, error: "Não foi possível criar o payout na ZumboPay." });
  }
}
