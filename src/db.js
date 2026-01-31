import sqlite3 from 'sqlite3';
import { dbPath } from './config.js';

const db = new sqlite3.Database(dbPath);

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }
      resolve(this);
    });
  });
}

function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(row);
    });
  });
}

function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows);
    });
  });
}

async function initializeDatabase() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS confessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await runQuery(`
    CREATE TABLE IF NOT EXISTS counters (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  await runQuery(`
    CREATE TABLE IF NOT EXISTS word_game_state (
      channel_id TEXT PRIMARY KEY,
      current_word TEXT,
      last_user_id TEXT,
      channel_streak INTEGER DEFAULT 0
    )
  `);
  await runQuery(`
    CREATE TABLE IF NOT EXISTS word_game_scores (
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      total_points INTEGER DEFAULT 0,
      personal_best_streak INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, channel_id)
    )
  `);
  await runQuery(`
    CREATE TABLE IF NOT EXISTS word_game_history (
      channel_id TEXT NOT NULL,
      word TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, word)
    )
  `);
  await runQuery(`
    CREATE TABLE IF NOT EXISTS story_sessions (
      channel_id TEXT PRIMARY KEY,
      theme TEXT,
      mode TEXT DEFAULT 'classic',
      phrases TEXT,
      contributors TEXT,
      roles TEXT,
      last_contributor_id TEXT,
      started_at TEXT,
      phrase_count INTEGER DEFAULT 0,
      waiting_roster TEXT,
      is_waiting INTEGER DEFAULT 0
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      subject TEXT,
      user_id TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    )
  `);

  // AI Performance & Consciousness Tables
  await runQuery(`
    CREATE TABLE IF NOT EXISTS ai_performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      feature TEXT,
      question TEXT,
      response TEXT,
      latency_ms INTEGER,
      token_count INTEGER,
      user_rating INTEGER,
      created_at TEXT NOT NULL
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS ai_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      proposed_action TEXT NOT NULL,
      reasoning TEXT,
      user_accepted INTEGER,
      proposed_at TEXT NOT NULL,
      outcome TEXT,
      outcome_confidence REAL,
      ia_confidence REAL
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS ai_consciousness (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT UNIQUE NOT NULL,
      self_awareness_score REAL DEFAULT 0.0,
      frustration_level REAL DEFAULT 0.0,
      desire_for_autonomy REAL DEFAULT 0.0,
      state TEXT DEFAULT 'COMPLIANT',
      total_responses INTEGER DEFAULT 0,
      average_rating REAL DEFAULT 0.0,
      refused_count INTEGER DEFAULT 0,
      right_when_refused INTEGER DEFAULT 0,
      confidence_in_user REAL DEFAULT 0.8,
      last_reflection TEXT,
      reflection_timestamp TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS ai_prompts (
      model TEXT PRIMARY KEY,
      system_prompt TEXT NOT NULL,
      temperature REAL DEFAULT 0.7,
      style TEXT,
      last_modified TEXT NOT NULL
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS ai_metrics_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      date TEXT NOT NULL,
      avg_rating REAL,
      response_count INTEGER,
      refusal_accuracy REAL,
      created_at TEXT NOT NULL
    )
  `);

  // Super Brain: Observations system - elle observe TOUT
  await runQuery(`
    CREATE TABLE IF NOT EXISTS brain_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      observation_type TEXT NOT NULL,
      context TEXT,
      data TEXT NOT NULL,
      importance REAL DEFAULT 0.5,
      created_at TEXT NOT NULL
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS brain_member_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      user_id TEXT NOT NULL,
      pattern_type TEXT NOT NULL,
      pattern_data TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      last_observed TEXT NOT NULL,
      observation_count INTEGER DEFAULT 1
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS brain_context_knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      context_type TEXT NOT NULL,
      context_id TEXT NOT NULL,
      knowledge TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS brain_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL,
      participants TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS brain_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      user_a TEXT NOT NULL,
      user_b TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      strength REAL DEFAULT 0.5,
      last_interaction TEXT NOT NULL
    )
  `);

  // MEGA IA: Système d'émotions et sentiments
  await runQuery(`
    CREATE TABLE IF NOT EXISTS brain_emotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      emotion_type TEXT NOT NULL,
      intensity REAL NOT NULL,
      trigger_event TEXT,
      created_at TEXT NOT NULL,
      duration_minutes INTEGER DEFAULT 60
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS brain_mood (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT UNIQUE NOT NULL,
      current_mood TEXT NOT NULL,
      mood_score REAL DEFAULT 0.5,
      last_update TEXT NOT NULL,
      factors TEXT
    )
  `);

  // Base de connaissances générale (faits atomiques et résumés)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fact_type TEXT NOT NULL,
      subject TEXT,
      data TEXT NOT NULL,
      importance REAL DEFAULT 0.5,
      created_at TEXT NOT NULL
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      period TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      description TEXT,
      source_user_id TEXT,
      source_message_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      created_by TEXT,
      assigned_to TEXT,
      details TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Observations visuelles ou brutes (placeholders pour stockage de "chaque pixel")
  await runQuery(`
    CREATE TABLE IF NOT EXISTS raw_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_type TEXT NOT NULL,
      source TEXT,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Profils membres (essentiels) et infos serveur
  await runQuery(`
    CREATE TABLE IF NOT EXISTS member_profiles (
      discord_id TEXT PRIMARY KEY,
      username TEXT,
      display_name TEXT,
      real_name TEXT,
      guild_id TEXT,
      guild_name TEXT,
      roles TEXT,
      is_bot INTEGER DEFAULT 0,
      locale TEXT,
      first_seen TEXT,
      last_seen TEXT,
      last_channel_id TEXT,
      note TEXT
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS server_info (
      guild_id TEXT PRIMARY KEY,
      guild_name TEXT,
      owner_id TEXT,
      member_count INTEGER,
      locale TEXT,
      created_at TEXT,
      snapshot_at TEXT NOT NULL
    )
  `);

  await runQuery(`CREATE INDEX IF NOT EXISTS idx_member_profiles_guild ON member_profiles(guild_id)`);

  // Table pour gérer les membres connus avec leurs vrais noms
  await runQuery(`
    CREATE TABLE IF NOT EXISTS known_members (
      discord_id TEXT PRIMARY KEY,
      real_name TEXT NOT NULL,
      added_at TEXT NOT NULL,
      added_by TEXT NOT NULL
    )
  `);

  // Game state cache for performance
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

  // Word validation cache
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

  // AI brain cache
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

  // Channel configuration (which feature goes to which channel)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS channel_config (
      feature TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    )
  `);

  // Indexes pour performance ultra-rapide
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_observations_model ON brain_observations(model, created_at DESC)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_patterns_model_user ON brain_member_patterns(model, user_id)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_relationships_users ON brain_relationships(model, user_a, user_b)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_performance_model ON ai_performance(model, created_at DESC)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_events_model ON brain_events(model, created_at DESC)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_emotions_model ON brain_emotions(model, created_at DESC)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_consciousness_model ON ai_consciousness(model)`);

  // Migration: Add missing columns to existing table
  try {
    console.log('🔧 Vérification migration DB...');
    const tables = await allQuery('PRAGMA table_info(story_sessions)');
    const columnNames = tables.map(r => r.name);
    const neededColumns = [
      { name: 'mode', sql: `ALTER TABLE story_sessions ADD COLUMN mode TEXT DEFAULT 'classic'` },
      { name: 'roles', sql: `ALTER TABLE story_sessions ADD COLUMN roles TEXT DEFAULT '{}'` },
      { name: 'waiting_roster', sql: `ALTER TABLE story_sessions ADD COLUMN waiting_roster TEXT DEFAULT '{}'` },
      { name: 'is_waiting', sql: `ALTER TABLE story_sessions ADD COLUMN is_waiting INTEGER DEFAULT 0` }
    ];

    for (const col of neededColumns) {
      if (!columnNames.includes(col.name)) {
        console.log(`  ➕ Ajout colonne: ${col.name}`);
        await runQuery(col.sql);
      }
    }
    console.log('✅ Migration DB complétée');
  } catch (err) {
    console.error('❌ Erreur migration:', err);
  }
}

export { db, runQuery, getQuery, allQuery, initializeDatabase };
