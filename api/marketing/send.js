import { getDb, deliverNotification, resolveTemplate, verifyInternalSecret } from "../lib/notifications.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Método não permitido." });
  if (!verifyInternalSecret(req)) return res.status(401).json({ success: false, error: "Não autorizado." });

  try {
    const { campaignId } = req.body || {};
    if (!campaignId) return res.status(400).json({ success: false, error: "campaignId é obrigatório." });
    const db = getDb();
    const ref = db.collection("marketingCampaigns").doc(String(campaignId));
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: "Campanha não encontrada." });
    const campaign = snap.data();
    if (["sent", "processing"].includes(campaign.status)) return res.status(409).json({ success: false, error: "Campanha já está em processamento ou foi enviada." });

    await ref.update({ status: "processing", startedAt: new Date() });
    let usersQuery = db.collection("users");
    if (campaign.audience === "active") usersQuery = usersQuery.where("status", "==", "active");
    if (campaign.audience === "wallet") usersQuery = usersQuery.where("walletId", "!=", null);
    if (campaign.audience === "affiliate") usersQuery = usersQuery.where("role", "==", "affiliate");
    const users = await usersQuery.limit(500).get();
    const channels = campaign.channels || ["in_app"];
    const channel = channels[0] || "in_app";
    const template = await resolveTemplate("marketing_campaign", channel, { title: campaign.subject || campaign.name, body: campaign.message || "" });
    let delivered = 0, failed = 0;

    for (const userDoc of users.docs) {
      const user = { id: userDoc.id, ...userDoc.data() };
      const result = await deliverNotification({ user, event: "marketing_campaign", title: campaign.subject || template.title, body: campaign.message || template.body, data: { campaignId: snap.id }, channels });
      if (result.success) delivered += 1; else failed += 1;
      await db.collection("notificationDeliveries").add({ campaignId: snap.id, userId: userDoc.id, event: "marketing_campaign", channel: result.channel, success: !!result.success, error: result.error || null, createdAt: new Date() });
    }

    await ref.update({ status: "sent", sent: users.size, delivered, failed, completedAt: new Date() });
    return res.status(200).json({ success: true, sent: users.size, delivered, failed });
  } catch (error) {
    console.error("[marketing/send]", error);
    return res.status(500).json({ success: false, error: "Falha no envio da campanha." });
  }
}
