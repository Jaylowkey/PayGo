import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

import {
  getApps,
  initializeApp,
  cert,
} from "firebase-admin/app";

import {
  getFirestore,
  FieldValue,
} from "firebase-admin/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * =========================================================
 * PayGo — ZumboPay Webhook
 * =========================================================
 *
 * Endpoint:
 * POST /api/webhooks/zumbopay
 *
 * Eventos:
 * - payment.succeeded
 * - payment.failed
 * - payment.refunded
 *
 * Responsabilidades:
 * - Validar assinatura HMAC
 * - Encontrar TopUp
 * - Confirmar pagamento
 * - Creditar walletBalance
 * - Criar wallet transaction
 * - Criar notificação
 * - Impedir crédito duplicado
 * - Registrar tentativas
 *
 * IMPORTANTE:
 * O saldo só é alterado depois de payment.succeeded.
 * =========================================================
 */

const WEBHOOK_SECRET =
  process.env.ZUMBOPAY_WEBHOOK_SECRET || "";

/**
 * =========================================================
 * FIREBASE ADMIN
 * =========================================================
 */

function getAdminDb() {
  if (!getApps().length) {
    const projectId =
      process.env.FIREBASE_PROJECT_ID ||
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

    const clientEmail =
      process.env.FIREBASE_CLIENT_EMAIL;

    const privateKey =
      process.env.FIREBASE_PRIVATE_KEY?.replace(
        /\\n/g,
        "\n"
      );

    if (
      !projectId ||
      !clientEmail ||
      !privateKey
    ) {
      throw new Error(
        "Configuração Firebase Admin incompleta."
      );
    }

    initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
  }

  return getFirestore();
}

/**
 * =========================================================
 * HMAC
 * =========================================================
 */

function verifyWebhookSignature(
  rawBody: string,
  signature: string
): boolean {
  if (!WEBHOOK_SECRET) {
    console.error(
      "[ZumboPay] ZUMBOPAY_WEBHOOK_SECRET não configurado."
    );

    return false;
  }

  if (!signature) {
    return false;
  }

  const cleanSignature = String(signature)
    .replace(/^sha256=/i, "")
    .trim();

  if (
    !/^[a-fA-F0-9]{64}$/.test(
      cleanSignature
    )
  ) {
    return false;
  }

  const expected = crypto
    .createHmac(
      "sha256",
      WEBHOOK_SECRET
    )
    .update(rawBody, "utf8")
    .digest("hex");

  const receivedBuffer =
    Buffer.from(
      cleanSignature,
      "hex"
    );

  const expectedBuffer =
    Buffer.from(
      expected,
      "hex"
    );

  if (
    receivedBuffer.length !==
    expectedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    receivedBuffer,
    expectedBuffer
  );
}

/**
 * =========================================================
 * HELPERS
 * =========================================================
 */

function getEventType(event: any): string {
  return String(
    event?.event ||
      event?.type ||
      event?.event_type ||
      event?.eventType ||
      ""
  )
    .trim()
    .toLowerCase();
}

function getEventData(event: any): any {
  return (
    event?.data ||
    event?.payment ||
    event?.transaction ||
    event
  );
}

function getReference(
  event: any
): string | null {
  const data = getEventData(event);

  return (
    data?.reference ||
    data?.source_id ||
    data?.sourceId ||
    event?.reference ||
    null
  );
}

function getPaymentId(
  event: any
): string | null {
  const data = getEventData(event);

  return (
    data?.id ||
    data?.payment_id ||
    data?.paymentId ||
    data?.transaction_id ||
    data?.transactionId ||
    null
  );
}

function getSourceId(
  event: any
): string | null {
  const data = getEventData(event);

  return (
    data?.source_id ||
    data?.sourceId ||
    event?.source_id ||
    event?.sourceId ||
    null
  );
}

function getAmount(event: any): number {
  const data = getEventData(event);

  const amount = Number(
    data?.amount ??
      data?.gross_amount ??
      data?.grossAmount ??
      data?.value ??
      0
  );

  return Number.isFinite(amount)
    ? amount
    : 0;
}

function getStatus(event: any): string {
  const data = getEventData(event);

  return String(
    data?.status ||
      event?.status ||
      ""
  )
    .trim()
    .toLowerCase();
}

function cleanReference(
  reference: string | null
): string {
  return String(
    reference || ""
  ).trim();
}

/**
 * =========================================================
 * EVENT STATUS
 * =========================================================
 */

function isPaymentSuccess(
  eventType: string,
  status: string
): boolean {
  return (
    [
      "payment.succeeded",
      "payment.success",
      "payment.completed",
      "charge.succeeded",
      "charge.success",
      "charge.completed",
    ].includes(eventType) ||
    [
      "success",
      "succeeded",
      "completed",
      "paid",
    ].includes(status)
  );
}

function isPaymentFailed(
  eventType: string,
  status: string
): boolean {
  return (
    [
      "payment.failed",
      "payment.failure",
      "payment.cancelled",
      "payment.canceled",
      "charge.failed",
      "charge.cancelled",
      "charge.canceled",
    ].includes(eventType) ||
    [
      "failed",
      "failure",
      "cancelled",
      "canceled",
    ].includes(status)
  );
}

function isPaymentRefunded(
  eventType: string,
  status: string
): boolean {
  return (
    [
      "payment.refunded",
      "payment.refund",
      "charge.refunded",
    ].includes(eventType) ||
    [
      "refunded",
      "refund",
    ].includes(status)
  );
}

/**
 * =========================================================
 * NOTIFICAÇÃO
 * =========================================================
 */

async function createNotification(
  db: FirebaseFirestore.Firestore,
  params: {
    userId: string;
    title: string;
    message: string;
    type: string;
    reference: string;
    amount?: number;
    status?: string;
  }
) {
  const notificationRef =
    db.collection("notifications").doc();

  await notificationRef.set({
    userId: params.userId,

    title: params.title,

    message: params.message,

    type: params.type,

    reference: params.reference,

    amount:
      params.amount ?? null,

    status:
      params.status ?? null,

    read: false,

    createdAt:
      FieldValue.serverTimestamp(),
  });
}

/**
 * =========================================================
 * REGISTRAR TENTATIVA
 * =========================================================
 *
 * Cada webhook recebido fica registrado.
 *
 * Isso permite auditoria e histórico.
 * =========================================================
 */

async function savePaymentAttempt(
  db: FirebaseFirestore.Firestore,
  params: {
    reference: string;
    sourceId?: string | null;
    paymentId?: string | null;
    eventType: string;
    status: string;
    amount: number;
    rawEvent: any;
    userId?: string | null;
    topupId?: string | null;
  }
) {
  const attemptId =
    [
      "ZUMBO",
      params.paymentId ||
        params.reference ||
        crypto.randomUUID(),
      params.eventType,
    ]
      .join("_")
      .replace(/[^a-zA-Z0-9_-]/g, "_");

  const ref =
    db
      .collection(
        "payment_attempts"
      )
      .doc(attemptId);

  await ref.set(
    {
      provider: "zumbopay",

      reference:
        params.reference,

      sourceId:
        params.sourceId ||
        null,

      paymentId:
        params.paymentId ||
        null,

      eventType:
        params.eventType,

      status:
        params.status,

      amount:
        params.amount,

      userId:
        params.userId ||
        null,

      topupId:
        params.topupId ||
        null,

      rawEvent:
        params.rawEvent,

      updatedAt:
        FieldValue.serverTimestamp(),

      createdAt:
        FieldValue.serverTimestamp(),
    },
    {
      merge: true,
    }
  );
}

/**
 * =========================================================
 * LOCALIZAR TOPUP
 * =========================================================
 *
 * Primeiro:
 *
 * topups/{reference}
 *
 * Depois procuramos referências alternativas.
 *
 * Isso é importante porque a PayGo pode ter:
 *
 * TOP-XXXXXXXX
 *
 * enquanto a ZumboPay devolve:
 *
 * ZP_XXXXXXXX
 * =========================================================
 */

async function findTopUp(
  db: FirebaseFirestore.Firestore,
  reference: string,
  sourceId?: string | null,
  paymentId?: string | null
) {
  /**
   * 1. ID direto
   */

  if (reference) {
    const directRef =
      db
        .collection("topups")
        .doc(reference);

    const directSnapshot =
      await directRef.get();

    if (directSnapshot.exists) {
      return {
        ref: directRef,
        snapshot: directSnapshot,
      };
    }
  }

  /**
   * 2. sourceId
   */

  if (sourceId) {
    const snapshot =
      await db
        .collection("topups")
        .where(
          "reference",
          "==",
          sourceId
        )
        .limit(1)
        .get();

    if (!snapshot.empty) {
      return {
        ref: snapshot.docs[0].ref,
        snapshot: snapshot.docs[0],
      };
    }

    const sourceSnapshot =
      await db
        .collection("topups")
        .where(
          "sourceId",
          "==",
          sourceId
        )
        .limit(1)
        .get();

    if (!sourceSnapshot.empty) {
      return {
        ref:
          sourceSnapshot.docs[0].ref,
        snapshot:
          sourceSnapshot.docs[0],
      };
    }
  }

  /**
   * 3. paymentId da ZumboPay
   */

  if (paymentId) {
    const snapshot =
      await db
        .collection("topups")
        .where(
          "providerPaymentId",
          "==",
          paymentId
        )
        .limit(1)
        .get();

    if (!snapshot.empty) {
      return {
        ref: snapshot.docs[0].ref,
        snapshot: snapshot.docs[0],
      };
    }
  }

  /**
   * Não encontrado
   */

  return null;
}

/**
 * =========================================================
 * POST WEBHOOK
 * =========================================================
 */

export async function POST(
  request: NextRequest
) {
  try {
    /**
     * =====================================================
     * 1. BODY ORIGINAL
     * =====================================================
     */

    const rawBody =
      await request.text();

    /**
     * =====================================================
     * 2. ASSINATURA
     * =====================================================
     *
     * Oficial:
     *
     * x-zumbopay-signature
     *
     * Mantemos compatibilidade com:
     *
     * X-ZumboPay-Signature
     */

    const signature =
      request.headers.get(
        "x-zumbopay-signature"
      ) ||
      request.headers.get(
        "x-zumbopay-signature"
      ) ||
      "";

    if (
      !verifyWebhookSignature(
        rawBody,
        signature
      )
    ) {
      console.error(
        "[ZumboPay] Assinatura inválida."
      );

      return NextResponse.json(
        {
          success: false,
          error:
            "Invalid webhook signature",
        },
        {
          status: 401,
        }
      );
    }

    /**
     * =====================================================
     * 3. JSON
     * =====================================================
     */

    let event: any;

    try {
      event =
        JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        {
          success: false,
          error:
            "Invalid JSON",
        },
        {
          status: 400,
        }
      );
    }

    /**
     * =====================================================
     * 4. EXTRAIR DADOS
     * =====================================================
     */

    const eventType =
      getEventType(event);

    const eventData =
      getEventData(event);

    const reference =
      cleanReference(
        getReference(event)
      );

    const sourceId =
      getSourceId(event);

    const paymentId =
      getPaymentId(event);

    const providerStatus =
      getStatus(event);

    const webhookAmount =
      getAmount(event);

    console.log(
      "[ZumboPay] Webhook recebido:",
      {
        eventType,
        reference,
        sourceId,
        paymentId,
        providerStatus,
        webhookAmount,
      }
    );

    /**
     * =====================================================
     * 5. EVENTO DESCONHECIDO
     * =====================================================
     */

    if (!eventType) {
      return NextResponse.json(
        {
          success: true,
          received: true,
          ignored: true,
        },
        {
          status: 200,
        }
      );
    }

    /**
     * =====================================================
     * 6. PAYOUT
     * =====================================================
     *
     * Por enquanto reconhecemos o evento.
     *
     * O payout terá tratamento próprio.
     */

    if (
      eventType.startsWith(
        "payout."
      )
    ) {
      console.log(
        `[ZumboPay] Payout recebido: ${eventType}`
      );

      return NextResponse.json(
        {
          success: true,
          received: true,
          handled: "payout",
        },
        {
          status: 200,
        }
      );
    }

    /**
     * =====================================================
     * 7. ESTADO DO PAGAMENTO
     * =====================================================
     */

    const success =
      isPaymentSuccess(
        eventType,
        providerStatus
      );

    const failed =
      isPaymentFailed(
        eventType,
        providerStatus
      );

    const refunded =
      isPaymentRefunded(
        eventType,
        providerStatus
      );

    /**
     * =====================================================
     * 8. EVENTO NÃO RELEVANTE
     * =====================================================
     */

    if (
      !success &&
      !failed &&
      !refunded
    ) {
      console.log(
        `[ZumboPay] Evento ignorado: ${eventType}`
      );

      return NextResponse.json(
        {
          success: true,
          received: true,
          ignored: true,
        },
        {
          status: 200,
        }
      );
    }

    /**
     * =====================================================
     * 9. REFERÊNCIA
     * =====================================================
     */

    if (!reference) {
      console.error(
        "[ZumboPay] Webhook sem referência."
      );

      /**
       * Não podemos creditar sem referência.
       *
       * Retornamos 200 para evitar retries infinitos
       * de um evento impossível de reconciliar.
       */

      return NextResponse.json(
        {
          success: true,
          received: true,
          ignored: true,
          reason:
            "missing_reference",
        },
        {
          status: 200,
        }
      );
    }

    /**
     * =====================================================
     * 10. FIRESTORE
     * =====================================================
     */

    const db =
      getAdminDb();

    /**
     * =====================================================
     * 11. LOCALIZAR TOPUP
     * =====================================================
     */

    const topupResult =
      await findTopUp(
        db,
        reference,
        sourceId,
        paymentId
      );

    if (!topupResult) {
      console.error(
        "[ZumboPay] TopUp não encontrado:",
        {
          reference,
          sourceId,
          paymentId,
        }
      );

      /**
       * Guardamos a tentativa mesmo sem TopUp.
       *
       * Isto é importante para auditoria.
       */

      await savePaymentAttempt(
        db,
        {
          reference,
          sourceId,
          paymentId,
          eventType,
          status:
            providerStatus ||
            "unknown",
          amount:
            webhookAmount,
          rawEvent: event,
        }
      );

      return NextResponse.json(
        {
          success: true,
          received: true,
          ignored: true,
          reason:
            "topup_not_found",
        },
        {
          status: 200,
        }
      );
    }

    const topupRef =
      topupResult.ref;

    const topup =
      topupResult.snapshot.data() ||
      {};

    const topupId =
      topupRef.id;

    const userId =
      String(
        topup.userId ||
          ""
      ).trim();

    /**
     * =====================================================
     * 12. REGISTRAR TENTATIVA
     * =====================================================
     */

    await savePaymentAttempt(
      db,
      {
        reference,
        sourceId,
        paymentId,
        eventType,
        status:
          providerStatus ||
          "unknown",
        amount:
          webhookAmount,
        rawEvent: event,
        userId:
          userId || null,
        topupId,
      }
    );

    /**
     * =====================================================
     * 13. USER ID
     * =====================================================
     */

    if (!userId) {
      console.error(
        "[ZumboPay] TopUp sem userId:",
        topupId
      );

      return NextResponse.json(
        {
          success: false,
          error:
            "TopUp sem userId",
        },
        {
          status: 500,
        }
      );
    }

    /**
     * =====================================================
     * 14. USER REF
     * =====================================================
     */

    const userRef =
      db
        .collection("users")
        .doc(userId);

    /**
     * =====================================================
     * 15. STATUS ATUAL
     * =====================================================
     */

    const currentStatus =
      String(
        topup.status ||
          "pending"
      ).toLowerCase();

    /**
     * =====================================================
     * 16. FAILED
     * =====================================================
     */

    if (failed) {
      /**
       * Nunca mudamos um pagamento já concluído
       * para failed.
       */

      if (
        ![
          "completed",
          "paid",
          "refunded",
        ].includes(
          currentStatus
        )
      ) {
        await topupRef.update({
          status:
            "failed",

          provider:
            "zumbopay",

          providerStatus,

          providerPaymentId:
            paymentId,

          providerReference:
            reference,

          updatedAt:
            FieldValue.serverTimestamp(),
        });

        /**
         * Notificação de falha
         */

        await createNotification(
          db,
          {
            userId,
            title:
              "Pagamento falhou",
            message:
              `O seu depósito de ${Number(
                topup.amount || 0
              ).toFixed(
                2
              )} MT não foi concluído.`,
            type:
              "deposit_failed",
            reference,
            amount:
              Number(
                topup.amount || 0
              ),
            status:
              "failed",
          }
        );
      }

      return NextResponse.json(
        {
          success: true,
          received: true,
          status:
            "failed",
          reference,
        },
        {
          status: 200,
        }
      );
    }

    /**
     * =====================================================
     * 17. REFUND
     * =====================================================
     */

    if (refunded) {
      /**
       * Não fazemos simplesmente:
       *
       * walletBalance -= amount
       *
       * porque precisamos verificar se:
       *
       * 1. O depósito foi creditado
       * 2. O refund já foi processado
       *
       * para evitar retirar saldo duas vezes.
       */

      const refundTransactionId =
        `ZUMBOPAY_REFUND_${reference}`;

      const refundTransactionRef =
        db
          .collection(
            "wallet_transactions"
          )
          .doc(
            refundTransactionId
          );

      const refundSnapshot =
        await refundTransactionRef.get();

      /**
       * Se já existe refund financeiro,
       * não fazemos novamente.
       */

      if (
        refundSnapshot.exists
      ) {
        await topupRef.update({
          status:
            "refunded",

          providerStatus,

          providerPaymentId:
            paymentId,

          providerReference:
            reference,

          updatedAt:
            FieldValue.serverTimestamp(),
        });

        return NextResponse.json(
          {
            success: true,
            received: true,
            status:
              "refunded",
            alreadyProcessed:
              true,
          },
          {
            status: 200,
          }
        );
      }

      /**
       * Por segurança:
       *
       * apenas marcamos o refund.
       *
       * O débito financeiro será feito
       * pelo processo de refund administrativo,
       * depois de validar a operação.
       */

      await topupRef.update({
        status:
          "refunded",

        provider:
          "zumbopay",

        providerStatus,

        providerPaymentId:
          paymentId,

        providerReference:
          reference,

        refundPending:
          true,

        updatedAt:
          FieldValue.serverTimestamp(),
      });

      await createNotification(
        db,
        {
          userId,
          title:
            "Reembolso recebido",
          message:
            `O pagamento ${reference} foi marcado como reembolsado.`,
          type:
            "deposit_refunded",
          reference,
          amount:
            Number(
              topup.amount || 0
            ),
          status:
            "refunded",
        }
      );

      return NextResponse.json(
        {
          success: true,
          received: true,
          status:
            "refunded",
        },
        {
          status: 200,
        }
      );
    }

    /**
     * =====================================================
     * 18. PAGAMENTO NÃO É SUCCESS
     * =====================================================
     */

    if (!success) {
      return NextResponse.json(
        {
          success: true,
          received: true,
        },
        {
          status: 200,
        }
      );
    }

    /**
     * =====================================================
     * 19. VALOR DO TOPUP
     * =====================================================
     */

    const topupAmount =
      Number(
        topup.amount || 0
      );

    if (
      !Number.isFinite(
        topupAmount
      ) ||
      topupAmount <= 0
    ) {
      console.error(
        "[ZumboPay] Valor inválido:",
        {
          topupId,
          topupAmount,
        }
      );

      return NextResponse.json(
        {
          success: false,
          error:
            "Invalid TopUp amount",
        },
        {
          status: 500,
        }
      );
    }

    /**
     * =====================================================
     * 20. VALIDAR VALOR
     * =====================================================
     */

    if (
      webhookAmount > 0
    ) {
      const difference =
        Math.abs(
          webhookAmount -
            topupAmount
        );

      if (
        difference >
        0.01
      ) {
        console.error(
          "[ZumboPay] Amount mismatch:",
          {
            reference,
            topupAmount,
            webhookAmount,
          }
        );

        await topupRef.update({
          status:
            "amount_mismatch",

          provider:
            "zumbopay",

          providerStatus,

          providerPaymentId:
            paymentId,

          providerReference:
            reference,

          providerAmount:
            webhookAmount,

          updatedAt:
            FieldValue.serverTimestamp(),
        });

        await createNotification(
          db,
          {
            userId,
            title:
              "Pagamento em análise",
            message:
              "Recebemos o pagamento, mas o valor recebido não corresponde ao valor solicitado. O depósito foi colocado em análise.",
            type:
              "deposit_review",
            reference,
            amount:
              webhookAmount,
            status:
              "amount_mismatch",
          }
        );

        return NextResponse.json(
          {
            success: true,
            received: true,
            ignored: true,
            reason:
              "amount_mismatch",
          },
          {
            status: 200,
          }
        );
      }
    }

    /**
     * =====================================================
     * 21. IDEMPOTÊNCIA
     * =====================================================
     *
     * O documento da wallet transaction possui ID
     * determinístico:
     *
     * ZUMBOPAY_TOPUP_<reference>
     *
     * Assim o mesmo webhook não pode gerar
     * dois créditos.
     */

    const transactionId =
      `ZUMBOPAY_TOPUP_${reference}`;

    const walletTransactionRef =
      db
        .collection(
          "wallet_transactions"
        )
        .doc(
          transactionId
        );

    /**
     * =====================================================
     * 22. NOTIFICAÇÃO DETERMINÍSTICA
     * =====================================================
     */

    const notificationRef =
      db
        .collection(
          "notifications"
        )
        .doc(
          `ZUMBOPAY_DEPOSIT_${reference}`
        );

    /**
     * =====================================================
     * 23. TRANSACTION FIRESTORE
     * =====================================================
     */

    let wasAlreadyProcessed =
      false;

    let balanceBefore = 0;

    let balanceAfter = 0;

    await db.runTransaction(
      async (transaction) => {
        /**
         * Ler tudo dentro da transaction.
         */

        const currentTopupSnapshot =
          await transaction.get(
            topupRef
          );

        if (
          !currentTopupSnapshot.exists
        ) {
          throw new Error(
            "TopUp não encontrado durante transaction."
          );
        }

        const currentTopup =
          currentTopupSnapshot.data() ||
          {};

        const status =
          String(
            currentTopup.status ||
              "pending"
          ).toLowerCase();

        /**
         * Se já completado:
         *
         * não adicionar novamente.
         */

        if (
          status ===
            "completed" ||
          status ===
            "paid"
        ) {
          wasAlreadyProcessed =
            true;

          return;
        }

        /**
         * Ler usuário.
         */

        const userSnapshot =
          await transaction.get(
            userRef
          );

        if (
          !userSnapshot.exists
        ) {
          throw new Error(
            `Utilizador não encontrado: ${userId}`
          );
        }

        const user =
          userSnapshot.data() ||
          {};

        balanceBefore =
          Number(
            user.walletBalance || 0
          );

        balanceAfter =
          balanceBefore +
          topupAmount;

        /**
         * =================================================
         * ATUALIZAR SALDO
         * =================================================
         */

        transaction.update(
          userRef,
          {
            walletBalance:
              balanceAfter,

            updatedAt:
              FieldValue.serverTimestamp(),
          }
        );

        /**
         * =================================================
         * ATUALIZAR TOPUP
         * =================================================
         */

        transaction.update(
          topupRef,
          {
            status:
              "completed",

            provider:
              "zumbopay",

            providerStatus:
              providerStatus ||
              "succeeded",

            providerPaymentId:
              paymentId,

            providerReference:
              reference,

            providerSourceId:
              sourceId ||
              null,

            providerAmount:
              webhookAmount ||
              topupAmount,

            completedAt:
              FieldValue.serverTimestamp(),

            updatedAt:
              FieldValue.serverTimestamp(),
          }
        );

        /**
         * =================================================
         * WALLET TRANSACTION
         * =================================================
         */

        const walletTransactionSnapshot =
          await transaction.get(
            walletTransactionRef
          );

        if (
          !walletTransactionSnapshot.exists
        ) {
          transaction.create(
            walletTransactionRef,
            {
              userId,

              type:
                "credit",

              category:
                "deposit",

              amount:
                topupAmount,

              currency:
                "MZN",

              provider:
                "zumbopay",

              reference,

              sourceId:
                sourceId ||
                null,

              paymentId:
                paymentId ||
                null,

              description:
                `Depósito via ZumboPay - ${reference}`,

              balanceBefore,

              balanceAfter,

              status:
                "completed",

              createdAt:
                FieldValue.serverTimestamp(),
            }
          );
        }

        /**
         * =================================================
         * NOTIFICAÇÃO
         * =================================================
         */

        transaction.set(
          notificationRef,
          {
            userId,

            type:
              "deposit_success",

            title:
              "Depósito confirmado",

            message:
              `O seu depósito de ${topupAmount.toFixed(
                2
              )} MT foi confirmado com sucesso e já está disponível na sua carteira.`,

            amount:
              topupAmount,

            currency:
              "MZN",

            reference,

            paymentId:
              paymentId ||
              null,

            read:
              false,

            createdAt:
              FieldValue.serverTimestamp(),
          },
          {
            merge: true,
          }
        );
      }
    );

    /**
     * =====================================================
     * 24. JÁ PROCESSADO
     * =====================================================
     */

    if (
      wasAlreadyProcessed
    ) {
      console.log(
        `[ZumboPay] Pagamento já processado: ${reference}`
      );

      return NextResponse.json(
        {
          success: true,
          received: true,
          alreadyProcessed:
            true,
          reference,
        },
        {
          status: 200,
        }
      );
    }

    /**
     * =====================================================
     * 25. LOG FINAL
     * =====================================================
     */

    console.log(
      "[ZumboPay] ✅ DEPÓSITO CONFIRMADO",
      {
        userId,
        topupId,
        reference,
        paymentId,
        amount:
          topupAmount,
        balanceBefore,
        balanceAfter,
      }
    );

    /**
     * =====================================================
     * 26. RESPONSE
     * =====================================================
     */

    return NextResponse.json(
      {
        success: true,

        received: true,

        status:
          "completed",

        reference,

        paymentId,

        amount:
          topupAmount,

        credited:
          true,
      },
      {
        status: 200,
      }
    );
  } catch (error: any) {
    /**
     * =====================================================
     * ERRO
     * =====================================================
     *
     * Retornamos 500 para que a ZumboPay possa tentar
     * novamente.
     *
     * A transaction + IDs determinísticos protegem
     * contra crédito duplicado.
     */

    console.error(
      "[ZumboPay] ❌ Webhook error:",
      error
    );

    return NextResponse.json(
      {
        success: false,

        error:
          error?.message ||
          "Internal webhook error",
      },
      {
        status: 500,
      }
    );
  }
}

/**
 * =========================================================
 * GET
 * =========================================================
 *
 * Health check.
 *
 * Não confirma pagamentos.
 * =========================================================
 */

export async function GET() {
  return NextResponse.json(
    {
      success: true,

      service:
        "PayGo ZumboPay Webhook",

      status:
        "online",
    },
    {
      status: 200,
    }
  );
}
