import crypto from "crypto";

const BASE_URL = (process.env.ZUMBOPAY_API_URL || "https://zumbopay.com/api/public/v1").replace(/\/+$/, "");

function config() {
  const apiKey = process.env.ZUMBOPAY_API_KEY || "";
  const merchantId = process.env.ZUMBOPAY_MERCHANT_ID || "";
  if (!apiKey || !merchantId) throw new Error("Credenciais ZumboPay não configuradas.");
  return { apiKey, merchantId };
}

function normalizePhone(value) {
  let phone = String(value || "").replace(/\s+/g, "").replace(/[^\d+]/g, "");
  if (phone.startsWith("+")) phone = phone.slice(1);
  if (!phone.startsWith("258")) phone = `258${phone}`;
  return phone;
}

async function request(body, idempotencyKey) {
  const { apiKey, merchantId } = config();
  const response = await fetch(`${BASE_URL}/payouts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Merchant-Id": merchantId,
      "Idempotency-Key": idempotencyKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Resposta inválida da ZumboPay (${response.status}).`); }
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || `ZumboPay HTTP ${response.status}`);
    error.status = response.status;
    error.code = data?.error?.code || data?.code || null;
    error.data = data;
    throw error;
  }
  return data;
}

function isAdmin(req) {
  // Proteção mínima server-side. Em produção, configure PAYGO_ADMIN_API_KEY
  // e faça o painel enviar Authorization: Bearer <essa chave>.
  const expected = process.env.PAYGO_ADMIN_API_KEY || "";
  if (!expected) return false;
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) return false;
  const received = auth.slice(7).trim();
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Método não permitido." });
  if (!isAdmin(req)) return res.status(403).json({ success: false, error: "Acesso administrativo necessário." });

  try {
    const body = req.body || {};
    const amount = Number(body.amount);
    const method = String(body.method || "").toLowerCase().trim();
    const destination = normalizePhone(body.destination || body.phone);
    const walletId = body.walletId || body.wallet_id;
    const autoDispatch = body.autoDispatch === true || body.auto_dispatch === true;

    if (!walletId) return res.status(400).json({ success: false, error: "walletId é obrigatório." });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, error: "Valor do payout inválido." });
    if (!["mpesa", "emola", "mkesh", "card"].includes(method)) return res.status(400).json({ success: false, error: "Método de payout inválido." });
    if (!destination || !/^258\d{9}$/.test(destination)) return res.status(400).json({ success: false, error: "Número de destino inválido." });
    if (autoDispatch && method !== "mpesa") return res.status(400).json({ success: false, error: "autoDispatch só pode ser usado com M-Pesa." });

    const idempotencyKey = String(body.idempotencyKey || `paygo-payout-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`);
    const payload = {
      wallet_id: walletId,
      amount,
      method,
      destination,
      ...(body.notes ? { notes: String(body.notes).slice(0, 500) } : {}),
      ...(autoDispatch ? { auto_dispatch: true } : {}),
    };

    const response = await request(payload, idempotencyKey);
    const data = response?.data || {};

    return res.status(200).json({
      success: true,
      payout: {
        id: data.id || null,
        reference: data.reference || null,
        providerReference: data.provider_reference || null,
        amount: Number(data.amount ?? amount),
        feeAmount: Number(data.fee_amount ?? 0),
        netAmount: Number(data.net_amount ?? 0),
        currency: data.currency || "MZN",
        method: data.method || method,
        destination: data.destination || destination,
        status: data.status || "pending",
        autoDispatched: Boolean(data.auto_dispatched),
      },
      raw: response,
    });
  } catch (error) {
    console.error("[PayGo → ZumboPay] payout error", error);
    return res.status(error?.status || 500).json({ success: false, error: error?.message || "Não foi possível criar o payout.", code: error?.code || null, details: process.env.NODE_ENV === "production" ? undefined : error?.data || null });
  }
}
