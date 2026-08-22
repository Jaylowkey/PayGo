import { NextRequest, NextResponse } from "next/server";

const ZUMBOPAY_API_URL =
  process.env.ZUMBOPAY_API_URL || "https://zumbopay.com/api/v1";

const ZUMBOPAY_API_KEY = process.env.ZUMBOPAY_API_KEY;

function normalizePhone(phone: string) {
  let value = String(phone || "").replace(/\D/g, "");

  if (value.startsWith("258")) {
    value = value.slice(3);
  }

  if (value.length === 9 && value.startsWith("8")) {
    return `+258${value}`;
  }

  return phone;
}

export async function POST(req: NextRequest) {
  try {
    if (!ZUMBOPAY_API_KEY) {
      console.error("ZUMBOPAY_API_KEY não configurada");

      return NextResponse.json(
        {
          success: false,
          error: "Gateway de pagamento não configurado.",
        },
        { status: 500 }
      );
    }

    const body = await req.json();

    const {
      orderId,
      amount,
      method,
      phone,
      description,
    } = body;

    if (!orderId) {
      return NextResponse.json(
        {
          success: false,
          error: "orderId é obrigatório.",
        },
        { status: 400 }
      );
    }

    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount < 10) {
      return NextResponse.json(
        {
          success: false,
          error: "O valor mínimo do pagamento é 10 MT.",
        },
        { status: 400 }
      );
    }

    const allowedMethods = ["mpesa", "emola", "mkesh"];

    const paymentMethod = String(method || "mpesa").toLowerCase();

    if (!allowedMethods.includes(paymentMethod)) {
      return NextResponse.json(
        {
          success: false,
          error: "Método de pagamento inválido.",
        },
        { status: 400 }
      );
    }

    if (!phone) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Número de telefone não encontrado. Atualize o seu número no perfil.",
        },
        { status: 400 }
      );
    }

    const customerPhone = normalizePhone(phone);

    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.APP_URL ||
      req.nextUrl.origin;

    const callbackUrl = `${baseUrl}/api/webhooks/zumbopay`;

    const payload = {
      amount: Number(numericAmount.toFixed(2)),
      currency: "MZN",
      method: paymentMethod,
      customer: {
        phone: customerPhone,
      },
      callback_url: callbackUrl,
      reference: orderId,
      description:
        description || `Depósito Carteira PayGo: ${orderId}`,
    };

    console.log("[ZumboPay] Criando pagamento:", {
      orderId,
      amount: payload.amount,
      method: paymentMethod,
      phone: customerPhone,
    });

    const response = await fetch(`${ZUMBOPAY_API_URL}/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ZUMBOPAY_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Idempotency-Key": orderId,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    let data: any = {};

    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok) {
      console.error("[ZumboPay] Erro:", {
        status: response.status,
        data,
      });

      return NextResponse.json(
        {
          success: false,
          error:
            data?.message ||
            data?.error ||
            "Não foi possível iniciar o pagamento.",
          providerStatus: response.status,
          providerResponse: data,
        },
        { status: response.status }
      );
    }

    const paymentId = data?.id || data?.payment_id || data?.paymentId;
    const checkoutUrl =
      data?.checkout_url ||
      data?.checkoutUrl ||
      data?.data?.checkout_url ||
      data?.data?.checkoutUrl;

    return NextResponse.json({
      success: true,
      paymentId,
      checkoutUrl,
      status: data?.status || "pending",
      data,
    });
  } catch (error: any) {
    console.error("[ZumboPay] Erro interno:", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error?.message ||
          "Erro interno ao comunicar com o gateway de pagamento.",
      },
      { status: 500 }
    );
  }
}
