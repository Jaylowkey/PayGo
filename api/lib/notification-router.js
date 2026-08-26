const DEFAULT_RULES = {
  payment_success: ['in_app', 'push', 'email'],
  payment_failed: ['in_app', 'push', 'email'],
  payout_success: ['in_app', 'push'],
  payout_failed: ['in_app', 'push', 'email'],
  kyc_update: ['in_app', 'email'],
  low_balance: ['in_app', 'push'],
  security: ['in_app', 'push', 'email'],
};

function normalizeChannels(channels) {
  return [...new Set((Array.isArray(channels) ? channels : []).filter(Boolean))];
}

/**
 * Central event router. Provider delivery is intentionally injected so this
 * module stays usable from the existing API functions without adding routes.
 */
async function routeNotification({ event, userId, payload = {}, channels, preferences = {}, deliver }) {
  if (!userId) throw new Error('userId is required');
  if (typeof deliver !== 'function') throw new Error('deliver function is required');

  const requested = normalizeChannels(channels?.length ? channels : DEFAULT_RULES[event] || ['in_app']);
  const allowed = requested.filter(channel => preferences[channel] !== false || channel === 'in_app');
  const results = [];

  for (const channel of allowed) {
    try {
      const result = await deliver({ userId, event, channel, payload });
      results.push({ channel, status: 'sent', result: result ?? null });
    } catch (error) {
      results.push({ channel, status: 'failed', error: error?.message || 'delivery_failed' });
    }
  }

  return { event, userId, results };
}

module.exports = { DEFAULT_RULES, normalizeChannels, routeNotification };
