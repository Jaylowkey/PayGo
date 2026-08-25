import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { requireZumboAdmin } from "./login.js";

function getAdminDb() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT em falta.");
    const serviceAccount = JSON.parse(raw);
    if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    initializeApp({ credential: cert(serviceAccount) });
  }
  const app = getApps()[0];
  try { return getFirestore(app, "paygodb"); } catch { return getFirestore(app); }
}

function serialize(doc) {
  const data = doc.data() || {};
  const created = data.createdAt?.toDate ? data.createdAt.toDate() : data.createdAt;
  const updated = data.updatedAt?.toDate ? data.updatedAt.toDate() : data.updatedAt;
  return {
    ...data,
    id: doc.id,
    createdAt: created instanceof Date ? created.toISOString() : (created || null),
    updatedAt: updated instanceof Date ? updated.toISOString() : (updated || null),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Método não permitido." });
  if (!(await requireZumboAdmin(req))) return res.status(401).json({ success: false, error: "Acesso administrativo necessário." });

  try {
    const db = getAdminDb();
    const rawLimit = Number(req.query?.limit || 50);
    const pageLimit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50, 1), 100);
    const snap = await db.collection("zumbopay_payouts").orderBy("createdAt", "desc").limit(pageLimit).get();
    return res.status(200).json({ success: true, payouts: snap.docs.map(serialize), count: snap.size });
  } catch (error) {
    console.error("[PayGo Admin → ZumboPay] payout history", error);
    return res.status(500).json({ success: false, error: "Não foi possível carregar o histórico de payouts." });
  }
}
