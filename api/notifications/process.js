import { getDb, deliverNotification, resolveTemplate, verifyInternalSecret } from "../lib/notifications.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!["POST", "GET"].includes(req.method)) return res.status(405).json({ success: false, error: "Método não permitido." });
  if (!verifyInternalSecret(req)) return res.status(401).json({ success: false, error: "Não autorizado." });

  try {
    const db = getDb();
    const now = new Date();
    const campaigns = await db.collection("marketingCampaigns").where("status", "==", "scheduled").limit(20).get();
    let processed = 0;
    let failed = 0;

    for (const campaignDoc of campaigns.docs) {
      const campaign = campaignDoc.data();
      const scheduleAt = campaign.scheduleAt?.toDate ? campaign.scheduleAt.toDate() : new Date(campaign.scheduleAt || 0);
      if (Number.isNaN(scheduleAt.getTime()) || scheduleAt > now) continue;

      await db.collection("marketingCampaigns").doc(campaignDoc.id).update({ status: "processing", startedAt: new Date() });
      try {
        let usersQuery = db.collection("users");
        if (campaign.audience === "active") usersQuery = usersQuery.where("status", "==", "active");
        if (campaign.audience === "wallet") usersQuery = usersQuery.where("walletId", "!=", null);
        if (campaign.audience === "affiliate") usersQuery = usersQuery.where("role", "==", "affiliate");
        const users = await usersQuery.limit(500).get();
        let sent = 0, delivered = 0, errors = 0;
        const channels = campaign.channels || ["in_app"];
        const channel = channels[0] || "in_app";
        const template = await resolveTemplate("marketing_campaign", channel, { title: campaign.subject || campaign.name, body: campaign.message || "" });

        for (const userDoc of users.docs) {
          const user = { id: userDoc.id, ...userDoc.data() };
          const result = await deliverNotification({ user, event: "marketing_campaign", title: campaign.subject || template.title, body: campaign.message || template.body, data: { campaignId: campaignDoc.id }, channels });
          sent += 1;
          if (result.success) delivered += 1; else errors += 1;
          await db.collection("notificationDeliveries").add({ campaignId: campaignDoc.id, userId: userDoc.id, event: "marketing_campaign", channel: result.channel, success: !!result.success, error: result.error || null, createdAt: new Date() });
        }

        await db.collection("marketingCampaigns").doc(campaignDoc.id).update({ status: "sent", sent, delivered, failed: errors, completedAt: new Date(), processedUsers: users.size });
        processed += 1;
      } catch (error) {
        failed += 1;
        console.error("[notifications/process] campaign", campaignDoc.id, error);
        await db.collection("marketingCampaigns").doc(campaignDoc.id).update({ status: "failed", error: String(error.message || error), failedAt: new Date() });
      }
    }

    return res.status(200).json({ success: true, processed, failed });
  } catch (error) {
    console.error("[notifications/process]", error);
    return res.status(500).json({ success: false, error: "Falha no processamento." });
  }
}
