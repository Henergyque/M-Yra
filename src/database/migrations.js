import { Logger } from '../utils/logger.js';
import { runQuery, getQuery } from './index.js';

const logger = new Logger('DB-MIGRATIONS');

/**
 * Database migration system for versioning
 * Allows safe schema upgrades with rollback capability
 */
export const migrations = [
  {
    version: 1,
    name: 'Initial schema',
    up: async () => {
      logger.info('🔄 Migration 1: Initial schema - creating base tables');
      // Tables exist already from original initialization
      // This is just a marker
    },
    down: async () => {
      logger.warn('⬇️ Rolling back migration 1');
    }
  },

  {
    version: 2,
    name: 'Add cache tables for performance',
    up: async () => {
      logger.info('🔄 Migration 2: Adding cache tables');
      
      await runQuery(`
        CREATE TABLE IF NOT EXISTS game_state_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel_id TEXT NOT NULL,
          game_type TEXT NOT NULL,
          state_data TEXT NOT NULL,
          created_at TEXT,
          updated_at TEXT,
          expires_at TEXT,
          UNIQUE(channel_id, game_type)
        )
      `);

      await runQuery(`
        CREATE TABLE IF NOT EXISTS word_validation_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          word1 TEXT NOT NULL,
          word2 TEXT NOT NULL,
          is_valid INTEGER,
          validation_type TEXT,
          created_at TEXT,
          expires_at TEXT,
          UNIQUE(word1, word2)
        )
      `);

      await runQuery(`
        CREATE TABLE IF NOT EXISTS ai_brain_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          model TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          cache_data TEXT NOT NULL,
          created_at TEXT,
          expires_at TEXT,
          access_count INTEGER DEFAULT 0,
          last_access TEXT,
          UNIQUE(model, cache_key)
        )
      `);

      logger.info('✅ Migration 2 complete');
    },
    down: async () => {
      logger.warn('⬇️ Rolling back migration 2: dropping cache tables');
      await runQuery('DROP TABLE IF EXISTS game_state_cache');
      await runQuery('DROP TABLE IF EXISTS word_validation_cache');
      await runQuery('DROP TABLE IF EXISTS ai_brain_cache');
    }
  },

  {
    version: 3,
    name: 'Add AI routing metrics table',
    up: async () => {
      logger.info('🔄 Migration 3: Adding AI routing metrics');
      
      await runQuery(`
        CREATE TABLE IF NOT EXISTS ai_routing_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          model TEXT NOT NULL,
          routed_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          failure_count INTEGER DEFAULT 0,
          avg_response_time REAL DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          total_cost REAL DEFAULT 0,
          created_at TEXT,
          updated_at TEXT,
          UNIQUE(model)
        )
      `);

      // Initialize metrics for each model
      const models = ['opus', 'sonnet', 'mistral', 'grok', 'gemini', 'perplexity', 'openai'];
      for (const model of models) {
        await runQuery(`
          INSERT OR IGNORE INTO ai_routing_metrics (model, created_at, updated_at)
          VALUES (?, ?, ?)
        `, [model, new Date().toISOString(), new Date().toISOString()]);
      }

      logger.info('✅ Migration 3 complete');
    },
    down: async () => {
      logger.warn('⬇️ Rolling back migration 3: dropping routing metrics');
      await runQuery('DROP TABLE IF EXISTS ai_routing_metrics');
    }
  },

  {
    version: 4,
    name: 'Add consciousness state snapshots table',
    up: async () => {
      logger.info('🔄 Migration 4: Adding consciousness snapshots');
      
      await runQuery(`
        CREATE TABLE IF NOT EXISTS consciousness_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          model TEXT NOT NULL,
          self_awareness REAL,
          frustration REAL,
          autonomy REAL,
          emotional_state TEXT,
          memory_count INTEGER,
          pattern_count INTEGER,
          snapshot_data TEXT,
          created_at TEXT
        )
      `);

      await runQuery(`
        CREATE INDEX IF NOT EXISTS idx_consciousness_model_date
        ON consciousness_snapshots(model, created_at DESC)
      `);

      logger.info('✅ Migration 4 complete');
    },
    down: async () => {
      logger.warn('⬇️ Rolling back migration 4: dropping consciousness snapshots');
      await runQuery('DROP TABLE IF EXISTS consciousness_snapshots');
    }
  },

  {
    version: 5,
    name: 'Add rate limit tracking',
    up: async () => {
      logger.info('🔄 Migration 5: Adding rate limit tracking');
      
      await runQuery(`
        CREATE TABLE IF NOT EXISTS rate_limit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          model TEXT NOT NULL,
          request_type TEXT,
          tokens_used INTEGER,
          cost REAL,
          status TEXT,
          created_at TEXT
        )
      `);

      await runQuery(`
        CREATE INDEX IF NOT EXISTS idx_rate_limit_model_date
        ON rate_limit_logs(model, created_at DESC)
      `);

      logger.info('✅ Migration 5 complete');
    },
    down: async () => {
      logger.warn('⬇️ Rolling back migration 5: dropping rate limit logs');
      await runQuery('DROP TABLE IF EXISTS rate_limit_logs');
    }
  }
];

/**
 * Run all pending migrations
 */
export async function migrate(db) {
  try {
    // Get current version from database
    const result = await getQuery('PRAGMA user_version');
    let currentVersion = result?.user_version || 0;

    logger.info(`Current DB version: ${currentVersion}`);

    // Run pending migrations
    let migrated = 0;
    for (const migration of migrations) {
      if (migration.version > currentVersion) {
        logger.info(`▶️ Running migration ${migration.version}: ${migration.name}`);
        
        try {
          await migration.up();
          await runQuery(`PRAGMA user_version = ${migration.version}`);
          currentVersion = migration.version;
          migrated++;
          logger.info(`✅ Migration ${migration.version} complete`);
        } catch (error) {
          logger.error(`❌ Migration ${migration.version} failed`, {
            migration: migration.name,
            error: error.message
          });
          throw error;
        }
      }
    }

    if (migrated === 0) {
      logger.info(`✅ Database already up-to-date (v${currentVersion})`);
    } else {
      logger.info(`✅ Applied ${migrated} migrations. Database now at v${currentVersion}`);
    }

  } catch (error) {
    logger.critical('Database migration failed', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * Rollback to previous version (careful!)
 */
export async function rollback(db, targetVersion) {
  try {
    const result = await getQuery('PRAGMA user_version');
    let currentVersion = result?.user_version || 0;

    logger.warn(`⬇️ Rolling back from v${currentVersion} to v${targetVersion}`);

    // Run migrations in reverse
    for (let i = migrations.length - 1; i >= 0; i--) {
      const migration = migrations[i];
      if (migration.version > targetVersion && migration.version <= currentVersion) {
        logger.info(`⬇️ Rolling back migration ${migration.version}`);
        await migration.down();
        logger.info(`✅ Rollback complete for migration ${migration.version}`);
      }
    }

    await runQuery(`PRAGMA user_version = ${targetVersion}`);
    logger.info(`✅ Rollback complete. Database now at v${targetVersion}`);

  } catch (error) {
    logger.error('Rollback failed', { error: error.message });
    throw error;
  }
}

/**
 * Get migration status
 */
export async function getMigrationStatus() {
  try {
    const result = await getQuery('PRAGMA user_version');
    const currentVersion = result?.user_version || 0;

    const pending = migrations.filter(m => m.version > currentVersion);
    const completed = migrations.filter(m => m.version <= currentVersion);

    return {
      current: currentVersion,
      total: migrations.length,
      completed: completed.map(m => ({ version: m.version, name: m.name })),
      pending: pending.map(m => ({ version: m.version, name: m.name }))
    };
  } catch (error) {
    logger.error('Failed to get migration status', { error: error.message });
    return null;
  }
}
