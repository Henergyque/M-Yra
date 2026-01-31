/**
 * Channel Helper - Centralized channel configuration management
 * Checks DB first, falls back to env vars
 */

import { getQuery } from '../db.js';

/**
 * Get configured channel ID for a feature
 * @param {string} feature - Feature name (counting, confession, etc.)
 * @param {string} envVarKey - Config property name as fallback
 * @param {object} config - Config object
 * @returns {Promise<string|null>} Channel ID or null
 */
export async function getChannelForFeature(feature, envVarKey, config) {
  try {
    const dbConfig = await getQuery(
      'SELECT channel_id FROM channel_config WHERE feature = ? AND enabled = 1',
      [feature]
    );
    if (dbConfig && dbConfig.channel_id) {
      return dbConfig.channel_id;
    }
  } catch (err) {
    // Fallback to env var on error
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
  try {
    const dbConfig = await getQuery(
      'SELECT channel_id FROM channel_config WHERE feature = ? AND enabled = 1',
      [feature]
    );
    
    if (dbConfig && dbConfig.channel_id) {
      // DB stores comma-separated list for multiple channels
      return dbConfig.channel_id.split(',').map(id => id.trim()).filter(Boolean);
    }
  } catch (err) {
    // Fallback to env var on error
  }
  
  const envValue = config[envVarKey];
  return Array.isArray(envValue) ? envValue : [];
}
