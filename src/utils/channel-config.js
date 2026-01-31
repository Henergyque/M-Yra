/**
 * Channel Configuration Manager
 * Manages which channels are configured for different features
 */

import { getQuery, runQuery } from '../db.js';

/**
 * Get configured channel for a feature
 * Falls back to environment variable if not in database
 */
export async function getChannelConfig(feature, defaultEnvKey = null, config = null) {
  try {
    // Try to get from database first
    const row = await getQuery(
      'SELECT channel_id FROM channel_config WHERE feature = ? AND enabled = 1',
      [feature]
    );

    if (row && row.channel_id) {
      return row.channel_id;
    }

    // Fall back to environment variable if provided
    if (defaultEnvKey && config && config[defaultEnvKey]) {
      return config[defaultEnvKey];
    }

    return null;
  } catch (err) {
    console.error(`❌ Erreur lecture channel_config pour ${feature}:`, err);
    return null;
  }
}

/**
 * Set configured channel for a feature
 */
export async function setChannelConfig(feature, channelId) {
  try {
    const now = new Date().toISOString();
    await runQuery(
      'INSERT INTO channel_config (feature, channel_id, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT(feature) DO UPDATE SET channel_id = ?, enabled = 1, updated_at = ?',
      [feature, channelId, now, now, channelId, now]
    );
    return true;
  } catch (err) {
    console.error(`❌ Erreur écriture channel_config pour ${feature}:`, err);
    return false;
  }
}

/**
 * Disable a feature (mark as disabled but keep config)
 */
export async function disableChannelConfig(feature) {
  try {
    const now = new Date().toISOString();
    await runQuery(
      'INSERT INTO channel_config (feature, channel_id, enabled, created_at, updated_at) VALUES (?, ?, 0, ?, ?) ON CONFLICT(feature) DO UPDATE SET enabled = 0, updated_at = ?',
      [feature, '', now, now, now]
    );
    return true;
  } catch (err) {
    console.error(`❌ Erreur désactivation channel_config pour ${feature}:`, err);
    return false;
  }
}

/**
 * Get all configurations
 */
export async function getAllChannelConfigs() {
  try {
    const rows = await getQuery(
      'SELECT feature, channel_id, enabled FROM channel_config WHERE enabled = 1'
    );
    return rows || [];
  } catch (err) {
    console.error('❌ Erreur lecture all channel_configs:', err);
    return [];
  }
}
