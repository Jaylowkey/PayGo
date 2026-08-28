import crypto from "crypto";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const BASE_URL = (process.env.NETSHOP_API_URL || "https://www.netshop.co.mz/api/v1").replace(/\/+$/, "");

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

function money(value) {
  const n = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}

function normalizeMethod(value = "") {
  const v = String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (v === "mpesa") return "mpesa";
  if (v === "emola") return "emola";
  if (v === "mkesh") return "mkesh";
  if (["visa", "mastercard", "card"].includes(v)) return "card";
  return v;
}

function walletForMethod(method) {
  const m = normalizeMethod(method);
  return process.env[`NETSHOP_WALLET_${m.toUpperCase()}`] || process.env.NETSHOP_WALLET_ID || "";
}

function verifySignature(raw, header) {
  const secret = process.env.NETSHOP_WEBHOOK_SECRET;
  if (!secret) return null;
  if (!header) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const provided = String(header).replace(/^sha256=/i, "");
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

function getPayload(event) {
  const data = event?.data || event?.payload || {};
  // NetShop events can arrive as data directly or in a Stripe-style data.object shape.
  return data?.object || data?.charge || data?.payment || data || event || {};
}

function getReference(payload, event) {
  return String(
    payload.reference || payload.merchant_reference || payload.merchantReference ||
    payload.order_reference || payload.orderReference ||
    event.reference || event.merchant_reference || event.merchantReference || ""
  ).trim();
}

function getProviderId(payload, event) {
  return String(
    payload.id || payload.charge_id || payload.chargeId || payload.payment_id || payload.paymentId ||
    payload.transaction_id || payload.transactionId || payload.provider_reference || payload.providerReference ||
    event.charge_id || event.payment_id || event.transaction_id || ""
  ).trim();
}

function eventState(eventType, payload) {
  const status = String(payload.status || payload.payment_status || payload.paymentStatus || "").toLowerCase();
  const type = String(eventType || "").toLowerCase();
  if (type === "charge.paid" || type === "payment.paid") return "paid";
  if (type === "charge.failed" || type === "payment.failed") return "failed";
  if (type === "charge.pending" || type === "payment.pending") return "pending";
  if (["paid", "successful", "success", "completed", "complete", "confirmed"].includes(status)) return "paid";
  if (["failed", "failure", "cancelled", "canceled", "expired", "declined"].includes(status)) return "failed";
  return "pending";
}

async function fetchCharge(id, method) {
  const apiKey = process.env.NETSHOP_API_KEY;
  const walletId = walletForMethod(method);
  if (!apiKey || !walletId) throw new Error("NETSHOP_API_KEY ou wallet NetShop em falta.");
  const response = await fetch(`${BASE_URL}/charges/${encodeURIComponent(id)}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Wallet-ID": String(walletId),
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`Resposta inválida da NetShop (${response.status}).`); }
  if (!response.ok) throw new Error(body?.error?.message || body?.message || `NetShop HTTP ${response.status}`);
  return body?.data || body;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Método não permitido." });

  const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  let event;
  try { event = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ success: false, error: "JSON inválido." }); }

  const signature = req.headers["x-netshop-signature"] || req.headers["X-NetShop-Signature"] || "";
  const signatureValid = verifySignature(raw, String(signature));
  if (signatureValid === false) return res.status(401).json({ success: false, error: "Invalid webhook signature" });

  const firestore = db();
  const receivedAt = new Date().toISOString();
  const eventType = String(event.event || event.type || event.event_type || "unknown");
  const payload = getPayload(event);
  const reference = getReference(payload, event);
  const providerId = getProviderId(payload, event);
  const method = normalizeMethod(payload.method || payload.payment_method || payload.paymentMethod || "mpesa");
  const state = eventState(eventType, payload);

  const logRef = firestore.collection("webhook_logs").doc();
  await logRef.set({
    source: "netshop",
    event: eventType,
    reference: reference || null,
    providerId: providerId || null,
    signaturePresent: Boolean(signature),
    signatureVerified: signatureValid === true,
    status: "received",
    rawPayload: event,
    receivedAt,
    createdAt: receivedAt,
  });

  if (!reference) {
    await logRef.update({ status: "ignored_missing_reference", updatedAt: receivedAt });
    return res.status(200).json({ success: true, ignored: true, reason: "missing_reference" });
  }

  // Topups are created with the PayGo reference as document ID.
  let topupRef = firestore.collection("topups").doc(reference);
  let topupSnap = await topupRef.get();
  if (!topupSnap.exists) {
    const q = await firestore.collection("topups").where("reference", "==", reference).limit(1).get();
    if (!q.empty) {
      topupRef = q.docs[0].ref;
      topupSnap = q.docs[0];
    } else {
      const q2 = await firestore.collection("topups").where("topupId", "==", reference).limit(1).get();
      if (!q2.empty) {
        topupRef = q2.docs[0].ref;
        topupSnap = q2.docs[0];
      }
    }
  }

  if (!topupSnap.exists) {
    await logRef.update({ status: "ignored_topup_not_found", updatedAt: receivedAt });
    return res.status(200).json({ success: true, ignored: true, reason: "topup_not_found", reference });
  }

  const topup = topupSnap.data() || {};
  const userId = String(topup.userId || topup.uid || "");
  if (!userId) {
    await logRef.update({ status: "invalid_topup_missing_user", updatedAt: receivedAt });
    return res.status(422).json({ success: false, error: "Topup sem userId.", reference });
  }

  // The webhook is the trigger; when a provider ID is available we always reconcile
  // against NetShop before changing the PayGo wallet.
  let verifiedCharge = payload;
  if (providerId) {
    try {
      verifiedCharge = await fetchCharge(providerId, normalizeMethod(topup.paymentMethod || topup.method || method));
    } catch (error) {
      await logRef.update({ status: "reconciliation_pending", reconciliationError: error.message, updatedAt: new Date().toISOString() });
      return res.status(202).json({ success: true, accepted: true, reconciliation: "pending", reference, providerId });
    }
  }

  const verifiedStatus = eventState(eventType, verifiedCharge);
  const expectedAmount = money(topup.amount || topup.grossAmount);
  const providerAmount = money(verifiedCharge.amount ?? payload.amount);

  if (providerAmount > 0 && expectedAmount > 0 && Math.abs(providerAmount - expectedAmount) > 0.01) {
    await logRef.update({ status: "amount_mismatch", expectedAmount, providerAmount, updatedAt: new Date().toISOString() });
    return res.status(422).json({ success: false, error: "Valor do pagamento não corresponde ao depósito PayGo.", reference });
  }

  if (verifiedStatus === "pending") {
    await topupRef.set({
      provider: "netshop",
      providerPaymentId: providerId || topup.providerPaymentId || null,
      providerReference: reference,
      providerStatus: String(verifiedCharge.status || "pending"),
      paymentStatus: "pending",
      status: "pending",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await logRef.update({ status: "pending", providerStatus: String(verifiedCharge.status || "pending"), updatedAt: receivedAt });
    return res.status(200).json({ success: true, operation: "pending", reference, providerId });
  }

  if (verifiedStatus === "failed") {
    await topupRef.set({
      provider: "netshop",
      providerPaymentId: providerId || null,
      providerReference: reference,
      providerStatus: String(verifiedCharge.status || "failed"),
      paymentStatus: "failed",
      status: "failed",
      failureReason: verifiedCharge.error_message || verifiedCharge.message || payload.error_message || null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await logRef.update({ status: "failed_recorded", updatedAt: receivedAt });
    return res.status(200).json({ success: true, operation: "failed_recorded", reference, providerId });
  }

  if (!expectedAmount && !providerAmount) {
    await logRef.update({ status: "paid_but_missing_amount", updatedAt: receivedAt });
    return res.status(422).json({ success: false, error: "Pagamento confirmado mas sem valor válido.", reference });
  }

  const creditAmount = expectedAmount || providerAmount;
  const userRef = firestore.collection("users").doc(userId);
  const txId = `netshop_${String(providerId || reference).replace(/[^a-zA-Z0-9_-]/g, "_")}_${String(reference).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const txRef = firestore.collection("wallet_transactions").doc(txId);
  let credited = false;
  let duplicate = false;

  await firestore.runTransaction(async transaction => {
    const freshTopup = await transaction.get(topupRef);
    const fresh = freshTopup.exists ? freshTopup.data() || {} : {};
    if (fresh.walletCredited === true || fresh.status === "completed") {
      duplicate = true;
      return;
    }

    transaction.set(topupRef, {
      provider: "netshop",
      providerPaymentId: providerId || fresh.providerPaymentId || null,
      providerReference: reference,
      providerStatus: String(verifiedCharge.status || "paid"),
      paymentStatus: "paid",
      status: "completed",
      isPaid: true,
      walletCredited: true,
      walletCreditAmount: creditAmount,
      grossPaidAmount: creditAmount,
      gatewayFeeAmount: 0,
      gatewayFeePercent: 0,
      creditMode: "gross_no_netshop_deduction",
      paidAt: receivedAt,
      completedAt: receivedAt,
      updatedAt: receivedAt,
    }, { merge: true });

    transaction.update(userRef, { walletBalance: FieldValue.increment(creditAmount) });
    transaction.set(txRef, {
      userId,
      type: "credit",
      amount: creditAmount,
      grossAmount: creditAmount,
      gatewayFeeAmount: 0,
      provider: "netshop",
      paymentMethod: normalizeMethod(topup.paymentMethod || topup.method || method),
      reference,
      paymentId: providerId || null,
      description: `Depósito NetShop confirmado (${creditAmount.toFixed(2)} MT)`,
      rawPayload: verifiedCharge,
      createdAt: receivedAt,
    });
    credited = true;
  });

  await logRef.update({
    status: duplicate ? "ignored_duplicate_success" : "success_wallet_funded",
    providerStatus: String(verifiedCharge.status || "paid"),
    walletCreditAmount: creditAmount,
    updatedAt: new Date().toISOString(),
  });

  return res.status(200).json({
    success: true,
    operation: duplicate ? "ignored_duplicate" : "wallet_credited",
    reference,
    providerId,
    amount: creditAmount,
  });
}
