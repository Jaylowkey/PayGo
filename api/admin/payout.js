import crypto from "crypto";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { requireZumboAdmin } from "./zumbopay/login.js";

const ZUMBO_URL = (process.env.ZUMBOPAY_API_URL || "https://zumbopay.com/api/public/v1").replace(/\/+$/, "");
const NETSHOP_URL = (process.env.NETSHOP_API_URL || "https://www.netshop.co.mz/api/v1").replace(/\/+$/, "");

// Regra de negócio PayGo: o payout nunca pode ser inferior a 100 MT.
// Uma variável de ambiente não pode reduzir este limite.
const configuredMinimum = Number(process.env.PAYOUT_MIN_MZN);
const MIN_PAYOUT = Number.isFinite(configuredMinimum) ? Math.max(100, configuredMinimum) : 100;

function getFirebase() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT em falta.");
    const account = JSON.parse(raw);
    if (account.private_key) account.private_key = account.private_key.replace(/\\n/g, "\n");
    initializeApp({ credential: cert(account) });
  }
  const app = getApps()[0];
  let db;
  try { db = getFirestore(app, "paygodb"); } catch { db = getFirestore(app); }
  return { auth: getAuth(app), db };
}

function money(value) {
  const n = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function method(value) {
  const v = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return ["mpesa", "emola", "mkesh", "card"].includes(v) ? v : "";
}

function phone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (/^258\d{9}$/.test(digits)) return `+${digits}`;
  if (/^\d{9}$/.test(digits)) return `+258${digits}`;
  return "";
}

function netshopWallet(m) {
  return process.env[`NETSHOP_WALLET_${m.toUpperCase()}`] || process.env.NETSHOP_WALLET_ID || "";
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text || `HTTP ${response.status}` }; }
  if (!response.ok) {
    const err = new Error(String(data?.error?.message || data?.message || data?.error || `HTTP ${response.status}`));
    err.status = response.status;
    err.code = data?.error?.code || data?.code || null;
    throw err;
  }
  return data?.data || data;
}

function validateCommon(body) {
  const amount = money(body.amount);
  const m = method(body.method);
  const destination = phone(body.destination || body.phone || body.msisdn);

  if (amount < MIN_PAYOUT) {
    throw new Error(`O valor mínimo para payout é 100,00 MT.`);
  }
  if (!m || !/^\+258\d{9}$/.test(destination)) {
    throw new Error("Método ou número de destino inválido.");
  }

  return { amount, m, destination };
}

async function createZumbo(body) {
  const apiKey = process.env.ZUMBOPAY_API_KEY;
  const merchantId = process.env.ZUMBOPAY_MERCHANT_ID;
  if (!apiKey || !merchantId) throw new Error("Credenciais ZumboPay não configuradas.");

  const { amount, m, destination } = validateCommon(body);
  const walletId = String(body.walletId || body.wallet_id || "").trim();
  if (!walletId) throw new Error("Selecione uma wallet ZumboPay.");

  const idempotencyKey = String(body.idempotencyKey || `paygo-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`);
  const payout = await requestJson(`${ZUMBO_URL}/payouts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Merchant-Id": merchantId,
      "Idempotency-Key": idempotencyKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      wallet_id: walletId,
      amount,
      method: m,
      destination,
      ...(body.notes ? { notes: String(body.notes).slice(0, 500) } : {}),
    }),
  });

  return {
    id: payout.id || null,
    reference: payout.reference || null,
    providerReference: payout.provider_reference || null,
    provider: "zumbopay",
    method: payout.method || m,
    destination: payout.destination || destination,
    amount: money(payout.amount ?? amount),
    fee: money(payout.fee_amount),
    currency: payout.currency || "MZN",
    status: String(payout.status || "pending").toUpperCase(),
    walletId,
  };
}

async function createNetshop(body) {
  const apiKey = process.env.NETSHOP_API_KEY;
  if (!apiKey) throw new Error("NETSHOP_API_KEY não configurada.");

  const { amount, m, destination } = validateCommon(body);
  const walletId = netshopWallet(m);
  if (!walletId) throw new Error(`Wallet NetShop de ${m} não configurada.`);

  const reference = String(body.reference || `PG-PAYOUT-${Date.now()}`).trim();
  const idempotencyKey = String(body.idempotencyKey || `paygo-${reference}-${crypto.randomBytes(6).toString("hex")}`);

  const payout = await requestJson(`${NETSHOP_URL}/payouts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Wallet-ID": String(walletId),
      "Idempotency-Key": idempotencyKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ amount, currency: "MZN", method: m, msisdn: destination, reference }),
  });

  return {
    id: payout.id || null,
    reference: payout.reference || reference,
    providerReference: payout.provider_reference || payout.payout_id || null,
    provider: "netshop",
    method: payout.method || m,
    destination: payout.msisdn || destination,
    amount: money(payout.amount ?? amount),
    fee: money(payout.fee || payout.fee_amount),
    currency: payout.currency || "MZN",
    status: String(payout.status || "PROCESSING").toUpperCase(),
    walletId,
  };
}

function serialize(doc, provider) {
  const d = doc.data() || {};
  const created = d.createdAt?.toDate ? d.createdAt.toDate().toISOString() : (d.createdAt || null);
  const updated = d.updatedAt?.toDate ? d.updatedAt.toDate().toISOString() : (d.updatedAt || created);
  return { ...d, id: doc.id, provider: d.provider || provider, amount: money(d.amount), createdAt: created, updatedAt: updated };
}

async function history(provider) {
  const { db } = getFirebase();
  const collection = provider === "netshop" ? "netshop_payouts" : "zumbopay_payouts";
  try {
    const snap = await db.collection(collection).orderBy("createdAt", "desc").limit(200).get();
    return snap.docs.map(d => serialize(d, provider));
  } catch (error) {
    console.warn(`[PayGo Admin Payout] history ${provider}`, error?.message || error);
    return [];
  }
}

async function persist(provider, payout, body) {
  const { db } = getFirebase();
  const collection = provider === "netshop" ? "netshop_payouts" : "zumbopay_payouts";
  const id = String(payout.reference || payout.id || `${provider}-${Date.now()}`).replace(/\//g, "_");
  await db.collection(collection).doc(id).set({
    ...payout,
    provider,
    holder: body.holder ? String(body.holder).slice(0, 160) : null,
    notes: body.notes ? String(body.notes).slice(0, 500) : null,
    createdAt: new Date(),
    updatedAt: new Date(),
    source: "paygo-admin-unified-payout",
  }, { merge: true });
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!(await requireZumboAdmin(req))) {
    return res.status(401).json({ success: false, error: "Acesso administrativo necessário." });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

  try {
    if (req.method === "GET") {
      const provider = String(req.query?.provider || "all").toLowerCase();
      if (!["all", "netshop", "zumbopay"].includes(provider)) {
        return res.status(400).json({ success: false, error: "Provider inválido." });
      }

      const [netshop, zumbopay] = await Promise.all([
        provider === "all" || provider === "netshop" ? history("netshop") : [],
        provider === "all" || provider === "zumbopay" ? history("zumbopay") : [],
      ]);

      const payouts = [...netshop, ...zumbopay].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      return res.status(200).json({
        success: true,
        payouts,
        minPayout: MIN_PAYOUT,
        providers: { netshop: Boolean(process.env.NETSHOP_API_KEY), zumbopay: Boolean(process.env.ZUMBOPAY_API_KEY) },
      });
    }

    if (req.method !== "POST") return res.status(405).json({ success: false, error: "Método não permitido." });

    const provider = String(body.provider || "netshop").toLowerCase();
    if (!["netshop", "zumbopay"].includes(provider)) return res.status(400).json({ success: false, error: "Provider inválido." });

    const payout = provider === "zumbopay" ? await createZumbo(body) : await createNetshop(body);
    await persist(provider, payout, body);

    const { db } = getFirebase();
    await db.collection("admin_audit_logs").add({
      adminAction: "PAYOUT_CREATED",
      provider,
      payoutId: payout.id || null,
      reference: payout.reference || null,
      amount: payout.amount,
      method: payout.method,
      destination: payout.destination,
      createdAt: new Date(),
    });

    return res.status(201).json({ success: true, payout });
  } catch (error) {
    console.error("[PayGo Admin Payout]", error);
    return res.status(error?.status >= 400 && error.status < 500 ? error.status : 502).json({
      success: false,
      error: error?.message || "Não foi possível processar o payout.",
      code: error?.code || null,
    });
  }
}
