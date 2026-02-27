import { getQuery, runQuery } from '../db.js';

const MAINTENANCE_ENABLED_KEY = 'maintenance_enabled';
const MAINTENANCE_MESSAGE_KEY = 'maintenance_message';
const notificationCooldownByChannel = new Map();
const NOTIFICATION_COOLDOWN_MS = 30_000;

const DEFAULT_MAINTENANCE_MESSAGE = '🛠️ Les jeux sont temporairement en maintenance. Merci de réessayer un peu plus tard.';

function parseEnabledValue(raw) {
  if (raw === undefined || raw === null) return false;
  return String(raw) === '1';
}

export async function getMaintenanceState() {
  const enabledRow = await getQuery('SELECT value FROM counters WHERE key = ?', [MAINTENANCE_ENABLED_KEY]);
  const messageRow = await getQuery('SELECT value FROM counters WHERE key = ?', [MAINTENANCE_MESSAGE_KEY]);

  const enabled = parseEnabledValue(enabledRow?.value);
  const message = (messageRow?.value || '').trim() || DEFAULT_MAINTENANCE_MESSAGE;

  return {
    enabled,
    message
  };
}

export async function setMaintenanceState(enabled, message = DEFAULT_MAINTENANCE_MESSAGE) {
  const normalizedEnabled = enabled ? '1' : '0';
  const normalizedMessage = (message || '').trim() || DEFAULT_MAINTENANCE_MESSAGE;

  await runQuery(
    'INSERT INTO counters (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [MAINTENANCE_ENABLED_KEY, normalizedEnabled]
  );

  await runQuery(
    'INSERT INTO counters (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [MAINTENANCE_MESSAGE_KEY, normalizedMessage]
  );
}

export async function sendMaintenanceNotice(message) {
  const state = await getMaintenanceState();
  if (!state.enabled) {
    return false;
  }

  const channelId = message.channel.id;
  const now = Date.now();
  const lastNotification = notificationCooldownByChannel.get(channelId) || 0;
  if (now - lastNotification < NOTIFICATION_COOLDOWN_MS) {
    return true;
  }

  notificationCooldownByChannel.set(channelId, now);
  await message.channel.send(state.message);
  return true;
}
