import { Logger } from '../utils/logger.js';
import { runQuery, getQuery, allQuery } from '../db.js';

const logger = new Logger('GAME-STATE');

/**
 * Unified Game State Manager
 * Replaces repetitive state management for Counting, WordGame, Story, etc.
 */
export class GameStateManager {
  constructor() {
    this.locks = new Map();
  }

  /**
   * Get game state from database
   */
  async getGameState(channelId, gameType) {
    try {
      const result = await getQuery(
        'SELECT state_data FROM game_state_cache WHERE channel_id = ? AND game_type = ?',
        [channelId, gameType]
      );

      if (result && result.state_data) {
        try {
          const state = JSON.parse(result.state_data);
          logger.debug(`Retrieved ${gameType} state for channel ${channelId}`);
          return state;
        } catch (e) {
          logger.error(`Failed to parse state for ${gameType}`, { error: e.message });
          return null;
        }
      }

      return null;
    } catch (error) {
      logger.error(`Failed to get ${gameType} state`, { error: error.message, channelId });
      return null;
    }
  }

  /**
   * Set game state in database
   */
  async setGameState(channelId, gameType, stateData) {
    try {
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h TTL

      const stateJson = JSON.stringify(stateData);

      await runQuery(`
        INSERT INTO game_state_cache (channel_id, game_type, state_data, created_at, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id, game_type) DO UPDATE SET
          state_data = ?,
          updated_at = ?
      `, [
        channelId,
        gameType,
        stateJson,
        now,
        now,
        expiresAt,
        stateJson,
        now
      ]);

      logger.debug(`Set ${gameType} state for channel ${channelId}`, {
        channelId,
        gameType,
        dataSize: stateJson.length
      });
    } catch (error) {
      logger.error(`Failed to set ${gameType} state`, { error: error.message, channelId });
      throw error;
    }
  }

  /**
   * Delete game state
   */
  async deleteGameState(channelId, gameType) {
    try {
      await runQuery(
        'DELETE FROM game_state_cache WHERE channel_id = ? AND game_type = ?',
        [channelId, gameType]
      );

      logger.debug(`Deleted ${gameType} state for channel ${channelId}`);
    } catch (error) {
      logger.error(`Failed to delete ${gameType} state`, { error: error.message });
      throw error;
    }
  }

  /**
   * Acquire lock for exclusive access (prevent race conditions)
   */
  async acquireLock(channelId, gameType, timeoutMs = 5000) {
    const lockKey = `${channelId}:${gameType}`;
    const startTime = Date.now();

    while (this.locks.has(lockKey)) {
      if (Date.now() - startTime > timeoutMs) {
        logger.warn(`Lock timeout for ${gameType} in channel ${channelId}`);
        throw new Error(`Lock timeout for ${lockKey}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.locks.set(lockKey, true);
    logger.debug(`Lock acquired for ${lockKey}`);

    return () => this.releaseLock(lockKey);
  }

  /**
   * Release lock
   */
  releaseLock(lockKey) {
    this.locks.delete(lockKey);
    logger.debug(`Lock released for ${lockKey}`);
  }

  /**
   * Atomic operation: Get state, modify, set state
   */
  async atomicUpdate(channelId, gameType, updateFn) {
    const releaseLock = await this.acquireLock(channelId, gameType);

    try {
      let state = await this.getGameState(channelId, gameType);
      if (!state) {
        state = {};
      }

      const newState = await updateFn(state);
      await this.setGameState(channelId, gameType, newState);

      return newState;
    } catch (error) {
      logger.error(`Atomic update failed for ${gameType}`, { error: error.message, channelId });
      throw error;
    } finally {
      releaseLock();
    }
  }

  /**
   * List all active games in channel
   */
  async getActiveGames(channelId) {
    try {
      const results = await allQuery(
        'SELECT game_type, updated_at FROM game_state_cache WHERE channel_id = ? AND expires_at > ?',
        [channelId, new Date().toISOString()]
      );

      return results || [];
    } catch (error) {
      logger.error('Failed to get active games', { error: error.message, channelId });
      return [];
    }
  }

  /**
   * Cleanup expired game states
   */
  async cleanupExpired() {
    try {
      const result = await runQuery(
        'DELETE FROM game_state_cache WHERE expires_at < ?',
        [new Date().toISOString()]
      );

      logger.info('Game state cleanup complete', { expired: result.changes || 0 });
      return result.changes || 0;
    } catch (error) {
      logger.error('Cleanup failed', { error: error.message });
      return 0;
    }
  }

  /**
   * Get statistics
   */
  async getStats() {
    try {
      const result = await getQuery(
        'SELECT COUNT(*) as count, COUNT(DISTINCT channel_id) as channels FROM game_state_cache WHERE expires_at > ?',
        [new Date().toISOString()]
      );

      return {
        totalStates: result?.count || 0,
        activeChannels: result?.channels || 0,
        activeLocks: this.locks.size
      };
    } catch (error) {
      logger.error('Failed to get stats', { error: error.message });
      return null;
    }
  }
}

// Global instance
export const gameStateManager = new GameStateManager();

// Cleanup every hour
setInterval(async () => {
  await gameStateManager.cleanupExpired();
}, 60 * 60 * 1000);
