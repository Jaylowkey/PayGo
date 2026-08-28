import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { createCharge } from "../../lib/payments/index.js";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json");
}

function json(res, status, data) {
  return res.status(status).json(data);
}

function db() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT em falta.");
    const account = JSON.parse(raw);
    if (account.private_key) account.private_key = account.private_key.replace(/\\n/g, "\n");
    initializeApp({ credential: cert(account) });
  }
  const app = getApps()[0];
  try { return getFirestore(app, "paygodb"); } catch { return getFirestore(app); }
}

function method(value) {
  const v = String(value || "").toLowerCase().trim();
  if (["m-pesa", "m_pesa"].includes(v)) return "mpesa";
  if (["e-mola", "e_mola"].includes(v)) return "emola";
  if (["m-kesh", "m_kesh", "m kesh"].includes(v)) return "mkesh";
  if (["visa", "mastercard", "cartao", "cartão"].includes(v)) return "card";
  return v;
}

function userId(body) {
  return body.userId || body.user_id || body.uid || body.customerId || body.customer_id || null;
}

function customerName(body) {
  return body.customerName || body.customer_name || body.name || "Cliente PayGo";
}

async function findTopUp(reference) {
  const snap = await db().collection("topups").doc(String(reference)).get();
  return snap.exists ? snap.data() || {} : null;
}

async function ensureTopUp({ reference, uid, amount, paymentMethod, phone, name }) {
  const ref = db().collection("topups").doc(String(reference));
  const existing = await ref.get();
  if (existing.exists) {
    const data = existing.data() || {};
    if (["completed", "success"].includes(data.status)) throw new Error("Esta referência de depósito já foi concluída.");
    if (Number(data.amount) !== Number(amount) || String(data.userId || "") !== String(uid)) {
      throw new Error("A referência de depósito já existe com dados diferentes.");
    }
    return { ref, created: false };
  }

  await ref.create({
    reference: String(reference),
    sourceId: String(reference),
    provider: "paygo-payment-core",
    status: "pending",
    paymentStatus: "pending",
    amount: Number(amount),
    grossAmount: Number(amount),
    walletCreditAmount: Number(amount),
    method: paymentMethod,
    paymentMethod,
    phone: phone || null,
    customerPhone: phone || null,
    customerName: name,
    userId: String(uid),
    providerPaymentId: null,
    providerReference: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ref, created: true };
}

async function patchTopUp(reference, patch) {
  await db().collection("topups").doc(String(reference)).set({
    ...patch,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { success: false, error: "Método não permitido.", allowed: ["POST"] });

  const body = req.body || {};
  const amount = Number(body.amount);
  const paymentMethod = method(body.method);
  const phone = body.phone || "";
  const reference = String(body.reference || body.orderId || `PAYGO-${Date.now()}`);
  let uid = userId(body);
  let name = customerName(body);
  let created = false;

  try {
    if (!Number.isFinite(amount) || amount <= 0) return json(res, 400, { success: false, error: "O valor do pagamento é inválido." });
    if (amount < 10) return json(res, 400, { success: false, error: "O depósito mínimo é de 10 MT." });

    if (!uid) {
      const existing = await findTopUp(reference);
      if (existing?.userId) {
        uid = String(existing.userId);
        name = existing.customerName || existing.userName || name;
      }
    }
    if (!uid) return json(res, 400, { success: false, error: "Sessão do cliente não identificada.", reference });

    if (!["mpesa", "emola", "mkesh", "card"].includes(paymentMethod)) {
      return json(res, 400, { success: false, error: "Método de pagamento não suportado.", supportedMethods: ["mpesa", "emola", "mkesh", "card"] });
    }

    if (["mpesa", "emola", "mkesh"].includes(paymentMethod) && !phone) {
      return json(res, 400, { success: false, error: "O número de telefone é obrigatório." });
    }

    const topup = await ensureTopUp({ reference, uid, amount, paymentMethod, phone, name });
    created = topup.created;

    const charge = await createCharge({
      amount,
      method: paymentMethod,
      phone: phone || undefined,
      reference,
      sourceId: reference,
      customerName: name,
    });

    await patchTopUp(reference, {
      provider: charge.provider,
      providerPriority: charge.providerPriority || null,
      providerPaymentId: charge.paymentId || null,
      providerReference: charge.reference || reference,
      providerStatus: charge.status || "pending",
      paymentStatus: charge.status || "pending",
      status: charge.status === "success" ? "completed" : "pending",
      providerAttempts: charge.attempts || [],
      providerResponse: charge.raw || null,
    });

    const raw = charge.raw || {};
    const rawData = raw?.data || {};
    const checkoutUrl = rawData.checkout_url || rawData.checkoutUrl || raw.checkout_url || raw.checkoutUrl || null;

    return json(res, 200, {
      success: true,
      provider: charge.provider,
      providerPriority: charge.providerPriority || null,
      type: paymentMethod === "card" ? "checkout" : "stk_push",
      method: paymentMethod,
      amount,
      phone: phone || null,
      reference: charge.reference || reference,
      paymentId: charge.paymentId || null,
      status: charge.status || "pending",
      checkoutUrl,
      message: paymentMethod === "card"
        ? "Checkout criado com sucesso."
        : "Pedido enviado. Confirme o pagamento no seu telemóvel usando o PIN.",
    });
  } catch (error) {
    console.error("[PayGo Payment Core]", error);
    if (created) {
      try {
        await patchTopUp(reference, {
          status: "failed",
          paymentStatus: "failed",
          failureReason: error?.message || "Erro ao iniciar pagamento.",
          providerAttempts: error?.paymentAttempts || [],
        });
      } catch (updateError) {
        console.error("[PayGo Payment Core] topup update failed", updateError?.message);
      }
    }

    return json(res, error?.status >= 400 && error.status < 500 ? error.status : 500, {
      success: false,
      error: error?.message || "Erro interno ao processar pagamento.",
      code: error?.code || null,
      provider: error?.provider || null,
      reference,
      attempts: error?.paymentAttempts || [],
    });
  }
}
