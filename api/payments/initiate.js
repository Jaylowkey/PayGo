import { NextRequest, NextResponse } from "next/server";
import { createCharge, createPayment, normalizePhone } from "@/lib/services/zumbopay";

export const runtime = "nodejs";

interface InitiatePaymentBody {
  amount: number;
  method: "mpesa" | "emola" | "card";
  phone?: string;
  orderId?: string;
  reference?: string;
  description?: string;
}

export async function POST(request: NextRequest) {
  try {
    // =========================================================
    // 1. LER BODY
    // =========================================================

    const body = (await request.json()) as InitiatePaymentBody;

    const amount = Number(body.amount);
    const method = String(body.method || "").toLowerCase() as
      | "mpesa"
      | "emola"
      | "card";

    const phone = body.phone
      ? normalizePhone(body.phone)
      : "";

    const reference =
      body.orderId ||
      body.reference ||
      `PAYGO-${Date.now()}`;

    const description =
      body.description ||
      `Depósito PayGo ${reference}`;

    // =========================================================
    // 2. VALIDAR VALOR
    // =========================================================

    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        {
          success: false,
          error: "Valor do pagamento inválido.",
        },
        { status: 400 }
      );
    }

    // PayGo: depósito mínimo de 10 MT
    if (amount < 10) {
      return NextResponse.json(
        {
          success: false,
          error: "O depósito mínimo é de 10 MT.",
        },
        { status: 400 }
      );
    }

    // =========================================================
    // 3. VALIDAR MÉTODO
    // =========================================================

    if (!["mpesa", "emola", "card"].includes(method)) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Método de pagamento inválido. Use M-Pesa, e-Mola ou cartão.",
        },
        { status: 400 }
      );
    }

    // =========================================================
    // 4. M-PESA / E-MOLA
    // =========================================================
    //
    // STK PUSH
    //
    // O cliente informa o número de telefone.
    // A ZumboPay envia o pedido de pagamento para o telefone.
    //
    // Endpoint utilizado internamente pelo service:
    //
    // POST /charges
    //
    // =========================================================

    if (method === "mpesa" || method === "emola") {
      if (!phone) {
        return NextResponse.json(
          {
            success: false,
            error:
              "O número de telefone é obrigatório para M-Pesa/e-Mola.",
          },
          { status: 400 }
        );
      }

      // Validar número moçambicano
      if (!/^2588[4-7]\d{7}$/.test(phone)) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Número inválido. Use um número M-Pesa/e-Mola válido.",
          },
          { status: 400 }
        );
      }

      console.log("========================================");
      console.log("PAYGO → ZUMBOPAY STK");
      console.log("========================================");
      console.log("Reference:", reference);
      console.log("Amount:", amount);
      console.log("Method:", method);
      console.log("Phone:", phone);
      console.log("========================================");

      const charge = await createCharge({
        amount,
        phone,
        customerName: "Cliente PayGo",
        sourceId: reference,
        method,
      });

      if (!charge.success) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Não foi possível iniciar o pagamento.",
          },
          { status: 400 }
        );
      }

      return NextResponse.json({
        success: true,

        type: "stk_push",

        provider: "zumbopay",

        reference:
          charge.reference || reference,

        paymentId:
          charge.paymentId || null,

        status:
          charge.status || "pending",

        amount,

        method,

        phone,

        message:
          charge.status === "success"
            ? "Pagamento confirmado."
            : "Pedido enviado. Confirme o pagamento no seu telemóvel usando o PIN.",

        data: {
          reference:
            charge.reference || reference,

          paymentId:
            charge.paymentId || null,

          status:
            charge.status || "pending",

          method,

          phone,
        },
      });
    }

    // =========================================================
    // 5. CARTÃO
    // =========================================================
    //
    // Para cartão usamos o checkout hospedado da ZumboPay.
    //
    // =========================================================

    if (method === "card") {
      console.log("========================================");
      console.log("PAYGO → ZUMBOPAY CHECKOUT");
      console.log("========================================");
      console.log("Reference:", reference);
      console.log("Amount:", amount);
      console.log("Method:", method);
      console.log("========================================");

      const payment = await createPayment({
        amount,

        reference,

        title:
          `Depósito PayGo ${reference}`,

        description,

        channels: ["card"],

        method: "card",
      });

      if (!payment.success) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Não foi possível criar o pagamento por cartão.",
          },
          { status: 400 }
        );
      }

      if (!payment.checkoutUrl) {
        return NextResponse.json(
          {
            success: false,
            error:
              "A ZumboPay não devolveu o endereço do checkout.",
          },
          { status: 502 }
        );
      }

      return NextResponse.json({
        success: true,

        type: "checkout",

        provider: "zumbopay",

        reference:
          payment.reference || reference,

        paymentId:
          payment.paymentId || null,

        status:
          payment.status || "pending",

        amount,

        method,

        checkoutUrl:
          payment.checkoutUrl,

        message:
          "Redirecione para a página segura da ZumboPay.",

        data: {
          reference:
            payment.reference || reference,

          paymentId:
            payment.paymentId || null,

          status:
            payment.status || "pending",

          checkoutUrl:
            payment.checkoutUrl,

          method,
        },
      });
    }

    // =========================================================
    // 6. MÉTODO NÃO TRATADO
    // =========================================================

    return NextResponse.json(
      {
        success: false,
        error: "Método de pagamento não suportado.",
      },
      { status: 400 }
    );
  } catch (error: any) {
    console.error(
      "========================================"
    );

    console.error(
      "PAYGO PAYMENT INITIATE ERROR"
    );

    console.error(
      "========================================"
    );

    console.error(error);

    const status =
      Number(error?.status) >= 400 &&
      Number(error?.status) < 600
        ? Number(error.status)
        : 500;

    return NextResponse.json(
      {
        success: false,

        error:
          error?.message ||
          "Erro ao iniciar pagamento.",

        provider:
          "zumbopay",

        code:
          error?.code || null,
      },
      { status }
    );
  }
}
