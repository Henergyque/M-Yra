import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Logger } from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
const envFile = process.env.NODE_ENV === 'production' ? '.env.prod' : '.env';
const envPath = path.join(__dirname, '..', envFile);

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else if (process.env.NODE_ENV === 'production') {
  // In production, env vars should be set by platform (Railway, Render, etc.)
  console.log('⚠️ No .env file found, using system environment variables');
}

const logger = new Logger('CONFIG');

/**
 * Helper: Require environment variable, throw if missing
 */
function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    logger.critical(`Missing required environment variable: ${key}`);
    throw new Error(`❌ Missing required env: ${key}`);
  }
  return value;
}

/**
 * Helper: Parse comma-separated array from env
 */
function parseArray(key) {
  const value = process.env[key];
  if (!value) return [];
  return value.split(',').map(v => v.trim()).filter(Boolean);
}

// ==================== CONFIGURATION ====================

export const config = {
  // === DISCORD ===
  token: requireEnv('DISCORD_TOKEN'),
  creatorId: requireEnv('CREATOR_ID'),

  // === AI API KEYS (Never log these!) ===
  // All API keys come from environment only - never hardcoded
  claudeApiKey: requireEnv('CLAUDE_API_KEY'),
  openaiApiKey: requireEnv('OPENAI_API_KEY'),
  grokApiKey: requireEnv('GROK_API_KEY'),
  geminiApiKey: requireEnv('GEMINI_API_KEY'),
  mistralApiKey: requireEnv('MISTRAL_API_KEY'),
  perplexityApiKey: requireEnv('PERPLEXITY_API_KEY'),

  // === DISCORD CHANNELS ===
  threadChannelIds: parseArray('THREAD_CHANNEL_IDS'),
  assistantChannelId: process.env.ASSISTANT_CHANNEL_ID,
  confessionChannelId: process.env.CONFESSION_CHANNEL_ID,
  countingChannelId: process.env.COUNTING_CHANNEL_ID,
  storyLibraryChannelId: process.env.STORY_LIBRARY_CHANNEL_ID,

  // === GITHUB (Optional) ===
  github: {
    repo: process.env.GITHUB_REPO,
    token: process.env.GITHUB_TOKEN
  },

  // === RATE LIMITS ===
  rateLimits: {
    opusMaxTokensPerDay: parseInt(process.env.OPUS_MAX_TOKENS_PER_DAY || '100000'),
    opusMaxReqPerMin: parseInt(process.env.OPUS_MAX_REQ_PER_MIN || '60'),
    mistralMaxReqPerMin: parseInt(process.env.MISTRAL_MAX_REQ_PER_MIN || '100'),
    geminiMaxReqPerDay: parseInt(process.env.GEMINI_MAX_REQ_PER_DAY || '1500'),
    perplexityMaxReqPerDay: parseInt(process.env.PERPLEXITY_MAX_REQ_PER_DAY || '1500'),
    grokMaxReqPerDay: parseInt(process.env.GROK_MAX_REQ_PER_DAY || '10000'),
    openaiMaxReqPerMin: parseInt(process.env.OPENAI_MAX_REQ_PER_MIN || '60')
  },

  // === SYSTEM ===
  environment: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'INFO'
};

// ==================== PATHS ====================

const dataDir = path.join(__dirname, '..', 'data');
const defaultDbPath = path.join(dataDir, 'bot.sqlite');
export const dbPath = process.env.DATABASE_PATH || defaultDbPath;
export const dbDir = path.dirname(dbPath);
export const logsDir = path.join(__dirname, '..', 'logs');
export const snapshotsDir = path.join(__dirname, '..', 'snapshots');

// Create necessary directories
[dataDir, dbDir, logsDir, snapshotsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.debug(`Created directory: ${dir}`);
  }
});

logger.info('✅ Configuration loaded successfully', {
  environment: config.environment,
  threadChannels: config.threadChannelIds.length,
  dbPath
});

export { dataDir };
