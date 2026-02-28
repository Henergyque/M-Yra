/**
 * Channel Configuration Manager
 * Manages which channels are configured for different features
 */

import { allQuery, getQuery, runQuery } from '../db.js';
import { Logger } from './logger.js';
import { invalidateChannelFeatureCache } from './channel-helper.js';

const logger = new Logger('CHANNEL-CONFIG');

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
    logger.error(`Erreur lecture channel_config pour ${feature}`, {
      error: err.message
    });
    return null;
  }
}

export async function getStoredChannelConfig(feature) {
  try {
    return await getQuery('SELECT feature, channel_id, enabled, updated_at FROM channel_config WHERE feature = ?', [feature]);
  } catch (err) {
    logger.error(`Erreur lecture channel_config brut pour ${feature}`, {
      error: err.message
    });
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
    invalidateChannelFeatureCache(feature);
    return true;
  } catch (err) {
    logger.error(`Erreur écriture channel_config pour ${feature}`, {
      error: err.message
    });
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
    invalidateChannelFeatureCache(feature);
    return true;
  } catch (err) {
    logger.error(`Erreur désactivation channel_config pour ${feature}`, {
      error: err.message
    });
    return false;
  }
}

/**
 * Get all configurations
 */
export async function getAllChannelConfigs(includeDisabled = true) {
  try {
    const sql = includeDisabled
      ? 'SELECT feature, channel_id, enabled, updated_at FROM channel_config ORDER BY feature'
      : 'SELECT feature, channel_id, enabled, updated_at FROM channel_config WHERE enabled = 1 ORDER BY feature';
    const rows = await allQuery(sql);
    return rows || [];
  } catch (err) {
    logger.error('Erreur lecture all channel_configs', {
      error: err.message
    });
    return [];
  }
}

export async function removeChannelConfig(feature) {
  try {
    await runQuery('DELETE FROM channel_config WHERE feature = ?', [feature]);
    invalidateChannelFeatureCache(feature);
    return true;
  } catch (err) {
    logger.error(`Erreur suppression channel_config pour ${feature}`, {
      error: err.message
    });
    return false;
  }
}
