/**
 * In-app notification persistence helper.
 * Kept outside /api so Vercel does not compile it as a Serverless Function.
 */
async function createInAppNotification({ userId, event, title, body, data = {}, db }) {
  if (!userId) throw new Error('userId is required');
  if (!db) throw new Error('db is required');
  const notification = { userId, event, title, body, data, channel: 'in_app', read: false, createdAt: new Date() };
  if (typeof db.collection === 'function') {
    const ref = db.collection('notifications');
    if (typeof ref.add === 'function') {
      const snap = await ref.add(notification);
      return { id: snap.id, ...notification };
    }
  }
  throw new Error('Unsupported database adapter');
}
module.exports = { createInAppNotification };
