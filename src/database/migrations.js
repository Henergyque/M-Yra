import { Logger } from '../utils/logger.js';
import { runQuery, getQuery, allQuery, initializeDatabase } from '../db.js';
import { fileURLToPath } from 'node:url';

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
      const models = ['opus', 'sonnet', 'mistral', 'grok', 'gemini', 'openai'];
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
    name: 'Add rate limit tracking',
    up: async () => {
      logger.info('🔄 Migration 4: Adding rate limit tracking');
      
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

      logger.info('✅ Migration 4 complete');
    },
    down: async () => {
      logger.warn('⬇️ Rolling back migration 4: dropping rate limit logs');
      await runQuery('DROP TABLE IF EXISTS rate_limit_logs');
    }
  },

  {
    version: 5,
    name: 'Add memory query indexes',
    up: async () => {
      logger.info('🔄 Migration 5: Adding memory query indexes');

      await runQuery(`
        CREATE INDEX IF NOT EXISTS idx_memories_type_user_created
        ON memories(type, user_id, created_at DESC)
      `);

      await runQuery(`
        CREATE INDEX IF NOT EXISTS idx_memories_user_type_created
        ON memories(user_id, type, created_at DESC)
      `);

      logger.info('✅ Migration 5 complete');
    },
    down: async () => {
      logger.warn('⬇️ Rolling back migration 5: dropping memory indexes');
      await runQuery('DROP INDEX IF EXISTS idx_memories_type_user_created');
      await runQuery('DROP INDEX IF EXISTS idx_memories_user_type_created');
    }
  },

  {
    version: 6,
    name: 'Add memory slots, embeddings and diagnostics logs',
    up: async () => {
      logger.info('🔄 Migration 6: Adding memory slots, embeddings and diagnostics logs');

      await runQuery(`
        CREATE TABLE IF NOT EXISTS user_memory_slots (
          user_id TEXT PRIMARY KEY,
          objective TEXT,
          pro_context TEXT,
          preferences TEXT,
          constraints TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      await runQuery(`
        CREATE TABLE IF NOT EXISTS memory_embeddings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id INTEGER,
          user_id TEXT,
          memory_type TEXT NOT NULL,
          source_text TEXT NOT NULL,
          embedding TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);

      await runQuery(`
        CREATE TABLE IF NOT EXISTS ai_request_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT,
          channel_id TEXT,
          model TEXT,
          route TEXT,
          latency_ms INTEGER,
          success INTEGER DEFAULT 1,
          fallback_used INTEGER DEFAULT 0,
          prompt_chars INTEGER,
          response_chars INTEGER,
          estimated_tokens INTEGER,
          error_message TEXT,
          created_at TEXT NOT NULL
        )
      `);

      await runQuery(`
        CREATE INDEX IF NOT EXISTS idx_memory_embeddings_user_type
        ON memory_embeddings(user_id, memory_type, created_at DESC)
      `);

      await runQuery(`
        CREATE INDEX IF NOT EXISTS idx_memory_embeddings_memory_id
        ON memory_embeddings(memory_id)
      `);

      await runQuery(`
        CREATE INDEX IF NOT EXISTS idx_ai_request_logs_date
        ON ai_request_logs(created_at DESC)
      `);

      await runQuery(`
        CREATE INDEX IF NOT EXISTS idx_ai_request_logs_model_date
        ON ai_request_logs(model, created_at DESC)
      `);

      logger.info('✅ Migration 6 complete');
    },
    down: async () => {
      logger.warn('⬇️ Rolling back migration 6: dropping memory slots, embeddings and diagnostics logs');
      await runQuery('DROP INDEX IF EXISTS idx_memory_embeddings_user_type');
      await runQuery('DROP INDEX IF EXISTS idx_memory_embeddings_memory_id');
      await runQuery('DROP INDEX IF EXISTS idx_ai_request_logs_date');
      await runQuery('DROP INDEX IF EXISTS idx_ai_request_logs_model_date');
      await runQuery('DROP TABLE IF EXISTS ai_request_logs');
      await runQuery('DROP TABLE IF EXISTS memory_embeddings');
      await runQuery('DROP TABLE IF EXISTS user_memory_slots');
    }
  },

  {
    version: 7,
    name: 'Add game moderation, sanctions and gage monitoring tables',
    up: async () => {
      logger.info('🔄 Migration 7: Adding game moderation tables');

      await runQuery(`
        CREATE TABLE IF NOT EXISTS game_daily_chances (
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          date_key TEXT NOT NULL,
          chances_used INTEGER DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (guild_id, user_id, date_key)
        )
      `);

      await runQuery(`
        CREATE TABLE IF NOT EXISTS game_sanctions (
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          active INTEGER DEFAULT 1,
          reason TEXT,
          source TEXT,
          created_at TEXT NOT NULL,
          created_by TEXT,
          lifted_at TEXT,
          lifted_by TEXT,
          PRIMARY KEY (guild_id, user_id)
        )
      `);

      await runQuery(`
        CREATE TABLE IF NOT EXISTS game_whitelist (
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          source TEXT DEFAULT 'manual',
          confidence REAL,
          added_at TEXT NOT NULL,
          added_by TEXT,
          PRIMARY KEY (guild_id, user_id)
        )
      `);

      await runQuery(`
        CREATE TABLE IF NOT EXISTS game_infraction_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          channel_id TEXT,
          user_id TEXT NOT NULL,
          game_type TEXT NOT NULL,
          event_type TEXT NOT NULL,
          ai_confidence REAL,
          confidence_level TEXT,
          details TEXT,
          created_at TEXT NOT NULL
        )
      `);

      await runQuery(`
        CREATE TABLE IF NOT EXISTS gage_monitoring (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          target_user_id TEXT NOT NULL,
          assigned_by TEXT,
          challenge_text TEXT,
          started_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          monitoring_type TEXT DEFAULT 'standard',
          baseline_avatar_hash TEXT,
          baseline_avatar_url TEXT,
          avatar_changed INTEGER DEFAULT 0,
          last_ai_confidence REAL,
          last_ai_level TEXT,
          last_ai_reason TEXT,
          status TEXT DEFAULT 'active',
          UNIQUE(guild_id, thread_id, target_user_id)
        )
      `);

      await runQuery(`
        CREATE INDEX IF NOT EXISTS idx_game_infraction_recent
        ON game_infraction_events(guild_id, user_id, created_at DESC)
      `);

      await runQuery(`
        CREATE INDEX IF NOT EXISTS idx_gage_monitoring_thread
        ON gage_monitoring(guild_id, thread_id, status)
      `);

      logger.info('✅ Migration 7 complete');
    },
    down: async () => {
      logger.warn('⬇️ Rolling back migration 7: dropping game moderation tables');
      await runQuery('DROP INDEX IF EXISTS idx_game_infraction_recent');
      await runQuery('DROP INDEX IF EXISTS idx_gage_monitoring_thread');
      await runQuery('DROP TABLE IF EXISTS gage_monitoring');
      await runQuery('DROP TABLE IF EXISTS game_infraction_events');
      await runQuery('DROP TABLE IF EXISTS game_whitelist');
      await runQuery('DROP TABLE IF EXISTS game_sanctions');
      await runQuery('DROP TABLE IF EXISTS game_daily_chances');
    }
  },

  {
    version: 8,
    name: 'Add avatar tracking columns for gage monitoring',
    up: async () => {
      logger.info('🔄 Migration 8: Updating gage monitoring columns');

      const existing = await getQuery(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gage_monitoring'`);
      if (!existing) {
        logger.info('ℹ️ gage_monitoring table missing, skipping migration 8 alterations');
        return;
      }

      const columnRows = await allQuery('PRAGMA table_info(gage_monitoring)');
      const names = new Set((columnRows || []).map((row) => row.name));

      if (!names.has('monitoring_type')) {
        await runQuery(`ALTER TABLE gage_monitoring ADD COLUMN monitoring_type TEXT DEFAULT 'standard'`);
      }
      if (!names.has('baseline_avatar_hash')) {
        await runQuery('ALTER TABLE gage_monitoring ADD COLUMN baseline_avatar_hash TEXT');
      }
      if (!names.has('baseline_avatar_url')) {
        await runQuery('ALTER TABLE gage_monitoring ADD COLUMN baseline_avatar_url TEXT');
      }
      if (!names.has('avatar_changed')) {
        await runQuery('ALTER TABLE gage_monitoring ADD COLUMN avatar_changed INTEGER DEFAULT 0');
      }

      logger.info('✅ Migration 8 complete');
    },
    down: async () => {
      logger.warn('⬇️ Migration 8 rollback not supported for SQLite column drops');
    }
  },

  {
    version: 9,
    name: 'Drop dead feature tables (game moderation, gage, caches, routing metrics)',
    up: async () => {
      logger.info('🔄 Migration 9: dropping dead feature tables');
      const deadTables = [
        'game_sanctions',
        'game_whitelist',
        'game_infraction_events',
        'gage_monitoring',
        'game_daily_chances',
        'game_state_cache',
        'word_validation_cache',
        'ai_brain_cache',
        'ai_routing_metrics',
        'rate_limit_logs'
      ];
      await runQuery('DROP INDEX IF EXISTS idx_game_infraction_recent');
      await runQuery('DROP INDEX IF EXISTS idx_gage_monitoring_thread');
      for (const table of deadTables) {
        await runQuery(`DROP TABLE IF EXISTS ${table}`);
      }
      logger.info('✅ Migration 9 complete');
    },
    down: async () => {
      logger.warn('⬇️ Migration 9 rollback: tables mortes non recréées (features supprimées)');
    }
  }
];

/**
 * Run all pending migrations
 */
export async function migrate() {
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
export async function rollback(targetVersion) {
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

const currentFilePath = fileURLToPath(import.meta.url);

if (process.argv[1] === currentFilePath) {
  (async () => {
    try {
      logger.info('Starting database initialization before migrations');
      await initializeDatabase();
      await migrate();
      const status = await getMigrationStatus();
      logger.info('Migration status', status ?? {});
      process.exit(0);
    } catch (error) {
      logger.critical('Migration CLI failed', {
        error: error.message,
        stack: error.stack
      });
      process.exit(1);
    }
  })();
}
