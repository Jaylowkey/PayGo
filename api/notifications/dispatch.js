import { deliverNotification, getDb, resolveTemplate, verifyInternalSecret } from "../lib/notifications.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Método não permitido." });
  if (!verifyInternalSecret(req)) return res.status(401).json({ success: false, error: "Não autorizado." });

  try {
    const { userId, event, data = {}, channels = null, title, body } = req.body || {};
    if (!userId || !event) return res.status(400).json({ success: false, error: "userId e event são obrigatórios." });
    const db = getDb();
    const snap = await db.collection("users").doc(String(userId)).get();
    if (!snap.exists) return res.status(404).json({ success: false, error: "Cliente não encontrado." });
    const user = { id: snap.id, ...snap.data(), ...data };
    const channel = Array.isArray(channels) && channels.length ? channels[0] : "in_app";
    const template = await resolveTemplate(event, channel, { title: title || event, body: body || "" });
    const result = await deliverNotification({ user, event, title: title || template.title, body: body || template.body, data, channels });
    await db.collection("notificationDeliveries").add({ userId: snap.id, event, channel: result.channel, success: !!result.success, error: result.error || null, createdAt: new Date() });
    return res.status(result.success ? 200 : 502).json({ success: !!result.success, result });
  } catch (error) {
    console.error("[notifications/dispatch]", error);
    return res.status(500).json({ success: false, error: "Falha ao processar notificação." });
  }
}
