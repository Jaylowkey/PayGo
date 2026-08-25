import crypto from "crypto";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const COOKIE_NAME = "paygo_admin_zp";
const MAX_AGE = 60 * 60 * 8;

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map(v => v.trim()).filter(Boolean).map(v => { const i = v.indexOf("="); return i < 0 ? [v, ""] : [v.slice(0, i), decodeURIComponent(v.slice(i + 1))]; }));
}

function sign(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function timingSafe(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function issueSession(secret) {
  const payload = `${Date.now() + MAX_AGE * 1000}.${crypto.randomBytes(18).toString("hex")}`;
  return `${payload}.${sign(payload, secret)}`;
}

function validSession(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return false;
  const [expires, nonce, signature] = parts;
  if (!/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
  return timingSafe(signature, sign(`${expires}.${nonce}`, secret));
}

function getFirebase() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT em falta.");
    const serviceAccount = JSON.parse(raw);
    if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    initializeApp({ credential: cert(serviceAccount) });
  }
  const app = getApps()[0];
  let db;
  try { db = getFirestore(app, "paygodb"); } catch { db = getFirestore(app); }
  return { auth: getAuth(app), db };
}

async function validFirebaseAdmin(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice(7).trim();
  if (!token) return false;

  try {
    const { auth, db } = getFirebase();
    const decoded = await auth.verifyIdToken(token);
    const snap = await db.collection("users").doc(decoded.uid).get();
    if (!snap.exists) return false;
    const role = String(snap.data()?.role || "").toLowerCase();
    return role === "admin" || role === "superadmin";
  } catch (error) {
    console.error("[PayGo Admin → ZumboPay] Firebase admin auth failed", error?.message || error);
    return false;
  }
}

export async function requireZumboAdmin(req) {
  if (await validFirebaseAdmin(req)) return true;

  // Compatibilidade com a sessão ZumboPay antiga.
  const secret = process.env.PAYGO_ADMIN_API_KEY || "";
  if (!secret) return false;
  const cookies = parseCookies(req.headers.cookie || "");
  return validSession(cookies[COOKIE_NAME], secret);
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(204).end();

  const secret = process.env.PAYGO_ADMIN_API_KEY || "";
  if (!secret) return res.status(500).json({ success: false, error: "PAYGO_ADMIN_API_KEY não configurada." });

  if (req.method === "GET") {
    return res.status(200).json({ success: true, authenticated: await requireZumboAdmin(req) });
  }

  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Método não permitido." });

  const supplied = String(req.body?.key || req.headers["x-paygo-admin-key"] || "");
  if (!timingSafe(supplied, secret)) return res.status(401).json({ success: false, error: "Credencial administrativa inválida." });

  const token = issueSession(secret);
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Strict`);
  return res.status(200).json({ success: true, authenticated: true });
}
