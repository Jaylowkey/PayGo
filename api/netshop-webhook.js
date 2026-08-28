import crypto from "crypto";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { Resend } from "resend";

const NETSHOP_BASE_URL = (process.env.NETSHOP_API_URL || "https://www.netshop.co.mz/api/v1").replace(/\/+$/, "");
const SITE_URL = (process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "https://paygo.co.mz").replace(/\/+$/, "");
const FROM_EMAIL = process.env.FROM_EMAIL || "PayGo Moçambique <noreply@paygo.co.mz>";
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

function getDb() {
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

function walletForMethod(method = "") {
  const clean = String(method).toLowerCase().trim();
  if (clean === "mpesa") return process.env.NETSHOP_WALLET_MPESA || "";
  if (clean === "emola") return process.env.NETSHOP_WALLET_EMOLA || "";
  if (clean === "mkesh") return process.env.NETSHOP_WALLET_MKESH || "";
  return process.env.NETSHOP_WALLET_CARD || "";
}

function normalizeMethod(value = "") {
  const clean = String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (clean === "mpesa") return "mpesa";
  if (clean === "emola") return "emola";
  if (clean === "mkesh") return "mkesh";
  if (["visa", "mastercard", "card"].includes(clean)) return "card";
  return clean;
}

function money(value) {
  const n = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}

function rawBody(req) {
  if (typeof req.body === "string") return req.body;
  return JSON.stringify(req.body || {});
}

function verifyOptionalSignature(body, signature) {
  const secret = process.env.NETSHOP_WEBHOOK_SECRET;
  if (!secret) return null;
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const provided = String(signature).replace(/^sha256=/, "");
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

async function netshopCharge(id, method) {
  const apiKey = process.env.NETSHOP_API_KEY;
  const walletId = walletForMethod(method);
  if (!apiKey || !walletId) throw new Error("Credenciais NetShop ou Wallet ID em falta.");

  const response = await fetch(`${NETSHOP_BASE_URL}/charges/${encodeURIComponent(id)}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Wallet-ID": String(walletId),
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30000),
  });

  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Resposta inválida do NetShop (${response.status}).`); }
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || `NetShop HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data?.data || data;
}

function isPaid(status) {
  return ["paid", "successful", "success", "completed", "complete", "confirmed"].includes(String(status || "").toLowerCase());
}

function isFailed(status) {
  return ["failed", "failure", "cancelled", "canceled", "expired", "declined"].includes(String(status || "").toLowerCase());
}

function isPending(status) {
  return ["pending", "processing", "created", "initiated", "awaiting_confirmation"].includes(String(status || "").toLowerCase());
}

function emailHtml({ name, amount, reference, providerId }) {
  return `<!doctype html><html lang="pt"><body style="margin:0;background:#f4f7fb;font-family:Arial,sans-serif;color:#0f172a"><div style="max-width:620px;margin:30px auto;background:#fff;border-radius:20px;overflow:hidden;border:1px solid #e2e8f0"><div style="background:linear-gradient(135deg,#0b1b36,#123b68);padding:28px;color:#fff"><strong style="font-size:24px">PayGo</strong><div style="font-size:12px;opacity:.8;margin-top:5px">Pagamento confirmado</div></div><div style="padding:30px"><h1 style="margin:0 0 12px">Pagamento confirmado ✅</h1><p>Olá ${String(name || "Cliente").replace(/[<>]/g, "")},</p><p>Confirmámos o seu depósito na PayGo.</p><div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:16px;padding:20px;margin:22px 0"><div style="font-size:12px;color:#64748b">VALOR CREDITADO</div><div style="font-size:30px;font-weight:800;color:#059669;margin:5px 0">${amount.toFixed(2)} MT</div><div style="font-size:13px;color:#475569">Referência PayGo: <strong>${reference}</strong></div><div style="font-size:13px;color:#475569;margin-top:5px">Referência NetShop: <strong>${providerId || "N/A"}</strong></div></div><p>O valor já foi creditado na sua carteira PayGo.</p><p style="font-size:13px;color:#64748b">Pode consultar o novo saldo no seu dashboard.</p><a href="${SITE_URL}/dashboard.html" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:13px 22px;border-radius:12px;font-weight:700">Abrir PayGo</a></div><div style="padding:20px;text-align:center;background:#f8fafc;color:#64748b;font-size:12px">PayGo Moçambique 🇲🇿</div></div></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Método não permitido." });

  const raw = rawBody(req);
  let event;
  try { event = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ success: false, error: "JSON inválido." }); }

  const signature = req.headers["x-netshop-signature"] || req.headers["X-NetShop-Signature"] || "";
  const signatureValid = verifyOptionalSignature(raw, String(signature));
  if (signatureValid === false) return res.status(401).json({ success: false, error: "Invalid webhook signature" });

  const db = getDb();
  const receivedAt = new Date().toISOString();
  const eventType = event.event || event.type || event.event_type || "unknown";
  const data = event.data || event.payload || event;
  const reference = String(data.reference || data.merchant_reference || data.merchantReference || event.reference || "").trim();
  const providerId = String(data.id || data.charge_id || data.chargeId || data.payment_id || data.paymentId || data.transaction_id || data.transactionId || data.provider_reference || data.providerReference || "").trim();
  const method = normalizeMethod(data.method || data.payment_method || data.paymentMethod || "mpesa");

  const logRef = db.collection("webhook_logs").doc();
  await logRef.set({ source: "netshop", event: eventType, reference: reference || null, providerId: providerId || null, signaturePresent: Boolean(signature), signatureVerified: signatureValid === true, status: "received", rawPayload: event, receivedAt, createdAt: receivedAt });

  if (!reference) return res.status(200).json({ success: true, ignored: true, reason: "missing_reference" });

  // The payment flow creates topups using the reference as the document ID.
  // Older records may use topupId instead, so support both forms.
  let topupRef = db.collection("topups").doc(reference);
  let topupSnap = await topupRef.get();
  if (!topupSnap.exists) {
    const query = await db.collection("topups").where("topupId", "==", reference).limit(1).get();
    if (query.empty) {
      const normalized = reference.startsWith("TOP") && !reference.startsWith("TOP-") ? reference.replace(/^TOP/, "TOP-") : reference;
      const query2 = await db.collection("topups").where("topupId", "==", normalized).limit(1).get();
      if (query2.empty) return res.status(200).json({ success: true, ignored: true, reason: "topup_not_found", reference });
      topupRef = query2.docs[0].ref;
      topupSnap = query2.docs[0];
    } else {
      topupRef = query.docs[0].ref;
      topupSnap = query.docs[0];
    }
  }

  const topup = topupSnap.data() || {};
  const userId = String(topup.userId || "");
  if (!userId) return res.status(422).json({ success: false, error: "Topup sem userId." });

  let providerCharge = data;
  // NetShop does not expose a merchant webhook secret in the current merchant setup.
  // Therefore the webhook is only a trigger; a successful credit is allowed only after
  // server-to-server reconciliation against GET /charges/{id} using our API credentials.
  if (providerId) {
    try {
      providerCharge = await netshopCharge(providerId, method);
    } catch (error) {
      await logRef.update({ status: "reconciliation_failed", reconciliationError: error.message, updatedAt: new Date().toISOString() });
      return res.status(202).json({ success: true, accepted: true, reconciliation: "pending", reference, providerId });
    }
  }

  const providerStatus = String(providerCharge.status || data.status || event.status || "").toLowerCase();
  const paid = isPaid(providerStatus);
  const failed = isFailed(providerStatus);
  const pending = isPending(providerStatus) || (!paid && !failed);
  const expectedAmount = money(topup.amount);
  const providerAmount = money(providerCharge.amount ?? data.amount);

  if (providerAmount > 0 && expectedAmount > 0 && Math.abs(providerAmount - expectedAmount) > 0.01) {
    await logRef.update({ status: "amount_mismatch", expectedAmount, providerAmount, updatedAt: new Date().toISOString() });
    return res.status(422).json({ success: false, error: "Valor do pagamento não corresponde ao depósito PayGo." });
  }

  if (pending) {
    await topupRef.set({ provider: "netshop", providerPaymentId: providerId || topup.providerPaymentId || null, providerReference: reference, providerStatus, paymentStatus: "pending", status: "pending", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await logRef.update({ status: "pending", providerStatus, updatedAt: new Date().toISOString() });
    return res.status(200).json({ success: true, operation: "pending", reference, providerId, status: providerStatus });
  }

  if (failed) {
    if (topup.walletCredited === true || topup.status === "completed") {
      await logRef.update({ status: "ignored_failed_after_success", providerStatus, updatedAt: new Date().toISOString() });
      return res.status(200).json({ success: true, ignored: true, reason: "already_credited" });
    }
    await topupRef.set({ provider: "netshop", providerPaymentId: providerId || null, providerReference: reference, providerStatus, paymentStatus: "failed", status: "failed", failureReason: providerCharge.error_message || providerCharge.message || data.error_message || null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await logRef.update({ status: "failed_recorded", providerStatus, updatedAt: new Date().toISOString() });
    return res.status(200).json({ success: true, operation: "failed_recorded", reference, providerId });
  }

  let credited = false;
  let alreadyCredited = false;
  const creditAmount = expectedAmount || providerAmount;
  const txId = `netshop_${String(providerId || reference).replace(/[^a-zA-Z0-9_-]/g, "_")}_${String(reference).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const txRef = db.collection("wallet_transactions").doc(txId);
  const userRef = db.collection("users").doc(userId);

  await db.runTransaction(async (transaction) => {
    const freshSnap = await transaction.get(topupRef);
    const fresh = freshSnap.exists ? (freshSnap.data() || {}) : {};
    if (fresh.walletCredited === true || fresh.status === "completed") {
      alreadyCredited = true;
      return;
    }

    transaction.set(topupRef, {
      provider: "netshop",
      providerPaymentId: providerId || fresh.providerPaymentId || null,
      providerReference: reference,
      providerStatus,
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
      paymentMethod: method,
      reference,
      paymentId: providerId || null,
      description: `Depósito NetShop confirmado (${creditAmount.toFixed(2)} MT)`,
      rawPayload: providerCharge,
      createdAt: receivedAt,
    }, { merge: false });
    credited = true;
  });

  await logRef.update({ status: alreadyCredited ? "ignored_duplicate_success" : "success_wallet_funded", providerStatus, walletCreditAmount: creditAmount, updatedAt: new Date().toISOString() });

  if (credited && resend) {
    try {
      const userSnap = await userRef.get();
      const user = userSnap.exists ? (userSnap.data() || {}) : {};
      const email = String(user.email || "").trim();
      if (email.includes("@")) {
        await resend.emails.send({ from: FROM_EMAIL, to: [email], subject: `✅ Depósito confirmado — ${creditAmount.toFixed(2)} MT`, html: emailHtml({ name: user.name || user.displayName || "Cliente", amount: creditAmount, reference, providerId }) });
      }
    } catch (error) {
      await db.collection("notification_logs").add({ type: "email", source: "netshop-webhook", status: "failed", reference, error: error.message, createdAt: new Date().toISOString() }).catch(() => {});
    }
  }

  return res.status(200).json({ success: true, operation: alreadyCredited ? "ignored_duplicate" : "wallet_funded", reference, providerId, walletCreditAmount: creditAmount });
}
