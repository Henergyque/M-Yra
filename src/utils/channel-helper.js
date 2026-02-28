/**
 * Channel Helper - Centralized channel configuration management
 * Checks DB first, falls back to env vars
 */

import { getQuery } from '../db.js';

const CHANNEL_CONFIG_TTL_MS = 10_000;
const channelConfigCache = new Map();

function getCachedChannelValue(feature) {
  const cached = channelConfigCache.get(feature);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    channelConfigCache.delete(feature);
    return null;
  }
  return cached.value;
}

function setCachedChannelValue(feature, value) {
  channelConfigCache.set(feature, {
    value,
    expiresAt: Date.now() + CHANNEL_CONFIG_TTL_MS
  });
}

async function loadChannelConfigValue(feature) {
  const cachedValue = getCachedChannelValue(feature);
  if (cachedValue !== null) {
    return cachedValue;
  }

  try {
    const dbConfig = await getQuery(
      'SELECT channel_id FROM channel_config WHERE feature = ? AND enabled = 1',
      [feature]
    );
    const value = dbConfig?.channel_id || '';
    setCachedChannelValue(feature, value);
    return value;
  } catch {
    return '';
  }
}

export function invalidateChannelFeatureCache(feature) {
  if (!feature) return;
  channelConfigCache.delete(feature);
}

/**
 * Get configured channel ID for a feature
 * @param {string} feature - Feature name (counting, confession, etc.)
 * @param {string} envVarKey - Config property name as fallback
 * @param {object} config - Config object
 * @returns {Promise<string|null>} Channel ID or null
 */
export async function getChannelForFeature(feature, envVarKey, config) {
  const configured = await loadChannelConfigValue(feature);
  if (configured) {
    return configured;
  }

  return config[envVarKey] || null;
}

/**
 * Get multiple channel IDs for a feature (like thread_create which can have multiple channels)
 * @param {string} feature - Feature name
 * @param {string} envVarKey - Config property name as fallback (should be array)
 * @param {object} config - Config object
 * @returns {Promise<string[]>} Array of channel IDs
 */
export async function getChannelsForFeature(feature, envVarKey, config) {
  const configured = await loadChannelConfigValue(feature);
  if (configured) {
    return configured.split(',').map(id => id.trim()).filter(Boolean);
  }
  
  const envValue = config[envVarKey];
  return Array.isArray(envValue) ? envValue : [];
}
