/**
 * =========================================================
 * PayGo → ZumboPay
 * POST /api/payments/initiate
 * =========================================================
 *
 * Suporta:
 * - M-Pesa STK
 * - e-Mola STK
 * - Card / Checkout
 *
 * IMPORTANTE:
 * Este projeto usa Vercel Serverless Functions,
 * NÃO Next.js App Router.
 *
 * =========================================================
 */

import {
  createCharge,
  createPayment,
  normalizePhone,
  normalizePaymentMethod,
} from "../lib/services/zumbopay.js";


// =========================================================
// CORS
// =========================================================

function setCors(res) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  res.setHeader(
    "Content-Type",
    "application/json"
  );
}


// =========================================================
// JSON RESPONSE
// =========================================================

function json(res, status, data) {
  return res.status(status).json(data);
}


// =========================================================
// REQUEST HANDLER
// =========================================================

export default async function handler(req, res) {
  setCors(res);

  // =======================================================
  // OPTIONS / PREFLIGHT
  // =======================================================

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }


  // =======================================================
  // SOMENTE POST
  // =======================================================

  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      error: "Método não permitido.",
      allowed: ["POST"],
    });
  }


  // =======================================================
  // LOG INICIAL
  // =======================================================

  console.log(
    "========================================"
  );

  console.log(
    "🔥 PAYGO /api/payments/initiate"
  );

  console.log(
    "🔥 REQUEST RECEIVED"
  );

  console.log(
    "========================================"
  );


  try {
    // =====================================================
    // 1. LER BODY
    // =====================================================

    const body =
      req.body ||
      {};

    console.log(
      "PAYGO REQUEST BODY:",
      {
        amount: body.amount,
        method: body.method,
        phone:
          body.phone
            ? "***"
            : undefined,
        orderId:
          body.orderId,
        reference:
          body.reference,
      }
    );


    // =====================================================
    // 2. CAMPOS
    // =====================================================

    const amount =
      Number(
        body.amount
      );

    const method =
      normalizePaymentMethod(
        body.method
      );

    const rawPhone =
      body.phone ||
      "";

    const orderId =
      body.orderId ||
      null;

    const reference =
      body.reference ||
      orderId ||
      `PAYGO-${Date.now()}`;

    const description =
      body.description ||
      `Depósito PayGo ${reference}`;


    // =====================================================
    // 3. VALIDAR VALOR
    // =====================================================

    if (
      !Number.isFinite(amount)
    ) {
      return json(res, 400, {
        success: false,
        error:
          "O valor informado é inválido.",
      });
    }


    if (amount <= 0) {
      return json(res, 400, {
        success: false,
        error:
          "O valor deve ser maior que zero.",
      });
    }


    // =====================================================
    // 4. DEPÓSITO MÍNIMO
    // =====================================================

    if (amount < 10) {
      return json(res, 400, {
        success: false,
        error:
          "O depósito mínimo é de 10 MT.",
      });
    }


    // =====================================================
    // 5. M-PESA / E-MOLA
    // =====================================================

    if (
      method === "mpesa" ||
      method === "emola"
    ) {

      // ---------------------------------------------------
      // TELEFONE OBRIGATÓRIO
      // ---------------------------------------------------

      if (!rawPhone) {
        return json(res, 400, {
          success: false,
          error:
            "O número de telefone é obrigatório.",
        });
      }


      // ---------------------------------------------------
      // NORMALIZAR TELEFONE
      // ---------------------------------------------------

      let phone;

      try {
        phone =
          normalizePhone(
            rawPhone
          );
      } catch (error) {
        return json(res, 400, {
          success: false,
          error:
            error?.message ||
            "Número de telefone inválido.",
        });
      }


      // ---------------------------------------------------
      // MSISDN
      // ---------------------------------------------------

      const msisdn =
        phone.replace(
          /^\+/,
          ""
        );


      // ---------------------------------------------------
      // VALIDAR OPERADORA
      // ---------------------------------------------------

      const isMpesa =
        /^2588[45]\d{7}$/.test(
          msisdn
        );

      const isEmola =
        /^2588[67]\d{7}$/.test(
          msisdn
        );


      if (
        method === "mpesa" &&
        !isMpesa
      ) {
        return json(res, 400, {
          success: false,
          error:
            "Para M-Pesa utilize um número 84 ou 85.",
        });
      }


      if (
        method === "emola" &&
        !isEmola
      ) {
        return json(res, 400, {
          success: false,
          error:
            "Para e-Mola utilize um número 86 ou 87.",
        });
      }


      // ---------------------------------------------------
      // LOG
      // ---------------------------------------------------

      console.log(
        "========================================"
      );

      console.log(
        "PAYGO → ZUMBOPAY STK"
      );

      console.log(
        "========================================"
      );

      console.log(
        "Amount:",
        amount
      );

      console.log(
        "Method:",
        method
      );

      console.log(
        "Phone:",
        msisdn
      );

      console.log(
        "Reference:",
        reference
      );

      console.log(
        "========================================"
      );


      // ---------------------------------------------------
      // CREATE CHARGE
      // ---------------------------------------------------

      const charge =
        await createCharge({
          amount,

          phone,

          customerName:
            body.customerName ||
            "Cliente PayGo",

          sourceId:
            String(
              reference
            ),

          method,
        });


      // ---------------------------------------------------
      // RESPOSTA
      // ---------------------------------------------------

      console.log(
        "ZUMBOPAY RESPONSE:",
        {
          success:
            charge?.success,

          reference:
            charge?.reference,

          status:
            charge?.status,
        }
      );


      if (
        !charge ||
        charge.success !== true
      ) {
        return json(res, 400, {
          success: false,

          provider:
            "zumbopay",

          error:
            "A ZumboPay não conseguiu iniciar o pagamento.",

          reference,

          data:
            charge || null,
        });
      }


      // ---------------------------------------------------
      // STK SUCCESS / PENDING
      // ---------------------------------------------------

      return json(res, 200, {
        success: true,

        provider:
          "zumbopay",

        type:
          "stk_push",

        method,

        amount,

        phone,

        reference:
          charge.reference ||
          reference,

        paymentId:
          charge.paymentId ||
          null,

        status:
          charge.status ||
          "pending",

        message:
          charge.status ===
          "success"

            ? "Pagamento confirmado."

            : "Pedido enviado. Confirme o pagamento no seu telemóvel usando o PIN.",

        data: {
          reference:
            charge.reference ||
            reference,

          paymentId:
            charge.paymentId ||
            null,

          status:
            charge.status ||
            "pending",

          method,

          amount,

          phone,
        },
      });
    }


    // =====================================================
    // 6. CARTÃO
    // =====================================================

    if (
      method === "card"
    ) {

      console.log(
        "========================================"
      );

      console.log(
        "PAYGO → ZUMBOPAY CHECKOUT"
      );

      console.log(
        "========================================"
      );

      console.log(
        "Amount:",
        amount
      );

      console.log(
        "Reference:",
        reference
      );


      const payment =
        await createPayment({
          amount,

          reference,

          title:
            `Depósito PayGo ${reference}`,

          description,

          method:
            "card",

          phone:
            rawPhone ||
            undefined,

          callbackUrl:
            process.env.ZUMBOPAY_WEBHOOK_URL ||
            "https://paygo.co.mz/api/webhooks/zumbopay",

          returnUrl:
            process.env.PAYGO_PAYMENT_RETURN_URL ||
            "https://paygo.co.mz/dashboard",
        });


      console.log(
        "ZUMBOPAY CHECKOUT RESPONSE:",
        {
          success:
            payment?.success,

          reference:
            payment?.reference,

          checkoutUrl:
            payment?.checkoutUrl,
        }
      );


      if (
        !payment ||
        payment.success !== true
      ) {
        return json(res, 400, {
          success: false,

          provider:
            "zumbopay",

          error:
            "Não foi possível criar o checkout da ZumboPay.",

          reference,

          data:
            payment || null,
        });
      }


      if (
        !payment.checkoutUrl
      ) {
        return json(res, 502, {
          success: false,

          provider:
            "zumbopay",

          error:
            "A ZumboPay não devolveu o checkout_url.",

          reference,
        });
      }


      return json(res, 200, {
        success: true,

        provider:
          "zumbopay",

        type:
          "checkout",

        method:
          "card",

        amount,

        reference:
          payment.reference ||
          reference,

        paymentId:
          payment.paymentId ||
          null,

        status:
          payment.status ||
          "pending",

        checkoutUrl:
          payment.checkoutUrl,

        message:
          "Checkout da ZumboPay criado com sucesso.",

        data: {
          reference:
            payment.reference ||
            reference,

          paymentId:
            payment.paymentId ||
            null,

          status:
            payment.status ||
            "pending",

          checkoutUrl:
            payment.checkoutUrl,
        },
      });
    }


    // =====================================================
    // 7. MÉTODO NÃO SUPORTADO
    // =====================================================

    return json(res, 400, {
      success: false,

      error:
        "Método de pagamento não suportado.",

      supportedMethods: [
        "mpesa",
        "emola",
        "card",
      ],
    });

  } catch (error) {

    // =====================================================
    // ERRO
    // =====================================================

    console.error(
      "========================================"
    );

    console.error(
      "❌ PAYGO PAYMENT INITIATE ERROR"
    );

    console.error(
      "========================================"
    );

    console.error(
      "Message:",
      error?.message
    );

    console.error(
      "Status:",
      error?.status
    );

    console.error(
      "Code:",
      error?.code
    );

    console.error(
      "Data:",
      error?.data
    );

    console.error(
      "Stack:",
      error?.stack
    );


    const status =
      Number(
        error?.status
      ) >= 400 &&
      Number(
        error?.status
      ) < 600

        ? Number(
            error.status
          )

        : 500;


    return json(res, status, {
      success: false,

      provider:
        "zumbopay",

      error:
        error?.message ||
        "Erro interno ao iniciar pagamento.",

      code:
        error?.code ||
        null,

      reference:
        body?.reference ||
        body?.orderId ||
        null,

      ...(process.env.NODE_ENV !==
      "production"
        ? {
            details:
              error?.data ||
              null,
          }
        : {}),
    });
  }
}
