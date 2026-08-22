import { NextRequest, NextResponse } from "next/server";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getApps, initializeApp, cert } from "firebase-admin/app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * =========================================================
 * PAYGO → ZUMBOPAY
 * POST /api/payments/initiate
 * =========================================================
 *
 * Recebe:
 *
 * {
 *   topupId: "TOP-12345678",
 *   amount: 500,
 *   method: "mpesa",
 *   phone: "841234567"
 * }
 *
 * Fluxo:
 *
 * Frontend
 *    ↓
 * /api/payments/initiate
 *    ↓
 * ZumboPay
 *    ↓
 * pagamento pendente
 *
 * O saldo NÃO é atualizado aqui.
 *
 * O saldo será atualizado somente pelo webhook.
 * =========================================================
 */

const ZUMBOPAY_API_URL =
  process.env.ZUMBOPAY_API_URL ||
  "https://zumbopay.com/api/v1";

const ZUMBOPAY_API_KEY =
  process.env.ZUMBOPAY_API_KEY || "";

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
 * NORMALIZAR TELEFONE
 * =========================================================
 */

function normalizePhone(
  phone: string
): string {
  let value = String(
    phone || ""
  )
    .trim()
    .replace(/\s+/g, "")
    .replace(/-/g, "");

  value = value.replace(
    /[^\d+]/g,
    ""
  );

  if (value.startsWith("+")) {
    value = value.substring(1);
  }

  if (value.startsWith("00")) {
    value = value.substring(2);
  }

  if (value.startsWith("258")) {
    value = value.substring(3);
  }

  if (value.startsWith("0")) {
    value = value.substring(1);
  }

  /**
   * M-Pesa:
   * 84 / 85
   *
   * e-Mola:
   * 86 / 87
   */

  if (!/^8[4-7]\d{7}$/.test(value)) {
    throw new Error(
      "Número de telefone inválido. Use, por exemplo, 841234567."
    );
  }

  return `+258${value}`;
}

/**
 * =========================================================
 * NORMALIZAR MÉTODO
 * =========================================================
 */

function normalizeMethod(
  method: string
): "mpesa" | "emola" {
  const value =
    String(method || "")
      .trim()
      .toLowerCase();

  if (value === "mpesa") {
    return "mpesa";
  }

  if (
    value === "emola" ||
    value === "e-mola" ||
    value === "e_mola"
  ) {
    return "emola";
  }

  throw new Error(
    "Método de pagamento inválido. Escolha M-Pesa ou e-Mola."
  );
}

/**
 * =========================================================
 * POST
 * =========================================================
 */

export async function POST(
  request: NextRequest
) {
  try {
    /**
     * =====================================================
     * 1. VERIFICAR CONFIGURAÇÃO
     * =====================================================
     */

    if (!ZUMBOPAY_API_KEY) {
      console.error(
        "[PayGo] ZUMBOPAY_API_KEY não configurada."
      );

      return NextResponse.json(
        {
          success: false,
          error:
            "Gateway de pagamento não configurado.",
        },
        {
          status: 500,
        }
      );
    }

    /**
     * =====================================================
     * 2. BODY
     * =====================================================
     */

    const body =
      await request.json();

    const {
      topupId,
      orderId,
      amount,
      method,
      phone,
      description,
    } = body || {};

    /**
     * Aceitamos topupId ou orderId
     * para facilitar a transição do frontend.
     */

    const reference =
      String(
        topupId ||
          orderId ||
          ""
      ).trim();

    if (!reference) {
      return NextResponse.json(
        {
          success: false,
          error:
            "topupId é obrigatório.",
        },
        {
          status: 400,
        }
      );
    }

    /**
     * =====================================================
     * 3. VALIDAR VALOR
     * =====================================================
     */

    const numericAmount =
      Number(amount);

    if (
      !Number.isFinite(
        numericAmount
      ) ||
      numericAmount <= 0
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Valor de pagamento inválido.",
        },
        {
          status: 400,
        }
      );
    }

    /**
     * PayGo mínimo.
     */

    if (
      numericAmount < 10
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "O depósito mínimo é de 10 MT.",
        },
        {
          status: 400,
        }
      );
    }

    /**
     * =====================================================
     * 4. MÉTODO
     * =====================================================
     */

    let paymentMethod:
      | "mpesa"
      | "emola";

    try {
      paymentMethod =
        normalizeMethod(
          method
        );
    } catch (error: any) {
      return NextResponse.json(
        {
          success: false,
          error:
            error.message,
        },
        {
          status: 400,
        }
      );
    }

    /**
     * =====================================================
     * 5. TELEFONE
     * =====================================================
     */

    if (!phone) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Número de telefone é obrigatório.",
        },
        {
          status: 400,
        }
      );
    }

    let customerPhone: string;

    try {
      customerPhone =
        normalizePhone(
          phone
        );
    } catch (error: any) {
      return NextResponse.json(
        {
          success: false,
          error:
            error.message,
        },
        {
          status: 400,
        }
      );
    }

    /**
     * =====================================================
     * 6. FIRESTORE
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

    /**
     * O frontend deve ter criado
     * o topup antes de chamar esta rota.
     */

    if (!topupSnapshot.exists) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Pedido de depósito não encontrado.",
        },
        {
          status: 404,
        }
      );
    }

    const topup =
      topupSnapshot.data() || {};

    /**
     * =====================================================
     * 7. EVITAR DUPLICAÇÃO
     * =====================================================
     */

    if (
      topup.status ===
        "completed" ||
      topup.status ===
        "paid"
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Este depósito já foi confirmado.",
        },
        {
          status: 400,
        }
      );
    }

    /**
     * Se já existe uma referência
     * da ZumboPay, não criamos outro pagamento.
     */

    if (
      topup.providerReference
    ) {
      return NextResponse.json(
        {
          success: true,
          status:
            topup.status ||
            "pending",

          reference:
            topup.providerReference,

          paymentId:
            topup.providerPaymentId ||
            null,

          checkoutUrl:
            topup.checkoutUrl ||
            null,

          alreadyCreated:
            true,
        },
        {
          status: 200,
        }
      );
    }

    /**
     * =====================================================
     * 8. CALLBACK
     * =====================================================
     */

    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.APP_URL ||
      request.nextUrl.origin;

    const callbackUrl =
      `${baseUrl}/api/webhooks/zumbopay`;

    /**
     * =====================================================
     * 9. PAYLOAD ZUMBOPAY
     * =====================================================
     */

    const payload = {
      amount:
        Number(
          numericAmount.toFixed(2)
        ),

      currency:
        "MZN",

      method:
        paymentMethod,

      customer: {
        phone:
          customerPhone,
      },

      callback_url:
        callbackUrl,

      reference,

      description:
        description ||
        `Depósito PayGo ${reference}`,
    };

    console.log(
      "[PayGo → ZumboPay] Criando pagamento:",
      {
        reference,
        amount:
          payload.amount,
        method:
          paymentMethod,
        phone:
          customerPhone,
      }
    );

    /**
     * =====================================================
     * 10. CHAMADA ZUMBOPAY
     * =====================================================
     */

    const response =
      await fetch(
        `${ZUMBOPAY_API_URL.replace(
          /\/+$/,
          ""
        )}/payments`,
        {
          method:
            "POST",

          headers: {
            Authorization:
              `Bearer ${ZUMBOPAY_API_KEY}`,

            "Content-Type":
              "application/json",

            Accept:
              "application/json",

            "Idempotency-Key":
              reference,
          },

          body:
            JSON.stringify(
              payload
            ),

          cache:
            "no-store",
        }
      );

    /**
     * =====================================================
     * 11. RESPOSTA
     * =====================================================
     */

    const responseText =
      await response.text();

    let providerData:
      any = {};

    try {
      providerData =
        responseText
          ? JSON.parse(
              responseText
            )
          : {};
    } catch {
      providerData = {
        raw:
          responseText,
      };
    }

    if (!response.ok) {
      console.error(
        "[ZumboPay] Erro:",
        {
          status:
            response.status,

          response:
            providerData,
        }
      );

      /**
       * Registra a falha no topup,
       * mas não mexe no saldo.
       */

      await topupRef.update({
        lastProviderError:
          providerData,

        lastProviderStatus:
          response.status,

        updatedAt:
          FieldValue.serverTimestamp(),
      });

      return NextResponse.json(
        {
          success: false,

          error:
            providerData?.error?.message ||
            providerData?.message ||
            providerData?.error ||
            `ZumboPay respondeu HTTP ${response.status}.`,

          providerStatus:
            response.status,
        },
        {
          status:
            response.status >= 400 &&
            response.status < 500
              ? response.status
              : 502,
        }
      );
    }

    /**
     * =====================================================
     * 12. EXTRAIR DADOS
     * =====================================================
     */

    const data =
      providerData?.data ||
      providerData;

    const paymentId =
      data?.id ||
      data?.payment_id ||
      data?.paymentId ||
      null;

    const providerReference =
      data?.reference ||
      data?.transaction_id ||
      data?.transactionId ||
      reference;

    const status =
      data?.status ||
      "pending";

    const checkoutUrl =
      data?.checkout_url ||
      data?.checkoutUrl ||
      data?.url ||
      null;

    /**
     * =====================================================
     * 13. ATUALIZAR TOPUP
     * =====================================================
     */

    await topupRef.update({
      provider:
        "zumbopay",

      providerReference,

      providerPaymentId:
        paymentId,

      providerStatus:
        status,

      paymentMethod:
        paymentMethod,

      phone:
        customerPhone,

      amount:
        Number(
          numericAmount.toFixed(2)
        ),

      checkoutUrl:
        checkoutUrl,

      callbackUrl,

      updatedAt:
        FieldValue.serverTimestamp(),
    });

    console.log(
      "[PayGo] Pagamento ZumboPay criado:",
      {
        reference:
          providerReference,

        paymentId,

        status,

        checkoutUrl,
      }
    );

    /**
     * =====================================================
     * 14. RESPOSTA AO FRONTEND
     * =====================================================
     */

    return NextResponse.json(
      {
        success: true,

        provider:
          "zumbopay",

        topupId:
          reference,

        paymentId,

        reference:
          providerReference,

        status,

        checkoutUrl,

        method:
          paymentMethod,

        phone:
          customerPhone,

        message:
          checkoutUrl
            ? "Pagamento criado. Redirecione o cliente para o checkout."
            : "Pedido de pagamento enviado. Confirme no seu telemóvel.",

        data:
          providerData,
      },
      {
        status: 200,
      }
    );
  } catch (error: any) {
    console.error(
      "[PayGo] /api/payments/initiate error:",
      error
    );

    return NextResponse.json(
      {
        success: false,

        error:
          error?.message ||
          "Erro interno ao iniciar pagamento.",
      },
      {
        status: 500,
      }
    );
  }
}
