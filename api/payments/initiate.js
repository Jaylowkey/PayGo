import {
  createCharge,
  createPayment,
  normalizePhone,
  normalizePaymentMethod,
} from "../lib/services/zumbopay.js";

import {
  getApps,
  initializeApp,
  cert,
} from "firebase-admin/app";

import {
  getFirestore,
  FieldValue,
} from "firebase-admin/firestore";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json");
}

function json(res, status, data) {
  return res.status(status).json(data);
}

function getFirebaseDb() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT em falta.");

    const serviceAccount = JSON.parse(raw);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    }

    initializeApp({ credential: cert(serviceAccount) });
  }

  const app = getApps()[0];
  try {
    return getFirestore(app, "paygodb");
  } catch {
    return getFirestore(app);
  }
}

function getUserId(body) {
  return (
    body.userId ||
    body.user_id ||
    body.uid ||
    body.customerId ||
    body.customer_id ||
    null
  );
}

function getCustomerName(body) {
  return (
    body.customerName ||
    body.customer_name ||
    body.name ||
    "Cliente PayGo"
  );
}

async function getExistingTopUp(reference) {
  if (!reference) return null;

  const db = getFirebaseDb();
  const ref = db.collection("topups").doc(String(reference));
  const snap = await ref.get();

  if (!snap.exists) return null;

  return {
    ref,
    data: snap.data() || {},
  };
}

async function createPendingTopUp({ reference, userId, amount, method, phone, customerName }) {
  if (!userId) throw new Error("userId é obrigatório para criar o depósito.");

  const db = getFirebaseDb();
  const ref = db.collection("topups").doc(String(reference));
  const existing = await ref.get();

  if (existing.exists) {
    const existingData = existing.data() || {};

    if (existingData.status === "completed" || existingData.status === "success") {
      throw new Error("Esta referência de depósito já foi concluída.");
    }

    if (
      Number(existingData.amount) !== Number(amount) ||
      String(existingData.userId || "") !== String(userId)
    ) {
      throw new Error("A referência de depósito já existe com dados diferentes.");
    }

    return { ref, data: existingData, reused: true };
  }

  const data = {
    reference: String(reference),
    sourceId: String(reference),
    provider: "zumbopay",
    status: "pending",
    paymentStatus: "pending",
    amount: Number(amount),
    grossAmount: Number(amount),
    walletCreditAmount: Number(amount),
    method,
    paymentMethod: method,
    phone: phone || null,
    customerPhone: phone || null,
    customerName: customerName || "Cliente PayGo",
    userId: String(userId),
    providerPaymentId: null,
    providerReference: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await ref.create(data);
  return { ref, data, reused: false };
}

async function updateTopUp(reference, patch) {
  const db = getFirebaseDb();
  const ref = db.collection("topups").doc(String(reference));
  await ref.set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return json(res, 405, { success: false, error: "Método não permitido.", allowed: ["POST"] });
  }

  const body = req.body || {};
  const requestReference = body.reference || body.orderId || null;
  let reference = requestReference || `PAYGO-${Date.now()}`;
  let topupCreated = false;

  try {
    const amount = Number(body.amount);
    const method = normalizePaymentMethod(body.method);
    const phone = body.phone || "";

    // O Dashboard.html já cria o documento topups/{topupId} antes de chamar
    // esta API. Esse documento contém o userId real da sessão Firebase.
    // Assim não precisamos exigir que o frontend envie userId novamente.
    let userId = getUserId(body);
    let customerName = getCustomerName(body);
    let existingTopUp = null;

    if (!userId && reference) {
      existingTopUp = await getExistingTopUp(reference);

      if (existingTopUp?.data?.userId) {
        userId = String(existingTopUp.data.userId);
        customerName =
          existingTopUp.data.customerName ||
          existingTopUp.data.userName ||
          customerName;

        console.log("[PayGo → ZumboPay] userId recuperado do TopUp", {
          reference,
          userId,
        });
      }
    }

    console.log("[PayGo → ZumboPay] initiate", {
      amount,
      method,
      phone: phone ? "***" : null,
      reference,
      userId: userId ? String(userId) : null,
      customerName,
      existingTopUp: Boolean(existingTopUp),
    });

    if (!Number.isFinite(amount) || amount <= 0) {
      return json(res, 400, { success: false, error: "O valor do pagamento é inválido." });
    }

    if (amount < 10) {
      return json(res, 400, { success: false, error: "O depósito mínimo é de 10 MT." });
    }

    if (!userId) {
      return json(res, 400, {
        success: false,
        error: "Sessão do cliente não identificada. O depósito TopUp não contém userId.",
        reference,
      });
    }

    if (method === "mpesa" || method === "emola" || method === "mkesh") {
      if (!phone) return json(res, 400, { success: false, error: "O número de telefone é obrigatório." });

      let normalizedPhone;
      try {
        normalizedPhone = normalizePhone(phone);
      } catch (error) {
        return json(res, 400, { success: false, error: error?.message || "Número de telefone inválido." });
      }

      const msisdn = normalizedPhone.replace(/^\+/, "");

      if (method === "mpesa" && !/^2588[45]\d{7}$/.test(msisdn)) {
        return json(res, 400, { success: false, error: "Para M-Pesa utilize um número 84 ou 85." });
      }

      if (method === "emola" && !/^2588[67]\d{7}$/.test(msisdn)) {
        return json(res, 400, { success: false, error: "Para e-Mola utilize um número 86 ou 87." });
      }

      if (method === "mkesh" && !/^2588[23]\d{7}$/.test(msisdn)) {
        return json(res, 400, { success: false, error: "Para mKesh utilize um número 82 ou 83." });
      }

      const topup = await createPendingTopUp({
        reference,
        userId,
        amount,
        method,
        phone: normalizedPhone,
        customerName,
      });

      topupCreated = !topup.reused;

      const charge = await createCharge({
        amount,
        phone: normalizedPhone,
        customerName,
        sourceId: String(reference),
        method,
      });

      if (!charge || charge.success !== true) {
        await updateTopUp(reference, {
          status: "failed",
          paymentStatus: "failed",
          failureReason: "A ZumboPay não conseguiu iniciar o pagamento.",
          providerResponse: charge || null,
        });

        return json(res, 400, {
          success: false,
          provider: "zumbopay",
          error: "A ZumboPay não conseguiu iniciar o pagamento.",
          reference,
          data: charge || null,
        });
      }

      await updateTopUp(reference, {
        providerPaymentId: charge.paymentId || null,
        providerReference: charge.reference || null,
        providerStatus: charge.status || "pending",
        paymentStatus: charge.status || "pending",
        status: charge.status === "success" ? "completed" : "pending",
        providerResponse: charge.raw || null,
      });

      return json(res, 200, {
        success: true,
        provider: "zumbopay",
        type: "stk_push",
        method,
        amount,
        phone: normalizedPhone,
        reference: charge.reference || reference,
        paymentId: charge.paymentId || null,
        status: charge.status || "pending",
        message:
          charge.status === "success"
            ? "Pagamento recebido. A confirmação final será processada automaticamente."
            : "Pedido enviado. Confirme o pagamento no seu telemóvel usando o PIN.",
        data: {
          reference: charge.reference || reference,
          sourceId: reference,
          paymentId: charge.paymentId || null,
          status: charge.status || "pending",
          method,
          amount,
          phone: normalizedPhone,
        },
      });
    }

    if (method === "card") {
      const topup = await createPendingTopUp({
        reference,
        userId,
        amount,
        method,
        phone: phone || null,
        customerName,
      });

      topupCreated = !topup.reused;

      const payment = await createPayment({
        amount,
        reference,
        title: `Depósito PayGo ${reference}`,
        description: `Depósito PayGo ${reference}`,
        method: "card",
        walletId: process.env.ZUMBOPAY_WALLET_CARD || undefined,
        maxUses: 1,
      });

      if (!payment || payment.success !== true) {
        await updateTopUp(reference, {
          status: "failed",
          paymentStatus: "failed",
          failureReason: "Não foi possível criar o checkout da ZumboPay.",
          providerResponse: payment || null,
        });

        return json(res, 400, {
          success: false,
          provider: "zumbopay",
          error: "Não foi possível criar o checkout da ZumboPay.",
          reference,
          data: payment || null,
        });
      }

      await updateTopUp(reference, {
        providerPaymentId: payment.paymentId || null,
        providerReference: payment.reference || null,
        providerStatus: payment.status || "pending",
        paymentStatus: payment.status || "pending",
        providerResponse: payment.raw || null,
      });

      return json(res, 200, {
        success: true,
        provider: "zumbopay",
        type: "checkout",
        method: "card",
        amount,
        reference: payment.reference || reference,
        paymentId: payment.paymentId || null,
        status: payment.status || "pending",
        checkoutUrl: payment.checkoutUrl,
        message: "Checkout da ZumboPay criado com sucesso.",
      });
    }

    return json(res, 400, {
      success: false,
      error: "Método de pagamento não suportado.",
      supportedMethods: ["mpesa", "emola", "mkesh", "card"],
    });
  } catch (error) {
    console.error("[PayGo → ZumboPay] erro", error);

    if (topupCreated && reference) {
      try {
        await updateTopUp(reference, {
          status: "failed",
          paymentStatus: "failed",
          failureReason: error?.message || "Erro ao iniciar pagamento.",
        });
      } catch (updateError) {
        console.error("[PayGo] Falha ao atualizar TopUp após erro:", updateError?.message);
      }
    }

    return json(res, 500, {
      success: false,
      provider: "zumbopay",
      error: error?.message || "Erro interno ao processar pagamento.",
      code: error?.code || null,
      reference,
      ...(process.env.NODE_ENV !== "production" ? { details: error?.data || null } : {}),
    });
  }
}
