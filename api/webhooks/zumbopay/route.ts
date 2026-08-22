import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WEBHOOK_SECRET =
  process.env.ZUMBOPAY_WEBHOOK_SECRET || "";

/**
 * =========================================================
 * ZumboPay Webhook
 * =========================================================
 *
 * Endpoint:
 *
 * /api/webhooks/zumbopay
 *
 * Eventos:
 *
 * payment.succeeded
 * payment.failed
 * payment.refunded
 *
 * Importante:
 *
 * O saldo PayGo só é creditado depois de uma confirmação
 * válida da ZumboPay.
 * =========================================================
 */

function verifySignature(
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

  if (!/^[a-fA-F0-9]{64}$/.test(cleanSignature)) {
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
 * Obtém o evento independentemente
 * do formato usado pela ZumboPay.
 */
function getEventType(event: any) {
  return (
    event?.event ||
    event?.type ||
    event?.event_type ||
    event?.eventType ||
    ""
  );
}

/**
 * Obtém os dados do pagamento.
 */
function getPaymentData(event: any) {
  return (
    event?.data ||
    event?.payment ||
    event?.transaction ||
    event
  );
}

/**
 * Extrai referência.
 */
function getReference(
  event: any
): string | null {
  const data =
    getPaymentData(event);

  return (
    data?.reference ||
    data?.source_id ||
    data?.sourceId ||
    event?.reference ||
    null
  );
}

/**
 * Extrai ID da transação.
 */
function getPaymentId(
  event: any
): string | null {
  const data =
    getPaymentData(event);

  return (
    data?.id ||
    data?.payment_id ||
    data?.paymentId ||
    data?.transaction_id ||
    data?.transactionId ||
    null
  );
}

/**
 * Extrai valor.
 */
function getAmount(
  event: any
): number {
  const data =
    getPaymentData(event);

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

/**
 * Verifica se é evento de sucesso.
 */
function isPaymentSuccess(
  eventType: string
) {
  return [
    "payment.succeeded",
    "payment.success",
    "payment.completed",
    "charge.succeeded",
    "charge.success",
    "charge.completed",
  ].includes(
    String(eventType).toLowerCase()
  );
}

/**
 * Verifica falha.
 */
function isPaymentFailed(
  eventType: string
) {
  return [
    "payment.failed",
    "payment.failure",
    "payment.cancelled",
    "payment.canceled",
    "charge.failed",
    "charge.cancelled",
    "charge.canceled",
  ].includes(
    String(eventType).toLowerCase()
  );
}

/**
 * Verifica reembolso.
 */
function isPaymentRefunded(
  eventType: string
) {
  return [
    "payment.refunded",
    "payment.refund",
    "charge.refunded",
  ].includes(
    String(eventType).toLowerCase()
  );
}

export async function POST(
  request: NextRequest
) {
  try {
    /**
     * =====================================================
     * 1. LER O BODY BRUTO
     * =====================================================
     *
     * Não usar request.json() antes da validação,
     * porque a assinatura HMAC deve ser calculada
     * sobre o body original.
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
      !verifySignature(
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
     * 3. PARSE
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

    const eventType =
      getEventType(event);

    const paymentData =
      getPaymentData(event);

    const reference =
      getReference(event);

    const paymentId =
      getPaymentId(event);

    const amount =
      getAmount(event);

    console.log(
      "[ZumboPay] Webhook recebido:",
      {
        eventType,
        reference,
        paymentId,
        amount,
      }
    );

    /**
     * =====================================================
     * 4. EVENTO DESCONHECIDO
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
     * 5. SOMENTE EVENTOS DE PAGAMENTO
     * =====================================================
     */

    const paymentEvent =
      isPaymentSuccess(
        eventType
      ) ||
      isPaymentFailed(
        eventType
      ) ||
      isPaymentRefunded(
        eventType
      );

    if (!paymentEvent) {
      /**
       * Payouts serão tratados em endpoint
       * próprio posteriormente.
       */
      console.log(
        `[ZumboPay] Evento ignorado: ${eventType}`
      );

      return NextResponse.json(
        {
          success: true,
          received: true,
          ignored: true,
          event: eventType,
        },
        {
          status: 200,
        }
      );
    }

    /**
     * =====================================================
     * 6. REFERÊNCIA OBRIGATÓRIA
     * =====================================================
     */

    if (!reference) {
      console.error(
        "[ZumboPay] Pagamento sem referência."
      );

      /**
       * Retornamos 200 para evitar que a ZumboPay
       * fique repetindo indefinidamente um evento
       * que não conseguimos associar.
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
     * 7. LOCALIZAR TOPUP
     * =====================================================
     *
     * A referência criada pelo PayGo deve ser:
     *
     * TOP-XXXXXXXX
     *
     * O webhook procura pelo ID/referência.
     */

    const topup = await prisma.topup.findFirst({
      where: {
        OR: [
          {
            id: String(reference),
          },

          /**
           * Se o teu model TopUp tiver reference,
           * esta condição poderá ser usada.
           *
           * Caso o schema não possua esse campo,
           * remova esta condição.
           */
        ],
      },
    });

    if (!topup) {
      console.error(
        `[ZumboPay] Topup não encontrado: ${reference}`
      );

      /**
       * Não fazemos crédito sem encontrar
       * o registro original.
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

    /**
     * =====================================================
     * 8. PAGAMENTO FALHOU
     * =====================================================
     */

    if (
      isPaymentFailed(
        eventType
      )
    ) {
      /**
       * Não mexemos no saldo.
       *
       * Atualizamos somente se o TopUp ainda
       * estiver pendente.
       */

      if (
        topup.status ===
        "pending"
      ) {
        await prisma.topup.update({
          where: {
            id: topup.id,
          },

          data: {
            status:
              "failed",
          },
        });
      }

      console.log(
        `[ZumboPay] Pagamento falhou: ${topup.id}`
      );

      return NextResponse.json(
        {
          success: true,
          received: true,
          status: "failed",
        },
        {
          status: 200,
        }
      );
    }

    /**
     * =====================================================
     * 9. REEMBOLSO
     * =====================================================
     */

    if (
      isPaymentRefunded(
        eventType
      )
    ) {
      await prisma.topup.update({
        where: {
          id: topup.id,
        },

        data: {
          status:
            "refunded",
        },
      });

      console.log(
        `[ZumboPay] TopUp reembolsado: ${topup.id}`
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
     * 10. PAGAMENTO CONFIRMADO
     * =====================================================
     */

    if (
      isPaymentSuccess(
        eventType
      )
    ) {
      /**
       * Valor que a ZumboPay confirmou.
       *
       * Se a ZumboPay não enviar amount,
       * usamos o valor original do TopUp.
       */
      const confirmedAmount =
        amount > 0
          ? amount
          : Number(
              topup.amount || 0
            );

      if (
        confirmedAmount <= 0
      ) {
        console.error(
          `[ZumboPay] Valor inválido para TopUp ${topup.id}`
        );

        return NextResponse.json(
          {
            success: false,
            error:
              "Invalid payment amount",
          },
          {
            status: 400,
          }
        );
      }

      /**
       * ===================================================
       * 11. IDEMPOTÊNCIA
       * ===================================================
       *
       * Se o webhook já foi processado,
       * NÃO devemos adicionar saldo novamente.
       */

      if (
        topup.status ===
        "completed"
      ) {
        console.log(
          `[ZumboPay] TopUp já processado: ${topup.id}`
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
       * ===================================================
       * 12. TRANSAÇÃO
       * ===================================================
       *
       * A operação deve ser atômica:
       *
       * TopUp → completed
       * User → walletBalance + amount
       * WalletTransaction → credit
       *
       * ===================================================
       */

      await prisma.$transaction(
        async (tx) => {
          /**
           * Recarregar TopUp dentro da transação
           * para reduzir risco de corrida entre
           * dois webhooks simultâneos.
           */
          const currentTopup =
            await tx.topup.findUnique({
              where: {
                id: topup.id,
              },
            });

          if (!currentTopup) {
            throw new Error(
              "TopUp desapareceu durante a transação."
            );
          }

          /**
           * Outro webhook pode ter processado
           * enquanto esta transação iniciava.
           */
          if (
            currentTopup.status ===
            "completed"
          ) {
            return;
          }

          /**
           * =================================================
           * USER
           * =================================================
           */

          const user =
            await tx.user.findUnique({
              where: {
                id:
                  currentTopup.userId,
              },
            });

          if (!user) {
            throw new Error(
              `Utilizador não encontrado: ${currentTopup.userId}`
            );
          }

          const oldBalance =
            Number(
              user.walletBalance || 0
            );

          const newBalance =
            oldBalance +
            confirmedAmount;

          /**
           * Atualizar saldo.
           */
          await tx.user.update({
            where: {
              id:
                currentTopup.userId,
            },

            data: {
              walletBalance:
                newBalance,
            },
          });

          /**
           * =================================================
           * TOPUP
           * =================================================
           */

          await tx.topup.update({
            where: {
              id:
                currentTopup.id,
            },

            data: {
              status:
                "completed",

              /**
               * Se estes campos existirem no teu schema,
               * podem ser adicionados:
               *
               * provider: "zumbopay"
               * providerReference: paymentId
               *
               * Por enquanto mantemos somente
               * campos universais.
               */
            },
          });

          /**
           * =================================================
           * WALLET TRANSACTION
           * =================================================
           *
           * Criamos o registro financeiro do crédito.
           *
           * ATENÇÃO:
           * Se o teu model tiver nomes diferentes,
           * ajustaremos depois de ver o schema Prisma.
           */

          try {
            await tx.walletTransaction.create({
              data: {
                userId:
                  currentTopup.userId,

                type:
                  "credit",

                amount:
                  confirmedAmount,

                description:
                  `Depósito via ZumboPay - ${reference}`,
              },
            });
          } catch (
            walletTransactionError
          ) {
            /**
             * Se o model WalletTransaction da tua
             * versão tiver campos diferentes,
             * o erro será mostrado nos logs.
             *
             * NÃO fazemos rollback silencioso.
             */
            console.error(
              "[ZumboPay] Erro ao criar wallet transaction:",
              walletTransactionError
            );

            throw walletTransactionError;
          }

          console.log(
            `[ZumboPay] Crédito confirmado: ${currentTopup.userId} +${confirmedAmount} MT`
          );
        }
      );

      /**
       * =====================================================
       * 13. RESPOSTA
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
            confirmedAmount,
        },
        {
          status: 200,
        }
      );
    }

    /**
     * =====================================================
     * FALLBACK
     * =====================================================
     */

    return NextResponse.json(
      {
        success: true,
        received: true,
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
     * 500 faz a ZumboPay tentar novamente,
     * o que é desejável quando houve erro
     * interno antes de completar o crédito.
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
