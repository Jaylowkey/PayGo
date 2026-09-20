export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const key = String(process.env.FCM_VAPID_PUBLIC_KEY || '').trim();
  if (!key) return res.status(503).json({ error: 'FCM_VAPID_PUBLIC_KEY não configurada' });
  return res.status(200).json({ vapidKey: key });
}
