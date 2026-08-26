import { Resend } from "resend";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const FROM_EMAIL = process.env.PAYGO_FROM_EMAIL || "PayGo Moçambique <noreply@paygo.co.mz>";
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://paygo.co.mz";

function adminDb() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT em falta.");
    const serviceAccount = JSON.parse(raw);
    if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    initializeApp({ credential: cert(serviceAccount) });
  }
  try { return getFirestore(getApps()[0], "paygodb"); } catch { return getFirestore(); }
}

export function getDb() { return adminDb(); }

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#039;" }[c]));
}

export function renderTemplate(value, data = {}) {
  return String(value ?? "").replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
    const parts = key.split(".");
    let current = data;
    for (const part of parts) current = current?.[part];
    return current == null ? "" : String(current);
  });
}

function normalizePhone(value) {
  let phone = String(value || "").replace(/\D/g, "");
  if (phone.startsWith("00")) phone = phone.slice(2);
  if (phone && !phone.startsWith("258")) phone = `258${phone}`;
  return phone;
}

function preferredChannel(user, event, routing, globalPrefs) {
  const prefs = user?.notificationPreferences || user?.notifications || {};
  const candidates = routing[event] || ["in_app"];
  return candidates.find(channel => {
    if (channel === "in_app") return globalPrefs.inapp !== false && prefs.inApp !== false;
    if (channel === "email") return globalPrefs.email !== false && prefs.email !== false && !!user?.email;
    if (channel === "whatsapp") return globalPrefs.whatsapp !== false && prefs.whatsapp !== false && !!normalizePhone(user?.phone || user?.phoneNumber || user?.whatsapp);
    if (channel === "push") return globalPrefs.push !== false && prefs.push !== false && !!(user?.fcmToken || user?.pushToken);
    return false;
  }) || "in_app";
}

async function sendEmail({ to, subject, body, event }) {
  if (!process.env.RESEND_API_KEY || !to) return { success: false, skipped: true, reason: "email_not_configured_or_missing_recipient" };
  const resend = new Resend(process.env.RESEND_API_KEY);
  const html = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;padding:28px;color:#172033"><div style="font-size:24px;font-weight:800;margin-bottom:20px">Pay<span style="color:#2563eb">Go</span></div><div style="white-space:pre-wrap;line-height:1.65">${escapeHtml(body)}</div><p style="margin-top:28px;color:#64748b;font-size:12px">${SITE_URL}</p></div>`;
  const { data, error } = await resend.emails.send({ from: FROM_EMAIL, to: [to], subject, html, text: body, headers: { "X-PayGo-Event": event || "notification" } });
  if (error) return { success: false, error: error.message };
  return { success: true, id: data?.id || null };
}

async function sendWhatsApp({ phone, body }) {
  const url = process.env.WHATSAPP_API_URL;
  const token = process.env.WHATSAPP_API_TOKEN;
  if (!url || !token || !phone) return { success: false, skipped: true, reason: "whatsapp_not_configured_or_missing_recipient" };
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ to: normalizePhone(phone), type: "text", text: { body } }), signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  if (!response.ok) return { success: false, error: `WhatsApp HTTP ${response.status}`, providerResponse: text.slice(0, 500) };
  return { success: true, providerResponse: text.slice(0, 500) };
}

async function sendPush({ token, title, body, data }) {
  const serverKey = process.env.FIREBASE_FCM_SERVER_KEY;
  if (!serverKey || !token) return { success: false, skipped: true, reason: "push_not_configured_or_missing_token" };
  const response = await fetch("https://fcm.googleapis.com/fcm/send", { method: "POST", headers: { Authorization: `key=${serverKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ to: token, notification: { title, body }, data: data || {} }), signal: AbortSignal.timeout(20000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.failure) return { success: false, error: result?.results?.[0]?.error || `FCM HTTP ${response.status}` };
  return { success: true, providerResponse: result };
}

export async function deliverNotification({ user, event, title, body, data = {}, channels = null }) {
  const db = adminDb();
  const settingsSnap = await db.collection("settings").doc("notifications").get();
  const settings = settingsSnap.exists ? settingsSnap.data() : {};
  const routing = settings.routing || {};
  const globalPrefs = { email: settings.prefemail !== false, whatsapp: settings.prefwhatsapp !== false, push: settings.prefpush !== false, inapp: settings.prefinapp !== false };
  const channel = (channels || routing[event] || ["in_app"])[0] || preferredChannel(user, event, routing, globalPrefs);
  const payload = { title: renderTemplate(title, user), body: renderTemplate(body, user), event, data };
  let result;
  if (channel === "email") result = await sendEmail({ to: user?.email, subject: payload.title, body: payload.body, event });
  else if (channel === "whatsapp") result = await sendWhatsApp({ phone: user?.phone || user?.phoneNumber || user?.whatsapp, body: payload.body });
  else if (channel === "push") result = await sendPush({ token: user?.fcmToken || user?.pushToken, title: payload.title, body: payload.body, data });
  else {
    const ref = await db.collection("notifications").add({ userId: user?.id || null, event, title: payload.title, body: payload.body, data, channel: "in_app", read: false, createdAt: new Date() });
    result = { success: true, id: ref.id };
  }
  return { channel, ...result };
}

export async function resolveTemplate(event, channel = "in_app", fallback = {}) {
  const db = adminDb();
  const snap = await db.collection("notificationTemplates").where("event", "==", event).where("channel", "==", channel).where("active", "==", true).limit(1).get();
  if (!snap.empty) return snap.docs[0].data();
  return fallback;
}

export function verifyInternalSecret(req) {
  const configured = process.env.PAYGO_NOTIFICATION_SECRET;
  if (!configured) return false;
  const supplied = req.headers["x-paygo-notification-secret"] || req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return supplied === configured;
}
