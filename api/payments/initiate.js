import {
  createCharge,
  createPayment,
  normalizePhone,
  normalizePaymentMethod,
} from "../lib/services/zumbopay.js";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.setHeader("Content-Type", "application/json");
}

function json(res, status, data) {
  return res.status(status).json(data);
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      error: "Método não permitido.",
      allowed: ["POST"],
    });
  }

  // IMPORTANTE:
  // fica fora do try para também estar disponível no catch
  const body = req.body || {};

  const requestReference =
    body.reference ||
    body.orderId ||
    null;

  try {
    console.log(
      "========================================"
    );

    console.log(
      "🔥 PAYGO → ZUMBOPAY"
    );

    console.log(
      "POST /api/payments/initiate"
    );

    console.log(
      "========================================"
    );

    console.log("Body recebido:", {
      amount: body.amount,
      method: body.method,
      phone: body.phone ? "***" : null,
      reference: requestReference,
      customerName:
        body.customerName || null,
    });

    // =====================================================
    // VALORES
    // =====================================================

    const amount = Number(body.amount);

    const method =
      normalizePaymentMethod(
        body.method
      );

    const phone =
      body.phone || "";

    const reference =
      requestReference ||
      `PAYGO-${Date.now()}`;

    // =====================================================
    // VALIDAÇÃO
    // =====================================================

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return json(res, 400, {
        success: false,
        error:
          "O valor do pagamento é inválido.",
      });
    }

    if (amount < 10) {
      return json(res, 400, {
        success: false,
        error:
          "O depósito mínimo é de 10 MT.",
      });
    }

    // =====================================================
    // M-PESA / E-MOLA
    // =====================================================

    if (
      method === "mpesa" ||
      method === "emola"
    ) {
      if (!phone) {
        return json(res, 400, {
          success: false,
          error:
            "O número de telefone é obrigatório.",
        });
      }

      let normalizedPhone;

      try {
        normalizedPhone =
          normalizePhone(phone);
      } catch (error) {
        console.error(
          "❌ ERRO AO NORMALIZAR TELEFONE:",
          error
        );

        return json(res, 400, {
          success: false,
          error:
            error?.message ||
            "Número de telefone inválido.",
        });
      }

      const msisdn =
        normalizedPhone.replace(
          /^\+/,
          ""
        );

      // ===================================================
      // VALIDAR OPERADORA
      // ===================================================

      if (
        method === "mpesa" &&
        !/^2588[45]\d{7}$/.test(
          msisdn
        )
      ) {
        return json(res, 400, {
          success: false,
          error:
            "Para M-Pesa utilize um número 84 ou 85.",
        });
      }

      if (
        method === "emola" &&
        !/^2588[67]\d{7}$/.test(
          msisdn
        )
      ) {
        return json(res, 400, {
          success: false,
          error:
            "Para e-Mola utilize um número 86 ou 87.",
        });
      }

      console.log(
        "========================================"
      );

      console.log(
        "📲 INICIANDO STK ZUMBOPAY"
      );

      console.log(
        "Método:",
        method
      );

      console.log(
        "Valor:",
        amount
      );

      console.log(
        "Telefone:",
        msisdn
      );

      console.log(
        "Referência:",
        reference
      );

      console.log(
        "========================================"
      );

      // ===================================================
      // CHARGE
      // ===================================================

      const charge =
        await createCharge({
          amount,
          phone: normalizedPhone,

          customerName:
            body.customerName ||
            "Cliente PayGo",

          sourceId:
            String(reference),

          method,
        });

      console.log(
        "========================================"
      );

      console.log(
        "✅ RESPOSTA ZUMBOPAY"
      );

      console.log(
        JSON.stringify(
          {
            success:
              charge?.success,

            reference:
              charge?.reference,

            paymentId:
              charge?.paymentId,

            status:
              charge?.status,

            method:
              charge?.method,

            amount:
              charge?.amount,
          },
          null,
          2
        )
      );

      console.log(
        "========================================"
      );

      if (
        !charge ||
        charge.success !== true
      ) {
        return json(res, 400, {
          success: false,
          provider: "zumbopay",
          error:
            "A ZumboPay não conseguiu iniciar o pagamento.",
          reference,
          data: charge || null,
        });
      }

      return json(res, 200, {
        success: true,

        provider:
          "zumbopay",

        type:
          "stk_push",

        method,

        amount,

        phone:
          normalizedPhone,

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
          charge.status === "success"
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

          phone:
            normalizedPhone,
        },
      });
    }

    // =====================================================
    // CARTÃO
    // =====================================================

    if (method === "card") {
      console.log(
        "💳 INICIANDO CHECKOUT ZUMBOPAY"
      );

      const payment =
        await createPayment({
          amount,

          reference,

          title:
            `Depósito PayGo ${reference}`,

          description:
            `Depósito PayGo ${reference}`,

          method: "card",

          phone:
            phone || undefined,

          callbackUrl:
            process.env
              .ZUMBOPAY_WEBHOOK_URL ||
            "https://paygo.co.mz/api/webhooks/zumbopay",

          returnUrl:
            process.env
              .PAYGO_PAYMENT_RETURN_URL ||
            "https://paygo.co.mz/dashboard",
        });

      console.log(
        "Resposta checkout:",
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
          provider: "zumbopay",
          error:
            "Não foi possível criar o checkout da ZumboPay.",
          reference,
          data:
            payment || null,
        });
      }

      return json(res, 200, {
        success: true,

        provider:
          "zumbopay",

        type:
          "checkout",

        method: "card",

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
      });
    }

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

    console.error(
      "========================================"
    );

    console.error(
      "❌ ERRO PAYGO → ZUMBOPAY"
    );

    console.error(
      "========================================"
    );

    console.error(
      "Mensagem:",
      error?.message
    );

    console.error(
      "Status:",
      error?.status
    );

    console.error(
      "Código:",
      error?.code
    );

    console.error(
      "Dados ZumboPay:",
      error?.data
    );

    console.error(
      "Stack:",
      error?.stack
    );

    console.error(
      "========================================"
    );

    return json(res, 500, {
      success: false,

      provider:
        "zumbopay",

      error:
        error?.message ||
        "Erro interno ao processar pagamento.",

      code:
        error?.code ||
        null,

      reference:
        requestReference,

      // Em produção não devolvemos dados
      // internos completos ao navegador.
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
