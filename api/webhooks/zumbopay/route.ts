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
 *
 * POST /api/webhooks/zumbopay
 *
 * Responsabilidades:
 *
 * 1. Receber webhook da ZumboPay
 * 2. Validar assinatura HMAC
 * 3. Identificar o TopUp
 * 4. Confirmar pagamento
 * 5. Creditar walletBalance
 * 6. Criar wallet transaction
 * 7. Impedir crédito duplicado
 *
 * IMPORTANTE:
 *
 * O saldo NÃO é atualizado em:
 *
 * /api/payments/initiate
 *
 * O saldo somente é atualizado aqui depois
 * de uma confirmação de pagamento.
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

  const cleanSignature =
    String(signature)
      .replace(
        /^sha256=/i,
        ""
      )
      .trim();

  if (
    !/^[a-fA-F0-9]{64}$/.test(
      cleanSignature
    )
  ) {
    return false;
  }

  const expected =
    crypto
      .createHmac(
        "sha256",
        WEBHOOK_SECRET
      )
      .update(
        rawBody,
        "utf8"
      )
      .digest("hex");

  const expectedBuffer =
    Buffer.from(
      expected,
      "hex"
    );

  const receivedBuffer =
    Buffer.from(
      cleanSignature,
      "hex"
    );

  if (
    expectedBuffer.length !==
    receivedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    expectedBuffer,
    receivedBuffer
  );
}

/**
 * =========================================================
 * HELPERS
 * =========================================================
 */

function getEventType(
  event: any
): string {
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

function getEventData(
  event: any
): any {
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
  const data =
    getEventData(event);

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
  const data =
    getEventData(event);

  return (
    data?.id ||
    data?.payment_id ||
    data?.paymentId ||
    data?.transaction_id ||
    data?.transactionId ||
    null
  );
}

function getAmount(
  event: any
): number {
  const data =
    getEventData(event);

  const amount =
    Number(
      data?.amount ??
        data?.gross_amount ??
        data?.grossAmount ??
        data?.value ??
        0
    );

  return Number.isFinite(
    amount
  )
    ? amount
    : 0;
}

function getStatus(
  event: any
): string {
  const data =
    getEventData(event);

  return String(
    data?.status ||
      event?.status ||
      ""
  )
    .trim()
    .toLowerCase();
}

/**
 * =========================================================
 * EVENT STATUS
 * =========================================================
 */

function isPaymentSuccess(
  eventType: string,
  status: string
) {
  const successEvents = [
    "payment.succeeded",
    "payment.success",
    "payment.completed",
    "charge.succeeded",
    "charge.success",
    "charge.completed",
  ];

  if (
    successEvents.includes(
      eventType
    )
  ) {
    return true;
  }

  return [
    "success",
    "succeeded",
    "completed",
    "paid",
  ].includes(
    status
  );
}

function isPaymentFailed(
  eventType: string,
  status: string
) {
  const failedEvents = [
    "payment.failed",
    "payment.failure",
    "payment.cancelled",
    "payment.canceled",
    "charge.failed",
    "charge.cancelled",
    "charge.canceled",
  ];

  if (
    failedEvents.includes(
      eventType
    )
  ) {
    return true;
  }

  return [
    "failed",
    "failure",
    "cancelled",
    "canceled",
  ].includes(
    status
  );
}

function isPaymentRefunded(
  eventType: string,
  status: string
) {
  const refundedEvents = [
    "payment.refunded",
    "payment.refund",
    "charge.refunded",
  ];

  if (
    refundedEvents.includes(
      eventType
    )
  ) {
    return true;
  }

  return [
    "refunded",
    "refund",
  ].includes(
    status
  );
}

/**
 * =========================================================
 * TOPUP REFERENCE
 * =========================================================
 *
 * O frontend cria:
 *
 * TOP-XXXXXXXX
 *
 * e envia essa referência à ZumboPay.
 * =========================================================
 */

function cleanReference(
  reference: string
): string {
  return String(
    reference || ""
  ).trim();
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
     *
     * A assinatura deve ser calculada sobre o
     * body bruto.
     */

    const rawBody =
      await request.text();

    /**
     * =====================================================
     * 2. ASSINATURA
     * =====================================================
     */

    const signature =
      request.headers.get(
        "x-zumbopay-signature"
      ) ||
      request.headers.get(
        "X-ZumboPay-Signature"
      ) ||
      "";

    if (
      !verifyWebhookSignature(
        rawBody,
        signature
      )
    ) {
      console.error(
        "[ZumboPay] Assinatura do webhook inválida."
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
        JSON.parse(
          rawBody
        );
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
        getReference(event) || ""
      );

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
        paymentId,
        status:
          providerStatus,
        amount:
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
        },
        {
          status: 200,
        }
      );
    }

    /**
     * =====================================================
     * 6. IGNORAR PAYOUTS AQUI
     * =====================================================
     *
     * Os payouts terão seu próprio tratamento.
     */

    if (
      eventType.startsWith(
        "payout."
      )
    ) {
      console.log(
        `[ZumboPay] Evento de payout recebido: ${eventType}`
      );

      return NextResponse.json(
        {
          success: true,
          received: true,
          handled:
            "payout",
        },
        {
          status: 200,
        }
      );
    }

    /**
     * =====================================================
     * 7. VERIFICAR EVENTO DE PAGAMENTO
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
     * 8. REFERÊNCIA
     * =====================================================
     */

    if (!reference) {
      console.error(
        "[ZumboPay] Webhook sem reference/source_id."
      );

      /**
       * Não podemos creditar dinheiro sem saber
       * a qual TopUp pertence.
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
     * 9. FIRESTORE
     * =====================================================
     */

    const db =
      getAdminDb();

    const topupRef =
      db
        .collection("topups")
        .doc(reference);

    const topupSnapshot =
      await topupRef.get();

    if (
      !topupSnapshot.exists
    ) {
      console.error(
        `[ZumboPay] TopUp não encontrado: ${reference}`
      );

      /**
       * Não criamos um TopUp automaticamente.
       *
       * Isso evita que alguém consiga enviar um
       * webhook referente a uma referência desconhecida
       * e gerar saldo.
       */
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

    const topup =
      topupSnapshot.data() || {};

    /**
     * =====================================================
     * 10. VERIFICAR STATUS ATUAL
     * =====================================================
     */

    const currentStatus =
      String(
        topup.status ||
          "pending"
      ).toLowerCase();

    /**
     * =====================================================
     * 11. PAGAMENTO FALHOU
     * =====================================================
     */

    if (failed) {
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

          providerStatus,

          providerPaymentId:
            paymentId,

          updatedAt:
            FieldValue.serverTimestamp(),
        });
      }

      console.log(
        `[ZumboPay] TopUp marcado como failed: ${reference}`
      );

      return NextResponse.json(
        {
          success: true,
          received: true,
          status:
            "failed",
        },
        {
          status: 200,
        }
      );
    }

    /**
     * =====================================================
     * 12. REEMBOLSO
     * =====================================================
     */

    if (refunded) {
      await topupRef.update({
        status:
          "refunded",

        providerStatus,

        providerPaymentId:
          paymentId,

        updatedAt:
          FieldValue.serverTimestamp(),
      });

      console.log(
        `[ZumboPay] TopUp reembolsado: ${reference}`
      );

      /**
       * IMPORTANTE:
       *
       * Não fazemos débito automático aqui.
       *
       * O tratamento de refund financeiro deve ser
       * separado para evitar que um webhook duplicado
       * retire saldo duas vezes.
       */

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
     * 13. PAGAMENTO NÃO CONFIRMADO
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
     * 14. IDEMPOTÊNCIA
     * =====================================================
     *
     * Se já está completed/paid,
     * NÃO adicionar saldo novamente.
     */

    if (
      currentStatus ===
        "completed" ||
      currentStatus ===
        "paid"
    ) {
      console.log(
        `[ZumboPay] TopUp já processado: ${reference}`
      );

      return NextResponse.json(
        {
          success: true,
          received: true,
          alreadyProcessed:
            true,
        },
        {
          status: 200,
        }
      );
    }

    /**
     * =====================================================
     * 15. VALOR
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
        `[ZumboPay] TopUp com valor inválido: ${reference}`
      );

      return NextResponse.json(
        {
          success: false,
          error:
            "Invalid TopUp amount",
        },
        {
          status: 400,
        }
      );
    }

    /**
     * =====================================================
     * 16. VALIDAR VALOR DO WEBHOOK
     * =====================================================
     *
     * Se a ZumboPay enviar o amount, comparamos
     * com o valor que o cliente solicitou.
     *
     * Não aceitamos automaticamente uma diferença.
     */

    if (
      webhookAmount > 0
    ) {
      const difference =
        Math.abs(
          webhookAmount -
            topupAmount
        );

      /**
       * Tolerância de 0.01 MT
       * para arredondamentos.
       */

      if (
        difference >
        0.01
      ) {
        console.error(
          "[ZumboPay] Valor divergente:",
          {
            reference,
            topupAmount,
            webhookAmount,
          }
        );

        await topupRef.update({
          status:
            "amount_mismatch",

          providerStatus,

          providerPaymentId:
            paymentId,

          providerAmount:
            webhookAmount,

          updatedAt:
            FieldValue.serverTimestamp(),
        });

        /**
         * Não creditamos.
         */
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
     * 17. USER ID
     * =====================================================
     */

    const userId =
      String(
        topup.userId ||
          ""
      ).trim();

    if (!userId) {
      console.error(
        `[ZumboPay] TopUp sem userId: ${reference}`
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
     * 18. USER
     * =====================================================
     */

    const userRef =
      db
        .collection("users")
        .doc(userId);

    /**
     * =====================================================
     * 19. TRANSACTION
     * =====================================================
     *
     * Esta é a parte mais importante.
     *
     * Firestore transaction garante que dois webhooks
     * simultâneos não adicionem o saldo duas vezes.
     */

    await db.runTransaction(
      async (transaction) => {
        /**
         * Ler novamente o TopUp dentro da transaction.
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
         * Outro webhook pode ter terminado
         * enquanto este estava sendo processado.
         */
        if (
          status ===
            "completed" ||
          status ===
            "paid"
        ) {
          return;
        }

        /**
         * ===================================================
         * USER DENTRO DA TRANSACTION
         * ===================================================
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

        const oldBalance =
          Number(
            user.walletBalance || 0
          );

        const newBalance =
          oldBalance +
          topupAmount;

        /**
         * ===================================================
         * ATUALIZAR WALLET
         * ===================================================
         */

        transaction.update(
          userRef,
          {
            walletBalance:
              newBalance,

            updatedAt:
              FieldValue.serverTimestamp(),
          }
        );

        /**
         * ===================================================
         * ATUALIZAR TOPUP
         * ===================================================
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
              "success",

            providerPaymentId:
              paymentId,

            providerReference:
              reference,

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
         * ===================================================
         * WALLET TRANSACTION
         * ===================================================
         *
         * Criamos um documento determinístico.
         *
         * Isso é importante para impedir duplicação.
         *
         * ID:
         *
         * ZUMBOPAY_TOPUP_TOP-12345678
         * ===================================================
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

        const walletTransactionSnapshot =
          await transaction.get(
            walletTransactionRef
          );

        /**
         * Só criamos a transação se ainda não existir.
         */

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

              paymentId:
                paymentId,

              description:
                `Depósito via ZumboPay - ${reference}`,

              balanceBefore:
                oldBalance,

              balanceAfter:
                newBalance,

              status:
                "completed",

              createdAt:
                FieldValue.serverTimestamp(),
            }
          );
        }

        console.log(
          "[ZumboPay] Crédito processado:",
          {
            userId,
            reference,
            amount:
              topupAmount,
            balanceBefore:
              oldBalance,
            balanceAfter:
              newBalance,
          }
        );
      }
    );

    /**
     * =====================================================
     * 20. SUCESSO
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
      },
      {
        status: 200,
      }
    );
  } catch (error: any) {
    console.error(
      "[ZumboPay] Webhook error:",
      error
    );

    /**
     * 500 permite que o provider tente novamente.
     *
     * Como usamos transaction + idempotência,
     * uma nova tentativa não deve duplicar o saldo.
     */

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
 * Útil para verificar se a rota existe.
 *
 * NÃO confirma pagamentos.
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
