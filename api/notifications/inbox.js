const { routeNotification } = require('../lib/notification-router');

/**
 * Internal-compatible notification helper. The route is deliberately kept
 * behind the existing API surface; do not expose provider credentials here.
 */
async function createInAppNotification({ userId, event, title, body, data = {}, db }) {
  if (!db) throw new Error('db is required');
  const notification = {
    userId,
    event,
    title,
    body,
    data,
    channel: 'in_app',
    read: false,
    createdAt: new Date(),
  };

  if (typeof db.collection === 'function') {
    const ref = db.collection('notifications');
    if (typeof ref.add === 'function') {
      const doc = await ref.add(notification);
      return { id: doc.id, ...notification };
    }
  }

  throw new Error('Unsupported database adapter');
}

module.exports = { createInAppNotification, routeNotification };
