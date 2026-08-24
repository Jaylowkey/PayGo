import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WEBHOOK_SECRET = process.env.ZUMBOPAY_WEBHOOK_SECRET || "";

function getDb(): Firestore {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT em falta.");
    const serviceAccount = JSON.parse(raw);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    }
    initializeApp({ credential: cert(serviceAccount) });
  }

  try {
    return getFirestore("paygodb");
  } catch {
    return getFirestore();
  }
}

function verifySignature(rawBody: string, signature: string): boolean {
  if (!WEBHOOK_SECRET || !signature) return false;
  const value = String(signature).replace(/^sha256=/i, "").trim();
  if (!/^[a-f0-9]{64}$/i.test(value)) return false;
  const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(value, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function dataOf(event: any) {
  return event?.data || event?.payment || event?.transaction || event || {};
}

function eventTypeOf(event: any) {
  return String(event?.type || event?.event || event?.event_type || "").trim().toLowerCase();
}

function referenceOf(event: any) {
  const d = dataOf(event);
  return String(d?.reference || event?.reference || "").trim();
}

function sourceIdOf(event: any) {
  const d = dataOf(event);
  return d?.source_id || d?.sourceId || event?.source_id || event?.sourceId || null;
}

function paymentIdOf(event: any) {
  const d = dataOf(event);
  return d?.payment_id || d?.paymentId || d?.id || d?.transaction_id || d?.transactionId || null;
}

function amountOf(event: any) {
  const d = dataOf(event);
  const n = Number(d?.amount ?? d?.gross_amount ?? d?.value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function statusOf(event: any) {
  return String(dataOf(event)?.status || event?.status || "").trim().toLowerCase();
}

function isSuccess(type: string, status: string) {
  return ["payment.succeeded", "payment.success", "payment.completed", "charge.succeeded", "charge.success", "charge.completed"].includes(type) || ["success", "succeeded", "completed", "paid"].includes(status);
}

function isFailed(type: string, status: string) {
  return ["payment.failed", "payment.failure", "payment.cancelled", "payment.canceled", "charge.failed", "charge.cancelled", "charge.canceled"].includes(type) || ["failed", "failure", "cancelled", "canceled"].includes(status);
}

function isRefunded(type: string, status: string) {
  return ["payment.refunded", "payment.refund", "charge.refunded"].includes(type) || ["refunded", "refund"].includes(status);
}

async function recordAttempt(db: Firestore, event: any, extra: Record<string, any> = {}) {
  const reference = referenceOf(event) || "unknown";
  const paymentId = paymentIdOf(event) || "unknown";
  const type = eventTypeOf(event) || "unknown";
  const id = `ZUMBO_${String(paymentId)}_${type}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  await db.collection("payment_attempts").doc(id).set({
    provider: "zumbopay",
    reference,
    sourceId: sourceIdOf(event),
    paymentId: paymentIdOf(event),
    eventType: type,
    status: statusOf(event),
    amount: amountOf(event),
    ...extra,
    rawEvent: event,
    updatedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function findTopup(db: Firestore, reference: string, sourceId: string | null, paymentId: string | null) {
  if (reference) {
    const direct = db.collection("topups").doc(reference);
    const snap = await direct.get();
    if (snap.exists) return { ref: direct, snap };
  }

  const queries = [
    sourceId ? ["reference", sourceId] : null,
    sourceId ? ["sourceId", sourceId] : null,
    reference ? ["providerReference", reference] : null,
    paymentId ? ["providerPaymentId", paymentId] : null,
    paymentId ? ["paymentId", paymentId] : null,
  ].filter(Boolean) as string[][];

  for (const [field, value] of queries) {
    const result = await db.collection("topups").where(field, "==", value).limit(1).get();
    if (!result.empty) return { ref: result.docs[0].ref, snap: result.docs[0] };
  }

  return null;
}

async function notify(db: Firestore, userId: string, reference: string, amount: number, type: string, title: string, message: string) {
  await db.collection("notifications").doc(`ZUMBOPAY_${type}_${reference}`).set({
    userId,
    type,
    title,
    message,
    reference,
    amount,
    currency: "MZN",
    read: false,
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  try {
    const signature = request.headers.get("x-zumbopay-signature") || "";
    if (!verifySignature(rawBody, signature)) {
      console.error("[ZumboPay] Invalid signature");
      return NextResponse.json({ success: false, error: "Invalid webhook signature" }, { status: 401 });
    }

    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 });
    }

    const type = eventTypeOf(event);
    const status = statusOf(event);
    const reference = referenceOf(event);
    const sourceId = sourceIdOf(event);
    const paymentId = paymentIdOf(event);
    const providerAmount = amountOf(event);

    console.log("[ZumboPay] webhook", { type, status, reference, sourceId, paymentId, amount: providerAmount });

    if (!type) return NextResponse.json({ success: true, received: true, ignored: true });

    if (type.startsWith("payout.")) {
      const db = getDb();
      await recordAttempt(db, event, { kind: "payout" });
      return NextResponse.json({ success: true, received: true, handled: "payout" });
    }

    if (!reference) {
      const db = getDb();
      await recordAttempt(db, event, { reason: "missing_reference" });
      return NextResponse.json({ success: true, received: true, ignored: true, reason: "missing_reference" });
    }

    const db = getDb();
    const found = await findTopup(db, reference, sourceId, paymentId);

    if (!found) {
      await recordAttempt(db, event, { reason: "topup_not_found" });
      console.error("[ZumboPay] TopUp not found", { reference, sourceId, paymentId });
      return NextResponse.json({ success: true, received: true, ignored: true, reason: "topup_not_found" });
    }

    const topup = found.snap.data() || {};
    const topupId = found.ref.id;
    const userId = String(topup.userId || "").trim();
    const amount = Number(topup.amount || 0);

    await recordAttempt(db, event, { userId, topupId });

    if (!userId || !Number.isFinite(amount) || amount <= 0) {
      console.error("[ZumboPay] Invalid TopUp", { topupId, userId, amount });
      return NextResponse.json({ success: false, error: "Invalid TopUp" }, { status: 500 });
    }

    if (providerAmount > 0 && Math.abs(providerAmount - amount) > 0.01) {
      await found.ref.update({
        status: "amount_mismatch",
        provider: "zumbopay",
        providerReference: reference,
        providerPaymentId: paymentId || null,
        providerAmount,
        updatedAt: FieldValue.serverTimestamp(),
      });
      await notify(db, userId, reference, providerAmount, "deposit_review", "Pagamento em análise", "Recebemos o pagamento, mas o valor não corresponde ao depósito solicitado.");
      return NextResponse.json({ success: true, received: true, reason: "amount_mismatch" });
    }

    if (isFailed(type, status)) {
      const current = String(topup.status || "pending").toLowerCase();
      if (!["completed", "paid", "refunded"].includes(current)) {
        await found.ref.update({
          status: "failed",
          provider: "zumbopay",
          providerReference: reference,
          providerPaymentId: paymentId || null,
          providerStatus: status,
          updatedAt: FieldValue.serverTimestamp(),
        });
        await notify(db, userId, reference, amount, "deposit_failed", "Pagamento falhou", `O seu depósito de ${amount.toFixed(2)} MT não foi concluído.`);
      }
      return NextResponse.json({ success: true, received: true, status: "failed", reference });
    }

    if (isRefunded(type, status)) {
      const current = String(topup.status || "pending").toLowerCase();
      await found.ref.update({
        status: "refunded",
        provider: "zumbopay",
        providerReference: reference,
        providerPaymentId: paymentId || null,
        providerStatus: status,
        refundPending: current === "completed" || current === "paid",
        updatedAt: FieldValue.serverTimestamp(),
      });
      await notify(db, userId, reference, amount, "deposit_refunded", "Reembolso recebido", `O pagamento ${reference} foi marcado como reembolsado.`);
      return NextResponse.json({ success: true, received: true, status: "refunded", reference });
    }

    if (!isSuccess(type, status)) {
      return NextResponse.json({ success: true, received: true, ignored: true });
    }

    const userRef = db.collection("users").doc(userId);
    const walletTxRef = db.collection("wallet_transactions").doc(`ZUMBOPAY_TOPUP_${reference}`);
    const notificationRef = db.collection("notifications").doc(`ZUMBOPAY_DEPOSIT_${reference}`);
    let alreadyProcessed = false;
    let before = 0;
    let after = 0;

    await db.runTransaction(async (tx) => {
      const topupSnap = await tx.get(found.ref);
      const userSnap = await tx.get(userRef);
      const walletTxSnap = await tx.get(walletTxRef);

      if (!topupSnap.exists) throw new Error("TopUp desapareceu durante a transação.");
      if (!userSnap.exists) throw new Error(`Utilizador não encontrado: ${userId}`);

      const currentTopup = topupSnap.data() || {};
      const currentStatus = String(currentTopup.status || "pending").toLowerCase();

      if (["completed", "paid"].includes(currentStatus)) {
        alreadyProcessed = true;
        return;
      }

      const user = userSnap.data() || {};
      before = Number(user.walletBalance || 0);
      after = Math.round((before + amount + Number.EPSILON) * 100) / 100;

      tx.update(userRef, {
        walletBalance: after,
        updatedAt: FieldValue.serverTimestamp(),
      });

      tx.update(found.ref, {
        status: "completed",
        provider: "zumbopay",
        providerReference: reference,
        providerPaymentId: paymentId || null,
        providerSourceId: sourceId || null,
        providerStatus: status || "succeeded",
        providerAmount: providerAmount || amount,
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      if (!walletTxSnap.exists) {
        tx.create(walletTxRef, {
          userId,
          type: "credit",
          category: "deposit",
          amount,
          currency: "MZN",
          provider: "zumbopay",
          reference,
          sourceId: sourceId || null,
          paymentId: paymentId || null,
          description: `Depósito via ZumboPay - ${reference}`,
          balanceBefore: before,
          balanceAfter: after,
          status: "completed",
          createdAt: FieldValue.serverTimestamp(),
        });
      }

      tx.set(notificationRef, {
        userId,
        type: "deposit_success",
        title: "Depósito confirmado",
        message: `O seu depósito de ${amount.toFixed(2)} MT foi confirmado e já está disponível na sua carteira.`,
        amount,
        currency: "MZN",
        reference,
        paymentId: paymentId || null,
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    console.log("[ZumboPay] deposit settled", { userId, topupId, reference, amount, before, after, alreadyProcessed });

    return NextResponse.json({
      success: true,
      received: true,
      status: "completed",
      reference,
      paymentId,
      amount,
      credited: !alreadyProcessed,
      alreadyProcessed,
    });
  } catch (error: any) {
    console.error("[ZumboPay] webhook error", error);
    return NextResponse.json({ success: false, error: error?.message || "Internal webhook error" }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ success: true, service: "PayGo ZumboPay Webhook", status: "online" });
}
