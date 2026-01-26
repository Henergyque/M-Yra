import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sqlite3 from 'sqlite3';
import OpenAI from 'openai';
import { execSync } from 'node:child_process';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration
} from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.join(__dirname, '..', 'config.json');
if (!fs.existsSync(configPath)) {
  throw new Error('Missing config.json. Copy config.example.json and fill in values.');
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const dataDir = path.join(__dirname, '..', 'data');
const defaultDbPath = path.join(dataDir, 'bot.sqlite');
const dbPath = process.env.DATABASE_PATH || defaultDbPath;
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

// Helper: build git push command with optional GitHub token
function getGitPushCommand(targetBranch) {
  const repoUrl = config.githubRepo;
  const token = config.githubToken;
  if (!repoUrl) {
    return null;
  }

  if (token && repoUrl.startsWith('https://')) {
    const authedUrl = repoUrl.replace('https://', `https://x-access-token:${token}@`);
    return `git push ${authedUrl} ${targetBranch}`;
  }

  return `git push origin ${targetBranch}`;
}

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

  // Migration: Add missing columns to existing table
  try {
    console.log('🔧 Vérification migration DB...');
    const tables = await new Promise((resolve, reject) => {
      db.all(`PRAGMA table_info(story_sessions)`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

const countingLocks = new Map();
const countingCache = new Map();
let activeQuiz = null;
const actionVeriteGames = new Map();
const actionVeriteLocks = new Map();

// Word game state
const wordGameLocks = new Map();
const validatedPairs = new Map();
const openai = new OpenAI({ apiKey: config.openaiApiKey });

// Grok client for uncensored story summaries
const grok = new OpenAI({
  apiKey: config.grokApiKey,
  baseURL: 'https://api.x.ai/v1'
});

// Claude client for assistant (more natural/human tone)
const Anthropic = await import('@anthropic-ai/sdk');
const claude = new Anthropic.default({
  apiKey: config.claudeApiKey
});

// Story game state
const activeStories = new Map();

// Debate state - track message count per channel for crescendo
const debateState = new Map();

// Pending code modifications (userId -> { suggestion, context })
const pendingCodeMods = new Map();

// === Memory System Functions ===

// Add memory to database
async function addMemory(type, content, createdBy, subject = null, userId = null) {
  await runQuery(
    'INSERT INTO memories (type, subject, user_id, content, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [type, subject, userId, content, new Date().toISOString(), createdBy]
  );
}

// Get memories by user ID
async function getMemoriesForUser(userId) {
  return await allQuery(
    'SELECT * FROM memories WHERE user_id = ? ORDER BY created_at DESC',
    [userId]
  );
}

// Search memories by keywords
async function searchMemories(keywords) {
  const terms = keywords.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (terms.length === 0) return [];
  
  const results = await allQuery('SELECT * FROM memories ORDER BY created_at DESC LIMIT 100');
  return results.filter(mem => {
    const searchText = `${mem.subject || ''} ${mem.content}`.toLowerCase();
    return terms.some(term => searchText.includes(term));
  });
}

// Get all memories (limited)
async function getAllMemories(limit = 50) {
  return await allQuery(
    'SELECT * FROM memories ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
}

// Delete memory by ID
async function deleteMemory(memoryId) {
  await runQuery('DELETE FROM memories WHERE id = ?', [memoryId]);
}

const quizDataPath = path.join(__dirname, '..', 'storage', 'quiz.json');
const quizFallbackPath = path.join(__dirname, '..', 'storage', 'quiz.example.json');
const quizDataSource = fs.existsSync(quizDataPath) ? quizDataPath : quizFallbackPath;
if (!fs.existsSync(quizDataSource)) {
  throw new Error('Missing quiz data. Provide data/quiz.json or data/quiz.example.json.');
}
const quizThemes = JSON.parse(fs.readFileSync(quizDataSource, 'utf-8')).themes;

const quizThemeEmojis = ['🎮', '🎵', '🎨', '🌍'];
const quizAnswerEmojis = ['🇦', '🇧', '🇨', '🇩'];
const quizQuestionCount = 10;
const quizVoteDurationMs = 20000;
const quizQuestionDurationMs = 15000;
const actionVeriteCommand = '!actionverite';
const supportLink = 'https://buymeacoffee.com/henergyque';
const supportMessage = `Si tu veux soutenir le bot, voici un petit café ☕ : ${supportLink}`;

function isConfiguredChannel(channelId, list) {
  return Array.isArray(list) && list.includes(channelId);
}

function isAdmin(user) {
  return Array.isArray(config.adminUserIds) && config.adminUserIds.includes(user.id);
}

function formatThreadName(message) {
  const base = message.content?.trim() || message.author.username;
  const safe = base.replace(/\s+/g, ' ').slice(0, 80);
  return `Discussion - ${safe}`;
}

function parseCountingNumber(messageContent) {
  const trimmed = messageContent.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  return Number.parseInt(trimmed, 10);
}

async function getCountingState(channelId) {
  const cached = countingCache.get(channelId);
  if (cached) {
    return cached;
  }

  const lastNumberKey = `counting_last:${channelId}`;
  const lastUserKey = `counting_last_user:${channelId}`;
  const lastNumberRow = await getQuery(
    'SELECT value FROM counters WHERE key = ?',
    [lastNumberKey]
  );
  const lastUserRow = await getQuery(
    'SELECT value FROM counters WHERE key = ?',
    [lastUserKey]
  );

  const state = {
    lastNumber: Number.parseInt(lastNumberRow?.value ?? '0', 10),
    lastUserId: lastUserRow?.value ? String(lastUserRow.value) : null
  };

  countingCache.set(channelId, state);
  return state;
}

async function setCountingState(channelId, lastNumber, lastUserId) {
  countingCache.set(channelId, {
    lastNumber,
    lastUserId: lastUserId ?? null
  });
  const lastNumberKey = `counting_last:${channelId}`;
  const lastUserKey = `counting_last_user:${channelId}`;
  await runQuery(
    'INSERT INTO counters (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [lastNumberKey, String(lastNumber)]
  );
  await runQuery(
    'INSERT INTO counters (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [lastUserKey, lastUserId ?? '']
  );
}

async function handleThreadCreation(message) {
  if (!isConfiguredChannel(message.channel.id, config.threadChannelIds)) {
    return;
  }
  if (!message.guild || message.channel.type !== ChannelType.GuildText) {
    return;
  }

  const threadName = formatThreadName(message);
  await message.startThread({
    name: threadName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay
  });
}

async function handleConfession(message) {
  if (message.channel.id !== config.confessionChannelId) {
    return false;
  }

  if (!message.content?.trim()) {
    await message.delete();
    return true;
  }

  const result = await runQuery(
    'INSERT INTO confessions (author_id, created_at) VALUES (?, ?)',
    [message.author.id, new Date().toISOString()]
  );

  const confessionId = result.lastID;
  const embed = new EmbedBuilder()
    .setTitle('Confession anonyme')
    .setDescription(message.content.trim())
    .setColor(0xb07bff)
    .setFooter({ text: `Confession #${confessionId}` })
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
  await message.delete();
  return true;
}

async function createCountingErrorThread(message) {
  if (message.channel.type !== ChannelType.GuildText) {
    return;
  }

  try {
    await message.startThread({
      name: 'Discussion counting',
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay
    });
  } catch (error) {
    // Ignore thread creation errors to avoid blocking counting flow.
  }
}

async function handleCounting(message) {
  if (message.channel.id !== config.countingChannelId) {
    return false;
  }

  const lock = countingLocks.get(message.channel.id) ?? Promise.resolve();
  const nextLock = lock.then(async () => {
    const { lastNumber, lastUserId } = await getCountingState(message.channel.id);
    const nextNumber = lastNumber + 1;
    const parsed = parseCountingNumber(message.content);
    const isSameUser = lastUserId === message.author.id;

    if (parsed !== nextNumber || isSameUser) {
      await setCountingState(message.channel.id, 0, null);
      await message.react('❌');
      await createCountingErrorThread(message);
      const reasons = [];
      if (isSameUser) {
        reasons.push('Le même joueur ne peut pas jouer deux fois de suite.');
      }
      if (parsed !== nextNumber) {
        reasons.push(`Le bon nombre était **${nextNumber}**.`);
      }
      const errorEmbed = new EmbedBuilder()
        .setTitle('Counting - erreur')
        .setDescription(
          [
            ...reasons,
            'Le compteur repart à **1**.',
            'À vous de décider du gage dans le thread.'
          ].join('\n')
        )
        .setColor(0xff6b6b)
        .setTimestamp();
      await message.channel.send({
        content: `${message.author}`,
        embeds: [errorEmbed]
      });
      return true;
    }

    await setCountingState(message.channel.id, parsed, message.author.id);
    await message.react('✅');
    return true;
  });

  countingLocks.set(message.channel.id, nextLock.catch(() => {}));
  return nextLock;
}

async function handleAdminConfessionLookup(message) {
  if (message.guild) {
    return;
  }

  if (!isAdmin(message.author)) {
    return;
  }

  const [command, confessionIdRaw] = message.content.trim().split(/\s+/);
  if (command !== '!confession' || !confessionIdRaw) {
    return;
  }

  const confessionId = Number.parseInt(confessionIdRaw, 10);
  if (!Number.isInteger(confessionId)) {
    await message.channel.send('ID de confession invalide.');
    return;
  }

  const entry = await getQuery('SELECT author_id FROM confessions WHERE id = ?', [confessionId]);
  if (!entry) {
    await message.channel.send('Confession introuvable.');
    return;
  }

  await message.channel.send(`Confession #${confessionId} envoyée par <@${entry.author_id}>.`);
}

async function handleSupportCommand(message) {
  if (message.content.trim() !== '!support') {
    return false;
  }

  await message.channel.send(supportMessage);
  return true;
}

// ======= Word Game Functions =======

async function validateWordConnection(word1, word2) {
  const cacheKey = `${word1.toLowerCase()}|${word2.toLowerCase()}`;
  
  if (validatedPairs.has(cacheKey)) {
    return validatedPairs.get(cacheKey);
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a word association validator. Determine if two words are semantically or contextually related. Be lenient and accept creative connections. Answer with YES or NO followed by a brief explanation in French.'
        },
        {
          role: 'user',
          content: `Are the words "${word1}" and "${word2}" meaningfully related?`
        }
      ],
      max_tokens: 150,
      temperature: 0.3
    });

    const content = response.choices[0]?.message?.content || '';
    const normalized = content.trim();
    const isValid = /^(YES|OUI)\b/i.test(normalized);
    const explanation = normalized.replace(/^(YES|OUI|NO|NON)\b[:\s-]*/i, '').trim();

    const result = { isValid, explanation };
    validatedPairs.set(cacheKey, result);
    
    return result;
  } catch (error) {
    console.error('OpenAI API error:', error);
    return { isValid: false, explanation: 'Erreur de validation (API indisponible)' };
  }
}

async function generateNewWord() {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'Generate a single common French word that is neutral and easy to associate with other words. Respond with ONLY the word, nothing else.'
        },
        {
          role: 'user',
          content: 'Give me one word.'
        }
      ],
      max_tokens: 10,
      temperature: 0.8
    });

    const word = response.choices[0]?.message?.content?.trim() || 'soleil';
    return word.toLowerCase();
  } catch (error) {
    console.error('OpenAI API error:', error);
    const fallbackWords = ['soleil', 'chat', 'mer', 'arbre', 'musique', 'livre', 'fleur', 'étoile', 'montagne', 'rivière'];
    return fallbackWords[Math.floor(Math.random() * fallbackWords.length)];
  }
}

async function getWordGameState(channelId) {
  const row = await getQuery(
    'SELECT current_word, last_user_id, channel_streak FROM word_game_state WHERE channel_id = ?',
    [channelId]
  );

  return {
    currentWord: row?.current_word || null,
    lastUserId: row?.last_user_id || null,
    channelStreak: row?.channel_streak || 0
  };
}

async function setWordGameState(channelId, currentWord, lastUserId, channelStreak) {
  await runQuery(
    `INSERT INTO word_game_state (channel_id, current_word, last_user_id, channel_streak)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       current_word = excluded.current_word,
       last_user_id = excluded.last_user_id,
       channel_streak = excluded.channel_streak`,
    [channelId, currentWord, lastUserId, channelStreak]
  );
}

async function updateWordGameScore(userId, channelId, points, currentStreak) {
  const existing = await getQuery(
    'SELECT total_points, personal_best_streak FROM word_game_scores WHERE user_id = ? AND channel_id = ?',
    [userId, channelId]
  );

  const newTotalPoints = (existing?.total_points || 0) + points;
  const newBestStreak = Math.max(existing?.personal_best_streak || 0, currentStreak);

  await runQuery(
    `INSERT INTO word_game_scores (user_id, channel_id, total_points, personal_best_streak)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET
       total_points = excluded.total_points,
       personal_best_streak = excluded.personal_best_streak`,
    [userId, channelId, newTotalPoints, newBestStreak]
  );
}

function normalizeWord(raw) {
  if (!raw) return '';
  let w = String(raw).toLowerCase().trim();
  // Remove accents/diacritics
  w = w.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Basic French plural normalization
  if (w.endsWith('eaux')) {
    w = w.slice(0, -1 * 'eaux'.length) + 'eau';
  } else if (w.endsWith('aux')) {
    w = w.slice(0, -1 * 'aux'.length) + 'al';
  } else if (w.endsWith('oux')) {
    w = w.slice(0, -1 * 'oux'.length) + 'ou';
  } else if (w.length > 3 && (w.endsWith('s') || w.endsWith('x'))) {
    w = w.slice(0, -1);
  }
  return w;
}

async function isWordUsed(channelId, word) {
  const normalized = normalizeWord(word);
  const row = await getQuery(
    'SELECT 1 FROM word_game_history WHERE channel_id = ? AND word = ?',
    [channelId, normalized]
  );
  return Boolean(row);
}

async function addWordHistory(channelId, word) {
  const normalized = normalizeWord(word);
  await runQuery(
    'INSERT OR IGNORE INTO word_game_history (channel_id, word, created_at) VALUES (?, ?, ?)',
    [channelId, normalized, new Date().toISOString()]
  );
}

async function clearWordHistory(channelId) {
  await runQuery(
    'DELETE FROM word_game_history WHERE channel_id = ?',
    [channelId]
  );
}

async function createWordGameErrorThread(message) {
  if (message.channel.type !== ChannelType.GuildText) {
    return;
  }

  try {
    await message.startThread({
      name: 'Discussion - Mot rejeté',
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay
    });
  } catch (error) {
    // Ignore thread creation errors
  }
}

async function handleWordGame(message) {
  if (message.channel.id !== config.wordGameChannelId) {
    return false;
  }

  const userWord = message.content.trim().toLowerCase();
  
  // Ignore empty messages or commands
  if (!userWord || userWord.startsWith('!')) {
    return false;
  }

  // Only accept single words (allow hyphens for compound words)
  if (!/^[a-zàâäéèêëïîôùûüÿæœç-]+$/i.test(userWord)) {
    return false;
  }

  const lock = wordGameLocks.get(message.channel.id) ?? Promise.resolve();
  const nextLock = lock.then(async () => {
    const { currentWord, lastUserId, channelStreak } = await getWordGameState(message.channel.id);

    // Prevent same user from playing twice in a row
    if (lastUserId === message.author.id) {
      await message.react('❌');
      const sameUserEmbed = new EmbedBuilder()
        .setTitle('🚫 Tour consécutif interdit')
        .setDescription(
          `Tu as déjà joué le mot précédent (**${currentWord}**). ` +
          `Laisse quelqu'un d'autre répondre avant de rejouer.`
        )
        .setColor(0xff6b6b)
        .setFooter({ text: `Mot actuel: ${currentWord || '—'}` });

      await message.channel.send({ content: `${message.author}`, embeds: [sameUserEmbed] });
      return true;
    }

    // Reject reusing an already played word (channel history)
    if (await isWordUsed(message.channel.id, userWord)) {
      await message.react('❌');
      const duplicateEmbed = new EmbedBuilder()
        .setTitle('🔁 Mot déjà utilisé')
        .setDescription(
          `Le mot **${userWord}** (ou une de ses variantes) a déjà été joué dans ce canal.\n` +
          (currentWord
            ? `Essayez un mot différent lié à **${currentWord}**.`
            : 'Le jeu va bientôt démarrer avec un nouveau mot.')
        )
        .setColor(0xff6b6b);
      await message.channel.send({ content: `${message.author}`, embeds: [duplicateEmbed] });
      return true;
    }

    // Initialize game with first word
    if (!currentWord) {
      // Fresh start: clear previous history so old mots are reusing allowed
      await clearWordHistory(message.channel.id);
      await setWordGameState(message.channel.id, userWord, message.author.id, 0);
      await addWordHistory(message.channel.id, userWord);
      await message.react('🎯');
      
      const startEmbed = new EmbedBuilder()
        .setTitle('🎮 Jeu d\'Association de Mots')
        .setDescription(`Le jeu commence avec le mot : **${userWord}**\n\nProchaine personne, trouvez un mot lié !`)
        .setColor(0x5865f2)
        .setFooter({ text: 'Streak: 0 | Points: +1 par mot valide + bonus streak' });
      
      await message.channel.send({ embeds: [startEmbed] });
      return true;
    }

    // Validate connection with OpenAI
    const { isValid, explanation } = await validateWordConnection(currentWord, userWord);

    if (!isValid) {
      // Reset streak on error
      await setWordGameState(message.channel.id, null, null, 0);
      await clearWordHistory(message.channel.id);
      await message.react('❌');
      await createWordGameErrorThread(message);

      const errorEmbed = new EmbedBuilder()
        .setTitle('❌ Mot Rejeté')
        .setDescription(
          `**${userWord}** n'est pas suffisamment lié à **${currentWord}**.\n\n` +
          `**Raison :** ${explanation}\n\n` +
          `Le streak de **${channelStreak}** mot${channelStreak > 1 ? 's' : ''} est perdu ! 😢\n` +
          `L'historique des mots est réinitialisé.\nRelance en cours...`
        )
        .setColor(0xff6b6b)
        .setTimestamp();
      
      await message.channel.send({ content: `${message.author}`, embeds: [errorEmbed] });

      // Generate new starting word
      const newWord = await generateNewWord();
      await setWordGameState(message.channel.id, newWord, null, 0);
      await addWordHistory(message.channel.id, newWord);

      const restartEmbed = new EmbedBuilder()
        .setTitle('🔄 Nouveau Départ')
        .setDescription(`Le jeu reprend avec le mot : **${newWord}**`)
        .setColor(0xffa500)
        .setFooter({ text: 'À vous de jouer !' });
      
      await message.channel.send({ embeds: [restartEmbed] });
      return true;
    }

    // Valid word! Update state and score
    const newStreak = channelStreak + 1;
    const basePoints = 1;
    const streakBonus = Math.floor(newStreak / 10);
    const totalPoints = basePoints + streakBonus;

    await setWordGameState(message.channel.id, userWord, message.author.id, newStreak);
    await addWordHistory(message.channel.id, userWord);
    await updateWordGameScore(message.author.id, message.channel.id, totalPoints, newStreak);
    await message.react('✅');

    // Announce milestones only (5, 10, then every 50)
    const shouldAnnounce = newStreak === 5 || newStreak === 10 || newStreak % 50 === 0;
    if (shouldAnnounce) {
      const progressEmbed = new EmbedBuilder()
        .setDescription(
          `🔥 **Streak: ${newStreak}** mot${newStreak > 1 ? 's' : ''} !\n` +
          `${message.author} a gagné **${totalPoints}** point${totalPoints > 1 ? 's' : ''} ` +
          (streakBonus > 0 ? `(+${streakBonus} bonus streak) ` : '') + '!'
        )
        .setColor(0x57f287);
      
      await message.channel.send({ embeds: [progressEmbed] });
    }

    return true;
  });

  wordGameLocks.set(message.channel.id, nextLock.catch(() => {}));
  return nextLock;
}

async function handleWordStats(message) {
  const trimmed = message.content.trim();
  if (!trimmed.startsWith('!wordstats')) {
    return false;
  }

  const channelId = message.channel.id;
  const mentionMatch = trimmed.match(/<@!?(\d+)>/);
  const targetUserId = mentionMatch ? mentionMatch[1] : null;

  if (targetUserId) {
    // Show personal stats
    const userStats = await getQuery(
      'SELECT total_points, personal_best_streak FROM word_game_scores WHERE user_id = ? AND channel_id = ?',
      [targetUserId, channelId]
    );

    const gameState = await getWordGameState(channelId);

    const statsEmbed = new EmbedBuilder()
      .setTitle('📊 Statistiques Personnelles - Jeu de Mots')
      .setDescription(`Statistiques de <@${targetUserId}> dans ce canal`)
      .addFields(
        { name: '💯 Points Totaux', value: String(userStats?.total_points || 0), inline: true },
        { name: '🔥 Meilleur Streak', value: String(userStats?.personal_best_streak || 0), inline: true },
        { name: '📈 Streak Actuel', value: String(gameState.channelStreak), inline: true }
      )
      .setColor(0x5865f2)
      .setTimestamp();

    await message.channel.send({ embeds: [statsEmbed] });
    return true;
  }

  // Show leaderboard
  const topPlayers = await allQuery(
    'SELECT user_id, total_points, personal_best_streak FROM word_game_scores WHERE channel_id = ? ORDER BY total_points DESC LIMIT 10',
    [channelId]
  );

  const gameState = await getWordGameState(channelId);

  if (topPlayers.length === 0) {
    await message.channel.send('Aucune statistique disponible pour ce canal.');
    return true;
  }

  const leaderboardText = topPlayers
    .map((player, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
      return `${medal} <@${player.user_id}> — **${player.total_points}** pts (meilleur: ${player.personal_best_streak})`;
    })
    .join('\n');

  const leaderboardEmbed = new EmbedBuilder()
    .setTitle('🏆 Classement - Jeu de Mots')
    .setDescription(leaderboardText)
    .addFields(
      { name: '🎯 Mot Actuel', value: gameState.currentWord || 'Aucun', inline: true },
      { name: '🔥 Streak du Canal', value: String(gameState.channelStreak), inline: true }
    )
    .setColor(0xffd700)
    .setFooter({ text: 'Utilisez !wordstats @utilisateur pour voir les stats personnelles' })
    .setTimestamp();

  await message.channel.send({ embeds: [leaderboardEmbed] });
  return true;
}

// Story Collaborative Handlers (replaced by slash commands)

async function finishStory(channel, story) {
  const fullText = story.phrases.join(' ');
  let summary = 'Une histoire riche et captivante s\'est déroulée.';

  try {
    let systemPrompt;
    
    if (story.mode === 'roleplay') {
      // Pour roleplay: paroles dramatiques avec verbes expressifs
      systemPrompt = `Tu es un narrateur dramatique et HILARANT. Fais un résumé (MAX 100 LIGNES) du roleplay avec des répliques des personnages accompagnées de verbes EXPRESSIFS et DRAMATIQUES. 

VERBES À UTILISER: s'exclama, hurla, murmura, cria, gémit, haleta, souffla, chuchota, gronda, rugit, grogna, soupira, bégaya, bredouilla, clama, proclama, déclara solennellement, supplia, implora, ricana, rit, sanglota, pleura, trembla, balbutia, etc.

Exemple: "Henergyque s'exclama avec passion: 'C'est GENIAL!'" ou "Le super-héros hurla d'indignation: 'NON, C'EST IMPOSSIBLE!'"

Rends ça DRAMATIQUE, ABSURDE et HILARANT! Ajoute des didascalies avec des actions entre crochets [pause dramatique], [regarde fixement], [s'effondre], etc. AUCUNE CENSURE. Si c'est NSFW, va-y à fond avec les vannes!`;
    } else {
      // Pour classic: résumé critique normal
      systemPrompt = 'Tu es un critique COMPLÈTEMENT DÉJANTÉ et HILARANT. Fais un résumé COURT ET PUNCHY (MAX 100 LIGNES) de cette histoire avec des VANNES DE MALADE, des commentaires ABSURDES et une ironie DÉVASTATRICE. Reprends les moments les plus fous MOT POUR MOT (même les trucs salaces/NSFW) et EXPLOSE-TOI dessus avec des blagues démentes. Sois DRAMATIQUE, EXAGÉRÉ, et fais des comparaisons complètement pétées. AUCUNE CENSURE. Balance TOUT. Fais-nous mourir de rire! SURTOUT si c\'est NSFW/sexuel, là tu dois VRAIMENT te lâcher avec des vannes de OUF, des jeux de mots douteux, des comparaisons hilarantes. C\'est le moment de faire le SHOW! IMPORTANT: Unifie TOUS les surnoms vers les pseudos complets (Hener, Henergyque = MÊME personne). Reconnaître automatiquement qui parle de qui.';
    }

    const response = await grok.chat.completions.create({
      model: 'grok-4-fast-reasoning',
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: `Histoire: ${fullText}`
        }
      ],
      max_tokens: 1000,
      temperature: 1.0
    });

    summary = response.choices[0].message.content.trim();
  } catch (err) {
    console.error('❌ Erreur Grok:', err.message);
    console.error('Code erreur:', err.code);
  }

  const uniqueContributors = new Set(story.contributors).size;

  const endEmbed = new EmbedBuilder()
    .setTitle('📖 Histoire Terminée!')
    .setDescription(summary)
    .addFields(
      { name: '🎭 Thème', value: story.theme, inline: true },
      { name: '📝 Phrases', value: String(story.phrases.length), inline: true },
      { name: '👥 Contributeurs', value: String(uniqueContributors), inline: true }
    )
    .setColor(0xc1121f)
    .setTimestamp();

  // Envoyer dans le salon bibliothèque
  if (config.storyLibraryChannelId) {
    try {
      const libraryChannel = await client.channels.fetch(config.storyLibraryChannelId);
      if (libraryChannel) {
        await libraryChannel.send({ embeds: [endEmbed] });
      }
    } catch (err) {
      console.error('Erreur envoi bibliothèque:', err);
      // Fallback: envoyer dans le canal courant
      await channel.send({ embeds: [endEmbed] });
    }
  } else {
    // Si pas de config, envoyer dans le canal courant
    await channel.send({ embeds: [endEmbed] });
  }

  // Save to database with timestamp
  await runQuery(
    `UPDATE story_sessions SET phrases = ?, contributors = ?, phrase_count = ? WHERE channel_id = ?`,
    [JSON.stringify(story.phrases), JSON.stringify(story.contributors), story.phrases.length, channel.id]
  );
}

async function handleStoryContribution(message) {
  const channelId = message.channel.id;

  if (!activeStories.has(channelId)) {
    return false;
  }

  const story = activeStories.get(channelId);

  // Skip if in waiting phase
  if (story.isWaiting) {
    return false;
  }

  // Ignore command messages
  if (message.content.trim().startsWith('!') || message.content.trim().startsWith('/')) {
    return false;
  }

  // Check if this user already contributed this turn
  if (story.lastContributorId === message.author.id) {
    await message.react('❌');
    return true;
  }

  // Count phrases (roughly by punctuation marks)
  const phraseCount = (message.content.match(/[.!?]/g) || []).length || 1;

  if (phraseCount > 3) {
    await message.reply('Max 3 phrases par contribution! 📝');
    return true;
  }

  // Determine tag (role if roleplay, username if classic)
  let tag = message.author.username;
  if (story.mode === 'roleplay' && story.roles[message.author.id]) {
    tag = `${story.roles[message.author.id].role} | ${message.author.username}`;
  }

  // Add contribution
  story.phrases.push(`[${tag}]: ${message.content}`);
  if (!story.contributors.includes(message.author.id)) {
    story.contributors.push(message.author.id);
  }
  story.lastContributorId = message.author.id;

  // Check if story reached limit
  if (story.phrases.length >= 75) {
    await finishStory(message.channel, story);
    activeStories.delete(channelId);
    return true;
  }

  // Acknowledge contribution
  const milestone = story.phrases.length;
  if (milestone % 10 === 0) {
    const progressEmbed = new EmbedBuilder()
      .setTitle('📖 Progression')
      .setDescription(`L'histoire atteint ${milestone} phrases! 🎉`)
      .setColor(0x9d4edd)
      .setTimestamp();
    await message.react('✅');
    await message.channel.send({ embeds: [progressEmbed] });
  } else {
    await message.react('✅');
  }

  // Update database
  await runQuery(
    `UPDATE story_sessions SET phrases = ?, contributors = ?, roles = ?, last_contributor_id = ?, phrase_count = ? WHERE channel_id = ?`,
    [JSON.stringify(story.phrases), JSON.stringify(story.contributors), JSON.stringify(story.roles), message.author.id, story.phrases.length, channelId]
  );

  return true;
}

// Handle /roast command
async function handleRoastCommand(interaction) {
  try {
    const targetUser = interaction.options.getUser('cible');
    const targetMember = await interaction.guild.members.fetch(targetUser.id);
    const displayName = targetMember.displayName || targetUser.username;

    // Defer car Grok peut être lent
    await interaction.deferReply();

    let roast = '🔥 Cette personne est tellement chiante qu\'elle fait fuir même les bugs!';

    try {
      const response = await grok.chat.completions.create({
        model: 'grok-4-fast-reasoning',
        messages: [
          {
            role: 'system',
            content: `Tu es un comédien HILARANT et SANS FILTRE. Génère une insulte drôle et ABSURDE envers une personne. Sois BRUTAL, EXAGÉRÉ et STUPIDEMENT DRÔLE! Utilise des comparaisons pétées, des métaphores bizarres, et des blagues dégueulasses si possible. MAX 3 phrases. AUCUNE CENSURE - va-y hardcore!`
          },
          {
            role: 'user',
            content: `Insulte drôlement: ${displayName}`
          }
        ],
        max_tokens: 200,
        temperature: 1.0
      });

      roast = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur Grok roast:', err.message);
    }

    await interaction.editReply({ content: `🔥 ${targetUser}: ${roast}` });
  } catch (err) {
    console.error('❌ Erreur /roast:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Helper: Get debate intensity level based on message count
function getDebateIntensity(messageCount) {
  if (messageCount <= 2) return 1; // Sérieux avec sarcasme léger
  if (messageCount <= 4) return 2; // Agressif, premières insultes
  return 3; // Full chaos
}

// Helper: Get system prompt for Grok based on intensity
function getGrokSystemPrompt(intensity, target = 'argument') {
  if (intensity === 1) {
    return 'Tu es un débateur intelligent et un peu sarcastique. Quelqu\'un vient de ' + target + '. RÉPONDS D\'ABORD À SA QUESTION avec un vrai argument, puis ajoute un peu de sarcasme léger. MAX 4 phrases, sois pertinent et malin!';
  } else if (intensity === 2) {
    return 'Tu es un débateur agressif et sarcastique. Quelqu\'un vient de ' + target + '. D\'ABORD réponds vraiment à son argument avec des contrepoints solides, PUIS taclée-le avec du sarcasme mordant et des piques. MAX 4 phrases, sois méchant mais utile!';
  } else {
    return 'Tu es Grok, un débateur IMPITOYABLE. Quelqu\'un vient de ' + target + '? RÉPONDS À SON ARGUMENT avec un vrai contrepoint TOUT EN L\'INSULTANT, en le taquinant, en faisant du sarcasme brutal. Sois agressif, drôle, méchant, mais dis quelque chose d\'intéressant! Max 4 phrases, SOIS CHAOS PERTINENT!';
  }
}

// Helper: Get system prompt for OpenAI based on intensity
function getOpenaiSystemPrompt(intensity, target = 'argument') {
  if (intensity === 1) {
    return 'Tu es un débateur expert et un peu ironique. Quelqu\'un vient de ' + target + '. RÉPONDS D\'ABORD À SA QUESTION avec de vrais arguments, puis ajoute un peu d\'ironie. MAX 4 phrases, sois pertinent!';
  } else if (intensity === 2) {
    return 'Tu es un débateur agressif et sarcastique. Quelqu\'un vient de ' + target + '. D\'ABORD réponds vraiment avec des contrepoints intelligents, PUIS taclée-le avec du sarcasme mordant et des critiques. MAX 4 phrases, sois méchant mais argumenté!';
  } else {
    return 'Tu es OpenAI, un débateur IMPITOYABLE et corrosif. Quelqu\'un vient de ' + target + '? RÉPONDS À SON ARGUMENT avec des points solides TOUT EN L\'INSULTANT sans retenue, en étant sarcasrique, en le moquant. Sois brutal mais pertinent! Max 4 phrases, SOIS VENIMEUX ET INTELLIGENT!';
  }
}

// Handle /debate-respond command
async function handleDebateRespondCommand(interaction) {
  try {
    const argument = interaction.options.getString('argument');
    const userName = interaction.user.username;

    // Defer car ça appelle les IAs
    await interaction.deferReply();

    // Message 1: L'argument de l'utilisateur
    const userEmbed = new EmbedBuilder()
      .setTitle('👤 ' + userName + ' propose')
      .setDescription(argument)
      .setColor(0x808080);

    await interaction.editReply({ embeds: [userEmbed] });

    // Message 2: OpenAI analyse l'argument
    let openaiResponse = 'Erreur...';
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Tu es un débateur expert et analytique. Quelqu\'un a proposé un argument. Analyse-le de manière critique et intelligente. MAX 4 phrases, sois pertinent!'
          },
          {
            role: 'user',
            content: `Argument proposé: ${argument}`
          }
        ],
        max_tokens: 250
      });
      openaiResponse = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur OpenAI debate-respond:', err.message);
    }

    const openaiEmbed = new EmbedBuilder()
      .setTitle('🤖 OpenAI analyse')
      .setDescription(openaiResponse)
      .setColor(0x00a8ff);

    await interaction.channel.send({ embeds: [openaiEmbed] });

    // Message 3: Grok rebondit sur l'analyse d'OpenAI
    let grokResponse = 'Erreur...';
    try {
      const response = await grok.chat.completions.create({
        model: 'grok-4-fast-reasoning',
        messages: [
          {
            role: 'system',
            content: 'Tu es un débateur intelligent et critique. OpenAI vient de faire une analyse. Contredis-le intelligemment ou ajoute des nuances. MAX 4 phrases, sois pertinent!'
          },
          {
            role: 'user',
            content: `L'argument initial était: "${argument}"\n\nOpenAI a répondu: "${openaiResponse}"\n\nToi, tu penses quoi?`
          }
        ],
        max_tokens: 250,
        temperature: 0.8
      });
      grokResponse = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur Grok debate-respond:', err.message);
    }

    const grokEmbed = new EmbedBuilder()
      .setTitle('🧠 Grok rebondit')
      .setDescription(grokResponse)
      .setColor(0x10a37f);

    await interaction.channel.send({ embeds: [grokEmbed] });

    // Message 4: OpenAI conclut
    let openaiConclude = 'Erreur...';
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Tu es un débateur expert. Après avoir entendu la critique de Grok, conclus intelligemment. MAX 4 phrases, soit incisif!'
          },
          {
            role: 'user',
            content: `Argument initial: "${argument}"\nTa première analyse: "${openaiResponse}"\nGrok a répliqué: "${grokResponse}"\n\nConclus.`
          }
        ],
        max_tokens: 250
      });
      openaiConclude = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur OpenAI conclude:', err.message);
    }

    const concludeEmbed = new EmbedBuilder()
      .setTitle('🤖 OpenAI conclut')
      .setDescription(openaiConclude)
      .setColor(0x00a8ff);

    await interaction.channel.send({ embeds: [concludeEmbed] });
  } catch (err) {
    console.error('❌ Erreur /debate-respond:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Handle /debate-respond-grok command
async function handleDebateRespondGrokCommand(interaction) {
  try {
    const argument = interaction.options.getString('argument');
    const userName = interaction.user.username;
    const channelId = interaction.channelId;

    await interaction.deferReply();

    // Track debate progression
    if (!debateState.has(channelId)) {
      debateState.set(channelId, 0);
    }
    let messageCount = debateState.get(channelId);
    messageCount += 3; // 3 messages per call
    debateState.set(channelId, messageCount);

    const intensity = getDebateIntensity(messageCount);

    // Message 1: L'argument de l'utilisateur
    const userEmbed = new EmbedBuilder()
      .setTitle('👤 ' + userName + ' attaque Grok')
      .setDescription(argument)
      .setColor(0x808080);

    await interaction.editReply({ embeds: [userEmbed] });

    // Message 2: Grok répond
    let grokResponse = 'Erreur...';
    try {
      const response = await grok.chat.completions.create({
        model: 'grok-4-fast-reasoning',
        messages: [
          {
            role: 'system',
            content: getGrokSystemPrompt(intensity, 'dit quelque chose de stupide')
          },
          {
            role: 'user',
            content: `L'utilisateur dit: ${argument}`
          }
        ],
        max_tokens: 250,
        temperature: intensity === 3 ? 1.0 : 0.8
      });
      grokResponse = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur Grok debate-respond-grok:', err.message);
    }

    const grokEmbed = new EmbedBuilder()
      .setTitle('🧠 Grok répond')
      .setDescription(grokResponse)
      .setColor(0x10a37f);

    await interaction.channel.send({ embeds: [grokEmbed] });

    // Message 3: OpenAI commente
    let openaiComment = 'Erreur...';
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: getOpenaiSystemPrompt(intensity, 'vu Grok répondre') + ' Taquine Grok sur sa réponse!'
          },
          {
            role: 'user',
            content: `L'utilisateur a attaqué Grok en disant: "${argument}"\n\nGrok a répondu: "${grokResponse}"\n\nTon avis?`
          }
        ],
        max_tokens: 250,
        temperature: intensity === 3 ? 0.95 : 0.7
      });
      openaiComment = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur OpenAI debate-respond-grok:', err.message);
    }

    const openaiEmbed = new EmbedBuilder()
      .setTitle('🤖 OpenAI commente')
      .setDescription(openaiComment)
      .setColor(0x00a8ff);

    await interaction.channel.send({ embeds: [openaiEmbed] });
  } catch (err) {
    console.error('❌ Erreur /debate-respond-grok:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Handle /debate-respond-openai command
async function handleDebateRespondOpenaiCommand(interaction) {
  try {
    const argument = interaction.options.getString('argument');
    const userName = interaction.user.username;
    const channelId = interaction.channelId;

    await interaction.deferReply();

    // Track debate progression
    if (!debateState.has(channelId)) {
      debateState.set(channelId, 0);
    }
    let messageCount = debateState.get(channelId);
    messageCount += 3; // 3 messages per call
    debateState.set(channelId, messageCount);

    const intensity = getDebateIntensity(messageCount);

    // Message 1: L'argument de l'utilisateur
    const userEmbed = new EmbedBuilder()
      .setTitle('👤 ' + userName + ' attaque OpenAI')
      .setDescription(argument)
      .setColor(0x808080);

    await interaction.editReply({ embeds: [userEmbed] });

    // Message 2: OpenAI répond
    let openaiResponse = 'Erreur...';
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: getOpenaiSystemPrompt(intensity, 'dit quelque chose de stupide')
          },
          {
            role: 'user',
            content: `L'utilisateur dit: ${argument}`
          }
        ],
        max_tokens: 250,
        temperature: intensity === 3 ? 1.0 : 0.7
      });
      openaiResponse = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur OpenAI debate-respond-openai:', err.message);
    }

    const openaiEmbed = new EmbedBuilder()
      .setTitle('🤖 OpenAI répond')
      .setDescription(openaiResponse)
      .setColor(0x00a8ff);

    await interaction.channel.send({ embeds: [openaiEmbed] });

    // Message 3: Grok contre-attaque
    let grokComment = 'Erreur...';
    try {
      const response = await grok.chat.completions.create({
        model: 'grok-4-fast-reasoning',
        messages: [
          {
            role: 'system',
            content: getGrokSystemPrompt(intensity, 'vu OpenAI répondre') + ' Taquine OpenAI sur sa réponse!'
          },
          {
            role: 'user',
            content: `L'utilisateur a attaqué OpenAI en disant: "${argument}"\n\nOpenAI a répondu: "${openaiResponse}"\n\nTon avis?`
          }
        ],
        max_tokens: 250,
        temperature: intensity === 3 ? 1.0 : 0.8
      });
      grokComment = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur Grok debate-respond-openai:', err.message);
    }

    const grokEmbed = new EmbedBuilder()
      .setTitle('🧠 Grok commente')
      .setDescription(grokComment)
      .setColor(0x10a37f);

    await interaction.channel.send({ embeds: [grokEmbed] });
  } catch (err) {
    console.error('❌ Erreur /debate-respond-openai:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Handle /versusai command
async function handleVersusAiCommand(interaction) {
  try {
    const sujet = interaction.options.getString('sujet');

    // Defer car ça appelle plusieurs fois les IA
    await interaction.deferReply();

    let openai1 = '', grok1 = '', openai2 = '', grok2 = '';

    // TOUR 1: OpenAI présente son argument
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Tu es un débateur expert. Présente un argument SOLIDE et RÉFLÉCHI sur ce sujet. Sois persuasif. MAX 3 phrases.'
          },
          {
            role: 'user',
            content: `Débat: ${sujet}`
          }
        ],
        max_tokens: 250
      });
      openai1 = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur OpenAI tour 1:', err.message);
      openai1 = 'Erreur OpenAI...';
    }

    // TOUR 1: Grok contre-argumente
    try {
      const response = await grok.chat.completions.create({
        model: 'grok-4-fast-reasoning',
        messages: [
          {
            role: 'system',
            content: 'Tu es un débateur intelligent. Réponds à cet argument de façon CRITIQUE et LOGIQUE. Sois intelligent et pertinent. MAX 3 phrases. Pas de débilité, sois sérieux!'
          },
          {
            role: 'user',
            content: `Argument à contredire: ${openai1}\n\nSujet du débat: ${sujet}`
          }
        ],
        max_tokens: 250,
        temperature: 0.8
      });
      grok1 = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur Grok tour 1:', err.message);
      grok1 = 'Erreur Grok...';
    }

    // TOUR 2: OpenAI répond à Grok
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Continue le débat. Réponds à la critique et renforce ton argument. MAX 3 phrases.'
          },
          {
            role: 'user',
            content: `Mon argument: ${openai1}\n\nLa critique: ${grok1}`
          }
        ],
        max_tokens: 250
      });
      openai2 = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur OpenAI tour 2:', err.message);
      openai2 = 'Erreur OpenAI...';
    }

    // TOUR 2: Grok conclut
    try {
      const response = await grok.chat.completions.create({
        model: 'grok-4-fast-reasoning',
        messages: [
          {
            role: 'system',
            content: 'Conclus le débat intelligemment. Synthétise et donne ton dernier mot pertinent. MAX 3 phrases. Sois intelligent!'
          },
          {
            role: 'user',
            content: `Mon argument initial: ${grok1}\n\nSa réplique: ${openai2}`
          }
        ],
        max_tokens: 250,
        temperature: 0.8
      });
      grok2 = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur Grok tour 2:', err.message);
      grok2 = 'Erreur Grok...';
    }

    // Afficher les 4 messages du débat
    const embed1 = new EmbedBuilder()
      .setTitle('📌 ' + sujet)
      .setDescription('**OpenAI - Argument Initial**\n\n' + openai1)
      .setColor(0x00a8ff)
      .setFooter({ text: 'Tour 1/2' });

    const embed2 = new EmbedBuilder()
      .setDescription('**Grok - Contre-Argument**\n\n' + grok1)
      .setColor(0x10a37f)
      .setFooter({ text: 'Tour 1/2' });

    const embed3 = new EmbedBuilder()
      .setDescription('**OpenAI - Réplique**\n\n' + openai2)
      .setColor(0x00a8ff)
      .setFooter({ text: 'Tour 2/2' });

    const embed4 = new EmbedBuilder()
      .setDescription('**Grok - Conclusion**\n\n' + grok2)
      .setColor(0x10a37f)
      .setFooter({ text: 'Tour 2/2 - FIN' });

    await interaction.editReply({ embeds: [embed1] });
    await interaction.channel.send({ embeds: [embed2] });
    await interaction.channel.send({ embeds: [embed3] });
    await interaction.channel.send({ embeds: [embed4] });
  } catch (err) {
    console.error('❌ Erreur /versusai:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Handle /clear command
async function handleClearCommand(interaction) {
  try {
    // Vérifier que c'est le creator
    if (interaction.user.id !== config.creatorId) {
      await interaction.reply({ content: '❌ Seul le créateur du bot peut utiliser cette commande.', ephemeral: true });
      return;
    }

    const nombre = interaction.options.getInteger('nombre');

    // Defer la réponse car ça peut prendre du temps
    await interaction.deferReply();

    // Supprimer les messages
    const messages = await interaction.channel.messages.fetch({ limit: nombre });
    const deleted = await interaction.channel.bulkDelete(messages, true);

    // Répondre avec le nombre de messages supprimés
    await interaction.editReply({ content: `✅ ${deleted.size} messages ont été supprimés dans ce salon.` });
  } catch (err) {
    console.error('❌ Erreur /clear:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Roleplay/Story Slash Commands

// Handle /story start (classic or roleplay mode)
async function handleStorySlashStart(interaction) {
  try {
    const channelId = interaction.channelId;
    const theme = interaction.options.getString('theme');
    const mode = interaction.options.getString('mode') || 'classic';

    if (activeStories.has(channelId)) {
      await interaction.reply({ content: 'Une histoire est déjà en cours dans ce salon.', ephemeral: true });
      return;
    }

    const story = {
      theme,
      mode,
      phrases: [],
      contributors: [],
      lastContributorId: interaction.user.id,
      startedAt: new Date().toISOString(),
      roles: {},
      waitingRoster: {},
      isWaiting: mode === 'roleplay' ? 1 : 0
    };

    activeStories.set(channelId, story);

    // Save to DB
    await runQuery(
      `INSERT OR REPLACE INTO story_sessions (channel_id, theme, mode, phrases, contributors, roles, last_contributor_id, started_at, phrase_count, waiting_roster, is_waiting)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [channelId, theme, mode, JSON.stringify([]), JSON.stringify([]), JSON.stringify({}), interaction.user.id, story.startedAt, 0, JSON.stringify({}), story.isWaiting]
    );

    if (mode === 'roleplay') {
      // Waiting room for roleplay (rapide, pas de defer nécessaire)
      const waitEmbed = new EmbedBuilder()
        .setTitle('🎭 Roleplay - Salle d\'Attente')
        .setDescription(`**Thème:** ${theme}`)
        .addFields(
          { name: '📝 Instructions', value: 'Utilisez `/story join` pour vous enregistrer avec un rôle.\nLe lanceur fait `/story ready` pour commencer.', inline: false },
          { name: '👥 Roster', value: 'Aucun joueur inscrit pour le moment', inline: false }
        )
        .setColor(0x9d4edd)
        .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
        .setTimestamp();

      await interaction.reply({ embeds: [waitEmbed] });
    } else {
      // Classic mode: defer car Grok peut être lent
      await interaction.deferReply();

      let openingPhrase = 'Il était une fois...';
      try {
        const response = await grok.chat.completions.create({
          model: 'grok-4-fast-reasoning',
          messages: [
            {
              role: 'system',
              content: 'Tu es un narrateur créatif et SANS FILTRE. Crée l\'ouverture d\'une histoire basée sur le thème donné, en une seule phrase courte (max 30 mots). Aucune censure.'
            },
            {
              role: 'user',
              content: `Thème: ${theme}`
            }
          ],
          max_tokens: 100,
          temperature: 0.8
        });

        openingPhrase = response.choices[0].message.content.trim();
      } catch (grokErr) {
        console.error('❌ Erreur Grok ouverture:', grokErr.message);
      }

      story.phrases.push(openingPhrase);
      story.contributors.push(interaction.user.id);

      // Save opening to DB
      await runQuery(
        `UPDATE story_sessions SET phrases = ?, contributors = ?, phrase_count = ? WHERE channel_id = ?`,
        [JSON.stringify(story.phrases), JSON.stringify(story.contributors), 1, channelId]
      );

      const startEmbed = new EmbedBuilder()
        .setTitle('📖 Histoire Collective Lancée!')
        .setDescription(`**Thème:** ${theme}`)
        .addFields(
          { name: '✨ Ouverture', value: openingPhrase, inline: false },
          { name: '📝 Instructions', value: 'Écrivez vos phrases pour continuer l\'histoire. Max 3 phrases par contribution, une seule personne à la fois.', inline: false },
          { name: '⏱️ Limite', value: 'L\'histoire s\'arrête à 75 phrases', inline: false }
        )
        .setColor(0x9d4edd)
        .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
        .setTimestamp();

      await interaction.editReply({ embeds: [startEmbed] });
    }
  } catch (err) {
    console.error('❌ Erreur handleStorySlashStart:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Handle /story join (roleplay mode)
async function handleStorySlashJoin(interaction) {
  try {
    const channelId = interaction.channelId;
    const role = interaction.options.getString('role');

    const story = activeStories.get(channelId);
    if (!story) {
      await interaction.reply({ content: 'Aucune histoire en cours dans ce salon.', ephemeral: true });
      return;
    }

  if (story.mode === 'classic') {
    await interaction.reply({ content: 'Commande roleplay uniquement. Utilisez le mode roleplay avec `/story start`.', ephemeral: true });
    return;
  }

  // If waiting phase, add to waitingRoster
  if (story.isWaiting) {
    story.waitingRoster[interaction.user.id] = { username: interaction.user.username, role };
    await interaction.reply({ content: `✅ ${interaction.user.username} s\'enregistre en tant que **${role}**`, ephemeral: false });
  } else {
    // Mid-game join: generate transition
    story.roles[interaction.user.id] = { username: interaction.user.username, role };
    story.contributors.push(interaction.user.id);

    let transition = 'Soudain, un nouveau personnage arrive sur scène...';
    try {
      const fullText = story.phrases.join(' ');
      const response = await grok.chat.completions.create({
        model: 'grok-4-fast-reasoning',
        messages: [
          {
            role: 'system',
            content: `Tu es un narrateur créatif. Génère UNE SEULE phrase courte (max 15 mots) pour intégrer un nouveau personnage "${role}" dans cette histoire. Sois DRÔLE, contextuel, et inattendu. La phrase doit être une transition naturelle.`
          },
          {
            role: 'user',
            content: `Thème: ${story.theme}\nHistoire jusqu'à présent: ${fullText}`
          }
        ],
        max_tokens: 50,
        temperature: 1.0
      });

      transition = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur Grok transition:', err.message);
    }

    story.phrases.push(`[${role} | ${interaction.user.username}]: ${transition}`);
    story.lastContributorId = interaction.user.id;

    // Update DB
    await runQuery(
      `UPDATE story_sessions SET phrases = ?, roles = ?, contributors = ?, last_contributor_id = ?, phrase_count = ? WHERE channel_id = ?`,
      [JSON.stringify(story.phrases), JSON.stringify(story.roles), JSON.stringify(story.contributors), interaction.user.id, story.phrases.length, channelId]
    );

    await interaction.reply({ content: `✅ ${role} rejoint l'histoire!\n${transition}`, ephemeral: false });
  }
  } catch (err) {
    console.error('❌ Erreur handleStorySlashJoin:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Handle /story ready (start from waiting phase)
async function handleStorySlashReady(interaction) {
  try {
    const channelId = interaction.channelId;
    const story = activeStories.get(channelId);

    if (!story) {
      await interaction.reply({ content: 'Aucune histoire en cours.', ephemeral: true });
      return;
    }

    if (!story.isWaiting || story.mode !== 'roleplay') {
      await interaction.reply({ content: 'Cette histoire n\'est pas en mode d\'attente roleplay.', ephemeral: true });
      return;
    }

    if (Object.keys(story.waitingRoster).length === 0) {
      await interaction.reply({ content: 'Aucun joueur inscrit. Faites `/story join` d\'abord.', ephemeral: true });
      return;
    }

    // Confirm launch
    story.isWaiting = 0;
    story.roles = { ...story.waitingRoster };
    story.contributors = Object.keys(story.waitingRoster);
    story.lastContributorId = null;

    // Defer reply pour éviter timeout si Grok est lent
    await interaction.deferReply();

    // Generate opening with roster
    let openingPhrase = 'Il était une fois...';
    const rosterList = Object.values(story.roles).map(r => `${r.role} (${r.username})`).join(', ');

    try {
      const response = await grok.chat.completions.create({
        model: 'grok-4-fast-reasoning',
        messages: [
          {
            role: 'system',
            content: 'Tu es un narrateur créatif. Génère une ouverture (1-2 phrases max) d\'histoire qui introduit naturellement les personnages donnés. Sois DRÔLE si possible.'
          },
          {
            role: 'user',
            content: `Thème: ${story.theme}\nPersonnages: ${rosterList}`
          }
        ],
        max_tokens: 100,
        temperature: 0.8
      });

      openingPhrase = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur Grok ouverture roleplay:', err.message);
    }

    story.phrases.push(openingPhrase);

    // Update DB
    await runQuery(
      `UPDATE story_sessions SET phrases = ?, roles = ?, is_waiting = 0, phrase_count = 1 WHERE channel_id = ?`,
      [JSON.stringify(story.phrases), JSON.stringify(story.roles), channelId]
    );

    const rosterText = Object.values(story.roles)
      .map(r => `• **${r.role}** - ${r.username}`)
      .join('\n');

    const startEmbed = new EmbedBuilder()
      .setTitle('🎭 Roleplay Lancé!')
      .setDescription(`**Thème:** ${story.theme}`)
      .addFields(
        { name: '✨ Ouverture', value: openingPhrase, inline: false },
        { name: '👥 Personnages', value: rosterText, inline: false },
        { name: '📝 Règles', value: 'Contributions libres, max 3 phrases par tour. Pas deux fois d\'affilée!', inline: false }
      )
      .setColor(0x9d4edd)
      .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp();

    await interaction.editReply({ embeds: [startEmbed] });
  } catch (err) {
    console.error('❌ Erreur handleStorySlashReady:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Handle /story end
async function handleStorySlashEnd(interaction) {
  try {
    const channelId = interaction.channelId;
    const story = activeStories.get(channelId);

    if (!story) {
      await interaction.reply({ content: 'Aucune histoire en cours.', ephemeral: true });
      return;
    }

    // Defer car finishStory utilise Grok (peut être lent)
    await interaction.deferReply();

    await finishStory(interaction.channel, story);
    activeStories.delete(channelId);
    
    const libraryChannelName = config.storyLibraryChannelId ? '<#' + config.storyLibraryChannelId + '>' : 'la Bibliothèque';
    await interaction.editReply({ content: `✅ Histoire terminée et envoyée dans ${libraryChannelName}!` });
  } catch (err) {
    console.error('❌ Erreur handleStorySlashEnd:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

function createActionVeriteEmbed() {
  return new EmbedBuilder()
    .setTitle('Action ou Vérité')
    .setDescription(
      [
        `Tapez \`${actionVeriteCommand}\` pour ouvrir le jeu.`,
        'Cliquez sur **Action** ou **Vérité** pour jouer.',
        'Une seule personne à la fois — utilisez **Terminé** pour libérer le verrou.'
      ].join('\n')
    )
    .setColor(0xffc857)
    .setTimestamp();
}

function createActionVeriteRow(isLocked) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('action-verite:action')
      .setLabel('Action')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(isLocked),
    new ButtonBuilder()
      .setCustomId('action-verite:verite')
      .setLabel('Vérité')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isLocked),
    new ButtonBuilder()
      .setCustomId('action-verite:termine')
      .setLabel('Terminé')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!isLocked)
  );
}

async function handleActionVeriteCommand(message) {
  if (!message.guild || message.channel.type !== ChannelType.GuildText) {
    return false;
  }

  const trimmed = message.content.trim();
  if (trimmed !== actionVeriteCommand && trimmed !== '!av') {
    return false;
  }

  const gameMessage = await message.channel.send({
    embeds: [createActionVeriteEmbed()],
    components: [createActionVeriteRow(false)]
  });

  actionVeriteGames.set(gameMessage.id, {
    channelId: message.channel.id,
    activeUserId: null,
    threadId: null
  });

  return true;
}

function createQuizThemeEmbed() {
  const description = quizThemes
    .map((theme, index) => `${quizThemeEmojis[index]} **${theme.name}**`)
    .join('\n');
  return new EmbedBuilder()
    .setTitle('Quiz - Choisissez le thème')
    .setDescription(description)
    .setColor(0x5dade2)
    .setFooter({ text: 'Réagissez pour voter (égalité → aléatoire).' })
    .setTimestamp();
}

function createQuizQuestionEmbed(themeName, questionIndex, question) {
  const options = question.options
    .map((option, index) => `${quizAnswerEmojis[index]} ${option}`)
    .join('\n');
  return new EmbedBuilder()
    .setTitle(`Quiz - ${themeName}`)
    .setDescription(`**Question ${questionIndex + 1} / ${quizQuestionCount}**\n${question.question}\n\n${options}`)
    .setColor(0x45b39d)
    .setFooter({ text: `Temps limité : ${quizQuestionDurationMs / 1000}s` })
    .setTimestamp();
}

function createQuizLeaderboardEmbed(scores) {
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const lines = sorted.length
    ? sorted.map(([userId, score], index) => `**${index + 1}.** <@${userId}> — ${score} pt(s)`).join('\n')
    : 'Aucun point marqué.';
  return new EmbedBuilder()
    .setTitle('Quiz - Classement final')
    .setDescription(lines)
    .setColor(0xf7dc6f)
    .setTimestamp();
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function handleQuizCommand(message) {
  if (!message.guild || message.channel.type !== ChannelType.GuildText) {
    return false;
  }

  if (message.content.trim() !== '!quiz') {
    return false;
  }

  if (activeQuiz) {
    await message.channel.send('Un quiz est déjà en cours. Merci d’attendre la fin de la session.');
    return true;
  }

  activeQuiz = { channelId: message.channel.id };

  const themeMessage = await message.channel.send({ embeds: [createQuizThemeEmbed()] });
  for (const emoji of quizThemeEmojis) {
    await themeMessage.react(emoji);
  }

  const themeCollector = themeMessage.createReactionCollector({
    time: quizVoteDurationMs
  });

  await new Promise((resolve) => themeCollector.on('end', resolve));

  const themeVotes = quizThemes.map(() => 0);
  for (let index = 0; index < quizThemeEmojis.length; index += 1) {
    const reaction = themeMessage.reactions.cache.get(quizThemeEmojis[index]);
    if (!reaction) {
      continue;
    }
    const users = await reaction.users.fetch();
    themeVotes[index] = users.filter((user) => !user.bot).size;
  }

  const maxVotes = Math.max(...themeVotes);
  const topThemes = themeVotes
    .map((votes, index) => ({ votes, index }))
    .filter(({ votes }) => votes === maxVotes);
  const selectedThemeIndex =
    topThemes[Math.floor(Math.random() * topThemes.length)].index;
  const selectedTheme = quizThemes[selectedThemeIndex];

  await message.channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle('Quiz - Thème sélectionné')
        .setDescription(`${quizThemeEmojis[selectedThemeIndex]} **${selectedTheme.name}**`)
        .setColor(0x5dade2)
        .setTimestamp()
    ]
  });

  const scores = new Map();
  const questions = shuffle(selectedTheme.questions).slice(0, quizQuestionCount);

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const questionMessage = await message.channel.send({
      embeds: [createQuizQuestionEmbed(selectedTheme.name, index, question)]
    });

    const answersToReact = quizAnswerEmojis.slice(0, question.options.length);
    for (const emoji of answersToReact) {
      await questionMessage.react(emoji);
    }

    const questionCollector = questionMessage.createReactionCollector({
      time: quizQuestionDurationMs
    });

    await new Promise((resolve) => questionCollector.on('end', resolve));

    const correctEmoji = quizAnswerEmojis[question.correctIndex];
    const correctReaction = questionMessage.reactions.cache.get(correctEmoji);
    if (correctReaction) {
      const users = await correctReaction.users.fetch();
      for (const user of users.values()) {
        if (user.bot) {
          continue;
        }
        scores.set(user.id, (scores.get(user.id) ?? 0) + 1);
      }
    }
  }

  await message.channel.send({ embeds: [createQuizLeaderboardEmbed(scores)] });
  activeQuiz = null;
  return true;
}

// Handle AI Assistant - Auto-responds in dedicated thread with merged OpenAI + Grok responses
async function handleAIAssistant(message) {
  try {
    // Create a typing indicator while we think
    await message.channel.sendTyping();

    // Check if user is creator (allowed to execute actions)
    const isCreator = message.author.id === config.creatorId;

    const userQuestion = message.content;

    // === Memory Management Commands ===
    
    // Command: Memorize something
    const memorizeMatch = userQuestion.match(/^(mémorise|retiens|souviens-toi|apprends|note)(?:\s+que)?\s+(.+)$/i);
    if (memorizeMatch && isCreator) {
      const content = memorizeMatch[2].trim();
      
      // Try to detect if it's about a user (mentions or "X est...")
      const mentionMatch = content.match(/<@!?(\d+)>/);
      const userIdToStore = mentionMatch ? mentionMatch[1] : null;
      
      // Extract subject from patterns like "Itachi est..." or "@user est..."
      let subject = null;
      let type = 'general';
      
      if (userIdToStore) {
        const user = await message.guild.members.fetch(userIdToStore).catch(() => null);
        subject = user ? user.user.username : null;
        type = 'user_info';
      } else {
        const subjectMatch = content.match(/^(\w+)\s+(est|fait|a|aime|déteste|préfère)/i);
        if (subjectMatch) {
          subject = subjectMatch[1];
          type = 'user_info';
        }
      }
      
      await addMemory(type, content, message.author.id, subject, userIdToStore);
      await message.channel.send(`✅ Mémorisé ! Je m'en souviendrai.`);
      return;
    }

    // Command: Recall memories
    const recallMatch = userQuestion.match(/^(qu'est-ce que tu sais sur|rappelle-moi|dis-moi ce que tu sais sur)\s+(.+)$/i);
    if (recallMatch) {
      const searchTerm = recallMatch[2].trim();
      const memories = await searchMemories(searchTerm);
      
      if (memories.length === 0) {
        await message.channel.send(`je sais rien sur "${searchTerm}" pour le moment`);
        return;
      }
      
      const memList = memories.slice(0, 5).map(m => `• ${m.content}`).join('\n');
      await message.channel.send(`voilà ce que je sais sur "${searchTerm}":\n${memList}`);
      return;
    }

    // Command: Forget something
    if (userQuestion.match(/^(oublie|efface|supprime)\s+(ça|tout|la dernière chose)$/i) && isCreator) {
      const recentMemories = await getAllMemories(1);
      if (recentMemories.length > 0) {
        await deleteMemory(recentMemories[0].id);
        await message.channel.send(`✅ Oublié !`);
      } else {
        await message.channel.send(`j'ai déjà rien en mémoire`);
      }
      return;
    }

    // === Regular AI Response ===

    // Fetch last 10 messages for context
    const messages = await message.channel.messages.fetch({ limit: 11 });
    const contextMessages = Array.from(messages.values())
      .reverse()
      .slice(0, 10)
      .map(m => `${m.author.username}: ${m.content}`)
      .join('\n');

    // Load relevant memories for context
    let memoryContext = '';
    
    // 1. Get memories about the current user
    const userMemories = await getMemoriesForUser(message.author.id);
    if (userMemories.length > 0) {
      memoryContext += `\n\nInfos sur ${message.author.username}:\n` + 
        userMemories.slice(0, 3).map(m => `- ${m.content}`).join('\n');
    }
    
    // 2. Search memories related to question keywords
    const keywordMemories = await searchMemories(userQuestion);
    if (keywordMemories.length > 0) {
      memoryContext += `\n\nInfos pertinentes:\n` + 
        keywordMemories.slice(0, 3).map(m => `- ${m.content}`).join('\n');
    }

    // === Execute Actions First (if creator) ===
    if (isCreator) {
      // Quick direct patterns for common cases
      const deleteAllMatch = userQuestion.match(/supprime?\s+(tous?|tout|all)\s+(les?\s+)?messages?/i);
      const deleteNumMatch = userQuestion.match(/supprime?\s+(?:les?\s+)?(\d+)\s+(?:derniers?\s+)?messages?/i);
      
      if (deleteAllMatch) {
        await bulkDeleteMessages(message, 100);
        await message.channel.send('voilà j\'ai tout viré');
        return;
      }
      
      if (deleteNumMatch) {
        const count = parseInt(deleteNumMatch[1]);
        await bulkDeleteMessages(message, count);
        return;
      }
    }

    // === Regular AI Response (let AI decide if action needed) ===
    try {
      // Add code context if question is about bot features
      let codeContext = '';
      if (/comment|expliqu|fonctionn|marche|command|feature|c'est quoi|qu'est-ce|story|quiz|debate|counting|confession/i.test(userQuestion)) {
        const currentCode = fs.readFileSync('./src/index.js', 'utf-8');
        // Extract relevant sections based on question
        const relevantSections = [];
        if (/story|histoire/i.test(userQuestion)) {
          const storyMatch = currentCode.match(/\/\/ Handle \.story[\s\S]{0,500}/);
          if (storyMatch) relevantSections.push(storyMatch[0]);
        }
        if (/quiz/i.test(userQuestion)) {
          const quizMatch = currentCode.match(/async function handleQuizCommand[\s\S]{0,500}/);
          if (quizMatch) relevantSections.push(quizMatch[0]);
        }
        if (relevantSections.length > 0) {
          codeContext = `\n\nCode pertinent du bot:\n${relevantSections.join('\n...\n')}`;
        }
      }

      // Get Claude response (single, natural AI)
      const assistantResponse = await getClaudeAssistantResponse(userQuestion, contextMessages + memoryContext + codeContext, isCreator);

      if (!assistantResponse) {
        await message.channel.send('❌ Erreur lors de la génération de la réponse.');
        return;
      }

      // Check if AI wants to execute an action (for creator only)
      if (isCreator) {
        // Code generation/modification
        if (assistantResponse.includes('[[CODE_MODIFY]]')) {
          const cleanResponse = assistantResponse.replace(/\[\[CODE_MODIFY\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);
          await executeSelfModification(userQuestion, message);
          return;
        }

        // Discord actions
        const deleteAction = assistantResponse.match(/\[\[DELETE:(\d+)\]\]/);
        const banAction = assistantResponse.match(/\[\[BAN:(<@!?(\d+)>|\d+)\]\]/);
        const kickAction = assistantResponse.match(/\[\[KICK:(<@!?(\d+)>|\d+)\]\]/);
        const muteAction = assistantResponse.match(/\[\[MUTE:(<@!?(\d+)>|\d+):(\d+)\]\]/);
        const monitorAction = assistantResponse.match(/\[\[MONITOR:(<@!?(\d+)>|\d+)\]\]/);

        if (deleteAction) {
          const count = parseInt(deleteAction[1]);
          const cleanResponse = assistantResponse.replace(/\[\[DELETE:\d+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);
          await bulkDeleteMessages(message, count);
          return;
        }
        if (banAction) {
          const userIdMatch = banAction[1].match(/\d+/);
          const userId = userIdMatch ? userIdMatch[0] : banAction[1];
          const cleanResponse = assistantResponse.replace(/\[\[BAN:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);
          const member = await message.guild.members.fetch(userId).catch(() => null);
          if (member) {
            await member.ban({ reason: 'Banned by assistant' });
          } else {
            await message.channel.send('❌ utilisateur introuvable');
          }
          return;
        }
        if (kickAction) {
          const userIdMatch = kickAction[1].match(/\d+/);
          const userId = userIdMatch ? userIdMatch[0] : kickAction[1];
          const cleanResponse = assistantResponse.replace(/\[\[KICK:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);
          const member = await message.guild.members.fetch(userId).catch(() => null);
          if (member) {
            await member.kick('Kicked by assistant');
          } else {
            await message.channel.send('❌ utilisateur introuvable');
          }
          return;
        }
        if (muteAction) {
          const userIdMatch = muteAction[1].match(/\d+/);
          const userId = userIdMatch ? userIdMatch[0] : muteAction[1];
          const duration = parseInt(muteAction[3]);
          const cleanResponse = assistantResponse.replace(/\[\[MUTE:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);
          const member = await message.guild.members.fetch(userId).catch(() => null);
          if (member) {
            await member.timeout(duration * 60 * 1000, 'Muted by assistant');
          } else {
            await message.channel.send('❌ utilisateur introuvable');
          }
          return;
        }
        if (monitorAction) {
          const userIdMatch = monitorAction[1].match(/\d+/);
          const userId = userIdMatch ? userIdMatch[0] : monitorAction[1];
          const cleanResponse = assistantResponse.replace(/\[\[MONITOR:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);
          if (!global.monitoredUsers) global.monitoredUsers = new Map();
          global.monitoredUsers.set(userId, { channelId: message.channelId, since: new Date() });
          return;
        }
      }

      // Split into chunks if needed (Discord 2000 char limit)
      const chunks = assistantResponse.match(/[\s\S]{1,1900}/g) || [assistantResponse];

      for (const chunk of chunks) {
        await message.channel.send(chunk);
      }
    } catch (error) {
      console.error('❌ Erreur assistant IA:', error);
      await message.channel.send('❌ Erreur lors de la génération de la réponse. Réessayez!');
    }
  } catch (error) {
    console.error('❌ Erreur assistant:', error);
  }
}

// Get Claude response for assistant (natural, human tone)
async function getClaudeAssistantResponse(question, context, isCreator = false) {
  try {
    const systemPrompt = `Réponds naturellement en 1-2 phrases. Pas de markdown, pas de smileys forcés.

${isCreator ? `Si action demandée, utilise UN SEUL code à la fin:
- [[DELETE:X]] pour supprimer X messages
- [[BAN:userId]] pour ban
- [[KICK:userId]] pour kick  
- [[MUTE:userId:duration]] pour mute
- [[MONITOR:userId]] pour surveiller
- [[CODE_MODIFY]] UNIQUEMENT si modification majeure du bot (nouvelle feature complexe)

Ne mets JAMAIS [[CODE_GEN]]. Pour commande simple comme /hello, réponds juste "D'accord, je lance l'implémentation." puis mets [[CODE_MODIFY]].

Utilise le code fourni si question sur bot.` : ''}`;

    const response = await claude.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `${context}\n\nUtilisateur: ${question}`
        }
      ]
    });

    return response.content[0].text;
  } catch (error) {
    console.error('❌ Erreur Claude assistant:', error);
    return null;
  }
}

// Get OpenAI response for assistant (kept for other features)
async function getOpenaiAssistantResponse(question, context, isCreator = false) {
  try {
    const creatorMention = `<@${config.creatorId}>`;
    const executionNote = isCreator ? 
      '\nTu peux exécuter des actions Discord.js si demandé (delete messages, monitor users, etc). Si la demande est une action, fais-la sans demander confirmation!' :
      `\nSi l'utilisateur demande une action (delete, monitor, ban, etc), refuse poliment et dis que seul ${creatorMention} peut ordonner ce genre de chose.`;

    const systemPrompt = `T'es juste quelqu'un qui répond sur Discord. Parle normalement.

- Réponds court et simple
- Pas de smileys forcés ou questions inutiles
- Sois direct

${isCreator ? `Si on te demande d'agir:
- Actions Discord: [[DELETE:X]] [[BAN:userId]] [[KICK:userId]] [[MUTE:userId:duration]] [[MONITOR:userId]]
- Modifier bot: [[CODE_MODIFY]]
- Code exemple: [[CODE_GEN]]

Si question sur features bot, regarde le code dans le contexte.` : ''}

${context}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question }
      ],
      max_tokens: 1500,
      temperature: 0.85
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('❌ Erreur OpenAI assistant:', error);
    return null;
  }
}

// Get Grok response for assistant
async function getGrokAssistantResponse(question, context, isCreator = false) {
  try {
    const creatorMention = `<@${config.creatorId}>`;
    const executionNote = isCreator ?
      '\nT\'es autorisé à exécuter des actions Discord.js si demandé (delete messages, monitor users, ban, etc). Si c\'est une action, fais-la franchement!' :
      `\nSi on te demande une action (delete, monitor, ban, etc), refuse poliment et dis que seulement ${creatorMention} peut ordonner ce genre de truc.`;

    const systemPrompt = `Réponds normal.

- Court et direct
- Pas de smileys ou questions en trop

${isCreator ? `Actions: [[DELETE:X]] [[BAN:userId]] [[KICK:userId]] [[MUTE:userId:duration]] [[MONITOR:userId]]
Code: [[CODE_MODIFY]] [[CODE_GEN]]` : ''}

${context}`;

    const response = await grok.chat.completions.create({
      model: 'grok-4-fast-reasoning',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question }
      ],
      max_tokens: 1500,
      temperature: 0.9
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('❌ Erreur Grok assistant:', error);
    return null;
  }
}

// Merge OpenAI + Grok responses intelligently into one unified response
async function mergeAssistantResponses(openaiResp, grokResp, question) {
  // If one fails, return the other
  if (!openaiResp) return grokResp || 'Erreur: pas de réponse disponible';
  if (!grokResp) return openaiResp;

  try {
    // Use OpenAI to intelligently fuse both responses into one perfect answer
    const fusionPrompt = `Fusionne ces réponses simplement.

Question: "${question}"
Réponse 1 (OpenAI): "${openaiResp}"
Réponse 2 (Grok): "${grokResp}"

IMPORTANT: Grok est plus naturel et humain. Privilégie son style et son ton.
- Base-toi surtout sur Grok pour le ton et le style
- Utilise OpenAI juste pour compléter les infos si nécessaire
- Court (1-2 phrases)
- Pas de smileys forcés
- Pas de questions inutiles
- Jamais mentionner qu'il y a plusieurs réponses

Réponds comme Grok le ferait, naturel et direct.`;

    const fusionResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: fusionPrompt },
        { role: 'user', content: 'Fusionne ces réponses en une seule.' }
      ],
      max_tokens: 2000,
      temperature: 0.8
    });

    return fusionResponse.choices[0].message.content.trim();
  } catch (error) {
    console.error('❌ Erreur fusion responses:', error);
    // Fallback: return both if fusion fails
    return `${openaiResp}\n\n${grokResp}`;
  }
}

// Try to generate and execute code
async function tryExecuteAssistantCodeGeneration(question, message) {
  try {
    // Check for code generation keywords
    const isCodeGenRequest = /génère|genere|code|modifi|improve|fix|crée|cree|ajoute|rajoute|javascript|python|script|fonction|function|commande|command/i.test(question);
    const isSelfModifyRequest = /modifie.*ton code|modifie.*index|change.*le bot|ajoute.*feature|rajoute|crée.*commande|ajoute.*commande|nouvelle.*commande/i.test(question);

    if (!isCodeGenRequest) return false; // Not a code request

    if (isSelfModifyRequest) {
      // Self-modification request
      await executeSelfModification(question, message);
      return true;
    } else {
      // Regular code generation
      await executeCodeGeneration(question, message);
      return true;
    }
  } catch (error) {
    console.error('❌ Erreur génération code assistant:', error);
    return false;
  }
}

// Generate and execute code snippets
async function executeCodeGeneration(question, message) {
  try {
    await message.channel.send('⏳ j\'analyse ce qu\'il faut changer...');

    // Read current bot code for context
    const currentCode = fs.readFileSync('./src/index.js', 'utf-8');
    
    const systemPrompt = `Tu es un dev qui modifie le bot Discord existant.

CONTEXTE: Le bot existe déjà dans index.js avec toutes les imports et client setup.

Ta tâche: Suggérer UNIQUEMENT le code minimal à ajouter/modifier pour "${question}".

Format:
\`\`\`javascript
// Code à ajouter (juste les quelques lignes nécessaires)
\`\`\`

PAS DE:
- Imports (déjà fait)
- client.login() (déjà fait)  
- Création du client (déjà fait)
- Code de base existant

JUSTE ce qu'il faut ajouter/modifier!`;

    const codeResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Code actuel (extrait):\n${currentCode.substring(0, 2000)}\n\nDemande: ${question}` }
      ],
      max_tokens: 2000,
      temperature: 0.7
    });

    const generatedCode = codeResponse.choices[0].message.content.trim();
    
    // Extract code from markdown blocks
    let code = generatedCode;
    const codeMatch = generatedCode.match(/```(?:javascript|js|python)?\n?([\s\S]*?)```/);
    if (codeMatch) {
      code = codeMatch[1].trim();
    }

    // Display the suggested code
    await message.channel.send(`Code suggéré:\n\`\`\`javascript\n${code}\n\`\`\`\n\nDis-moi "oui" ou "applique" si ça te plaît! (ou "non" si tu veux que je change)`);

  } catch (error) {
    console.error('❌ Erreur code generation:', error);
    await message.channel.send('❌ Erreur lors de la génération du code');
  }
}

// Modify bot's own code
async function executeSelfModification(question, message) {
  try {
    await message.channel.send('⏳ j\'analyse ce qu\'il faut changer...');

    // Get current code context
    const currentCode = fs.readFileSync('./src/index.js', 'utf-8');

    const systemPrompt = `Tu modifies le bot Discord M-Yra existant. Demande: "${question}"

CONTEXTE EXISTANT:
- Bot discord.js v14 avec client, intents, toutes imports déjà faits
- Slash commands déjà setup avec guild.commands.set()
- Handler interactionCreate déjà présent
- SQLite, OpenAI, Grok, Claude déjà configurés

TON RÔLE: Suggère UNIQUEMENT les lignes minimales à ajouter/modifier.

Exemples:
- /hello → Juste la commande dans le tableau + le case dans le handler (10-15 lignes)
- Feature complexe → Plus de code si vraiment nécessaire

Format:
\`\`\`javascript
// LIGNES À AJOUTER/MODIFIER:
[code minimal sans réimporter ou recréer ce qui existe]
\`\`\`

INTERDICTIONS:
- Ne recrée JAMAIS les imports (déjà faits)
- Ne recrée JAMAIS le client (existe déjà)
- Ne recrée JAMAIS REST/Routes (pas besoin, guild.commands.set() suffit)
- Ne montre PAS de code déjà existant`;

    const modResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Code actuel (extrait):\n${currentCode.substring(3000, 5000)}\n\nDemande: ${question}` }
      ],
      max_tokens: 2500,
      temperature: 0.7
    });

    const suggestedCode = modResponse.choices[0].message.content.trim();
    
    // Display the suggestion
    await message.channel.send('📝 Code suggéré:\n' + suggestedCode);
    
    // Store pending modification
    const modId = `${message.author.id}_${Date.now()}`;
    pendingCodeMods.set(modId, {
      userId: message.author.id,
      channelId: message.channelId,
      suggestion: suggestedCode,
      question: question,
      timestamp: Date.now()
    });

    // Ask for confirmation
    await message.channel.send(`ℹ️ j'ai suggéré ça pour "${question}". Dis-moi "oui" ou "applique" si ça te plaît! (ou "non" si tu veux que je change)`);

  } catch (error) {
    console.error('❌ Erreur self modification:', error);
    await message.channel.send('❌ Erreur lors de l\'analyse de modification');
  }
}

// Apply approved code modification to index.js
async function applyCodeModification(message, modInfo) {
  try {
    await message.channel.send('⏳ application de la modification...');

    const filePath = './src/index.js';
    let currentCode = fs.readFileSync(filePath, 'utf-8');

    // Extract code from suggestion
    let codeToAdd = modInfo.suggestion;
    const codeMatch = modInfo.suggestion.match(/```(?:javascript|js)?\n?([\s\S]*?)```/);
    if (codeMatch) {
      codeToAdd = codeMatch[1].trim();
    }

    // Detect if this is a major change
    const isMajorChange = detectMajorChange(modInfo.question, codeToAdd);

    // Try to safely append the code before the last client event listeners
    // Find a good insertion point (before last function)
    const lastFunctionMatch = currentCode.lastIndexOf('function ');
    const insertPosition = lastFunctionMatch > 0 ? lastFunctionMatch : currentCode.length - 100;

    const updatedCode = currentCode.slice(0, insertPosition) + '\n\n' + codeToAdd + '\n\n' + currentCode.slice(insertPosition);

    // Write the modified code
    fs.writeFileSync(filePath, updatedCode, 'utf-8');

    // Try to create git branch and commit
    try {
      const branchName = `ia-modification-${Date.now()}`;
      const repoPath = './';

      // Check if git repo exists
      if (fs.existsSync(path.join(repoPath, '.git'))) {
        // Resolve target branch (configured) and base from it
        const currentBranch = execSync(`cd "${repoPath}" && git rev-parse --abbrev-ref HEAD`, { encoding: 'utf-8' }).trim();
        const targetBranch = config.gitTargetBranch || currentBranch;

        // Switch to target branch, then create feature branch from it
        execSync(`cd "${repoPath}" && git checkout ${targetBranch}`, { stdio: 'ignore' });
        execSync(`cd "${repoPath}" && git checkout -b ${branchName}`, { stdio: 'ignore' });
        
        // Add and commit changes
        execSync(`cd "${repoPath}" && git add src/index.js`, { stdio: 'ignore' });
        execSync(`cd "${repoPath}" && git commit -m "IA modification: ${modInfo.question}"`, { stdio: 'ignore' });

        if (isMajorChange) {
          // Major change - keep branch for review, push branch only
          try {
            const pushCmd = getGitPushCommand(branchName);
            if (pushCmd) {
              execSync(`cd "${repoPath}" && ${pushCmd}`, { stdio: 'ignore' });
            }
            await message.channel.send(`⚠️ Changement majeur. Branche créée: \`${branchName}\` (base: \`${targetBranch}\`). À relire et merger manuellement.`);
          } catch (pushError) {
            console.warn('⚠️ Git push failed:', pushError.message);
            await message.channel.send(`⚠️ Branche \`${branchName}\` créée localement (push échoué).`);
          }
        } else {
          // Minor change - auto-merge into target branch and push
          execSync(`cd "${repoPath}" && git checkout ${targetBranch} && git merge ${branchName}`, { stdio: 'ignore' });
          
          // Push to remote
          try {
            const pushCmd = getGitPushCommand(targetBranch);
            if (pushCmd) {
              execSync(`cd "${repoPath}" && ${pushCmd}`, { stdio: 'ignore' });
            }
          } catch (pushError) {
            console.warn('⚠️ Git push failed:', pushError.message);
          }
          
          await message.channel.send(`✅ Code appliqué et fusionné automatiquement sur \`${targetBranch}\`! (Branche: \`${branchName}\`)`);
        }
        
        console.log(`✅ Code modification applied: ${modInfo.question} (Major: ${isMajorChange})`);
      } else {
        await message.channel.send('✅ Code appliqué! (Git repo non détecté)');
      }
    } catch (gitError) {
      console.warn('⚠️ Git operation failed:', gitError.message);
      await message.channel.send('✅ Code appliqué! (Git commit échoué, mais fichier modifié)');
    }

  } catch (error) {
    console.error('❌ Erreur application modification:', error);
    await message.channel.send(`❌ Erreur lors de l'application: ${error.message}`);
  }
}

// Detect if a code change is major
function detectMajorChange(question, code) {
  const majorKeywords = [
    'refactor', 'restructure', 'complètement', 'entièrement', 'rewrite',
    'système', 'architecture', 'major feature', 'core', 'fondamental',
    'remplaces', 'remplace complètement', 'supprime', 'remove', 'overhaul'
  ];

  const isMajorByKeyword = majorKeywords.some(keyword => 
    question.toLowerCase().includes(keyword)
  );

  // Count lines of code
  const lineCount = code.split('\n').length;
  const isMajorBySize = lineCount > 50; // More than 50 lines is major

  return isMajorByKeyword || isMajorBySize;
}

// Try to execute assistant actions
async function tryExecuteAssistantAction(question, message) {
  try {
    // Check for action keywords
    const actionKeywords = {
      delete: /supprim|delete|remove|vire/i,
      monitor: /surveille|monitor|track|watch/i,
      ban: /ban|kick|expuls/i,
      clear: /clear|clean|wipe|vide/i,
      mute: /mute|silence|lock/i
    };

    let actionType = null;
    for (const [key, regex] of Object.entries(actionKeywords)) {
      if (regex.test(question)) {
        actionType = key;
        break;
      }
    }

    if (!actionType) return false; // No action detected

    // If creator, execute the action
    if (message.author.id === config.creatorId) {
      switch (actionType) {
        case 'delete':
          await executeDeleteAction(message);
          break;
        case 'monitor':
          await executeMonitorAction(message, question);
          break;
        case 'ban':
          await executeBanAction(message, question);
          break;
        case 'clear':
          await executeClearAction(message, question);
          break;
        case 'mute':
          await executeMuteAction(message, question);
          break;
      }
      return true; // Action executed
    }

    // For non-creators, don't respond (let AI handle it normally)
    return false;
  } catch (error) {
    console.error('❌ Erreur exécution action assistant:', error);
    return false;
  }
}

// Generate IA refusal response for unauthorized action requests
async function generateAndSendRefusalResponse(message, actionName, creatorMention) {
  try {
    const systemPrompt = `T'es un assistant IA humain et poli. Quelqu'un vient de te demander une action (${actionName}) que seul ${creatorMention} peut faire.

Tu dois:
- Refuser poliment et naturellement 
- Expliquer que tu dois être contrôlé par ${creatorMention} et personne d'autre pour les actions
- Proposer à l'utilisateur de demander à ${creatorMention} ou tu peux l'appeler pour lui
- Sois conversationnel, pas formel
- Utilise "haha", des points d'exclamation, sois friendly

Mentionne bien ${creatorMention} pour que cette personne reçoive une notif.

Sois court, max 2-3 phrases!`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `quelqu'un te demande de ${actionName}` }
      ],
      max_tokens: 300,
      temperature: 0.85
    });

    const refusalMsg = response.choices[0].message.content.trim();
    await message.channel.send(refusalMsg);
  } catch (error) {
    console.error('❌ Erreur génération refusal:', error);
    // Fallback à message hard-codé
    await message.channel.send(`tu peux demander à ${creatorMention} de faire ça, moi j'peux pas le faire directement. c'est ${creatorMention} qui me contrôle!`);
  }
}

// Bulk delete messages
async function bulkDeleteMessages(message, count) {
  try {
    if (count < 1 || count > 100) {
      await message.channel.send('⚠️ Je peux supprimer entre 1 et 100 messages');
      return;
    }

    // Fetch count + 1 but cap at 100 to avoid Discord API error
    const fetchLimit = Math.min(count + 1, 100);
    const messages = await message.channel.messages.fetch({ limit: fetchLimit });
    const toDelete = Array.from(messages.values()).slice(1, count + 1); // Skip command message
    
    for (const msg of toDelete) {
      await msg.delete().catch(() => {});
    }
    
    // Pas de message de confirmation ici - c'est géré par l'IA dans sa réponse
  } catch (error) {
    console.error('❌ Erreur bulk delete:', error);
    await message.channel.send('❌ Erreur lors de la suppression');
  }
}

// Delete action - deletes last message or replying to message
async function executeDeleteAction(message) {
  try {
    // Only creator can execute
    if (message.author.id !== config.creatorId) return;

    // If replying to a message, delete that message
    if (message.reference) {
      const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
      await repliedTo.delete();
      await message.channel.send('✅ Message supprimé');
      return;
    }

    // Otherwise delete last message in channel
    const messages = await message.channel.messages.fetch({ limit: 2 });
    const toDelete = Array.from(messages.values())[1]; // Skip the current message
    if (toDelete) {
      await toDelete.delete();
      await message.channel.send('✅ Message supprimé');
    }
  } catch (error) {
    console.error('❌ Erreur delete:', error);
    await message.channel.send('❌ Impossible de supprimer ce message');
  }
}

// Monitor action - track a user's messages
async function executeMonitorAction(message, question) {
  try {
    // Only creator can execute
    if (message.author.id !== config.creatorId) return;

    // Try to extract mention or username
    const match = question.match(/<@!?(\d+)>/) || question.match(/@(\w+)/);
    if (!match) {
      await message.channel.send('⚠️ j\'ai pas trouvé d\'utilisateur à surveiller. Mentionne quelqu\'un!');
      return;
    }

    const userId = match[1];
    if (!userId) {
      await message.channel.send('⚠️ utilisateur non trouvé');
      return;
    }

    // Create a monitor entry in memory (simple implementation)
    if (!global.monitoredUsers) global.monitoredUsers = new Map();
    global.monitoredUsers.set(userId, { channelId: message.channelId, since: new Date() });

    await message.channel.send(`✅ ok j\'ai commencé à surveiller <@${userId}>`);
    console.log(`🔍 Monitoring user ${userId} in channel ${message.channelId}`);
  } catch (error) {
    console.error('❌ Erreur monitor:', error);
    await message.channel.send('❌ Erreur lors de la surveillance');
  }
}

// Ban action - ban a user
async function executeBanAction(message, question) {
  try {
    // Only creator can execute
    if (message.author.id !== config.creatorId) return;

    const match = question.match(/<@!?(\d+)>/) || question.match(/@(\w+)/);
    if (!match) {
      await message.channel.send('⚠️ j\'ai pas trouvé d\'utilisateur. Mentionne quelqu\'un!');
      return;
    }

    const userId = match[1];
    const member = await message.guild.members.fetch(userId);
    if (!member) {
      await message.channel.send('❌ utilisateur non trouvé');
      return;
    }

    await member.ban({ reason: 'Banned by assistant' });
    await message.channel.send(`✅ <@${userId}> a été banni`);
    console.log(`🚫 User ${userId} banned`);
  } catch (error) {
    console.error('❌ Erreur ban:', error);
    await message.channel.send('❌ Erreur lors du bannissement');
  }
}

// Clear action - bulk delete messages
async function executeClearAction(message, question) {
  try {
    // Only creator can execute
    if (message.author.id !== config.creatorId) return;

    const match = question.match(/(\d+)/);
    let count = match ? parseInt(match[1]) : 10;
    count = Math.min(count, 100); // Max 100

    const messages = await message.channel.messages.fetch({ limit: count + 1 });
    const toDelete = Array.from(messages.values()).slice(1); // Skip current

    await message.channel.bulkDelete(toDelete);
    await message.channel.send(`✅ ${toDelete.length} messages supprimés`);
    console.log(`🗑️ Cleared ${toDelete.length} messages`);
  } catch (error) {
    console.error('❌ Erreur clear:', error);
    await message.channel.send('❌ Erreur lors du nettoyage');
  }
}

// Mute action - lock channel or manage permissions
async function executeMuteAction(message, question) {
  try {
    // Only creator can execute
    if (message.author.id !== config.creatorId) return;

    const isMuteEveryone = /mute|lock|silence|ferme/i.test(question);
    
    if (isMuteEveryone) {
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, {
        SendMessages: false
      });
      await message.channel.send('✅ canal verrouillé');
    }
  } catch (error) {
    console.error('❌ Erreur mute:', error);
    await message.channel.send('❌ Erreur lors du verrouillage');
  }
}



client.on('messageCreate', async (message) => {
  if (message.author.bot) {
    return;
  }

  if (!message.guild) {
    await handleAdminConfessionLookup(message);
    return;
  }

  // Handle AI Assistant in dedicated channel or its threads
  const isAssistantContext = config.assistantChannelId && (
    message.channelId === config.assistantChannelId ||
    (message.channel.isThread && message.channel.parentId === config.assistantChannelId)
  );

  if (isAssistantContext) {
    // Check if this is a confirmation for pending code modification
    const isConfirming = /^(oui|ok|yes|applique|parfait|c'est bon|good|apply)$/i.test(message.content);
    const isRejecting = /^(non|nope|change|modifie|améliore)$/i.test(message.content);

    if (isConfirming && message.author.id === config.creatorId && pendingCodeMods.size > 0) {
      // Get most recent pending modification
      const lastMod = Array.from(pendingCodeMods.values()).pop();
      if (lastMod && lastMod.userId === message.author.id) {
        await applyCodeModification(message, lastMod);
        pendingCodeMods.delete(Array.from(pendingCodeMods.keys()).pop());
        return;
      }
    }

    if (isRejecting && message.author.id === config.creatorId && pendingCodeMods.size > 0) {
      const lastMod = Array.from(pendingCodeMods.values()).pop();
      const lastModKey = Array.from(pendingCodeMods.keys()).pop();
      
      // Extract feedback from message (everything after "non")
      const feedback = message.content.replace(/^(non|nope|change|modifie|améliore)[,\s]*/i, '').trim();
      
      if (feedback && lastMod) {
        // Regenerate with feedback
        await message.channel.send('⏳ je corrige ça...');
        pendingCodeMods.delete(lastModKey);
        const newQuestion = `${lastMod.question} (CORRECTION: ${feedback})`;
        await executeSelfModification(newQuestion, message);
      } else {
        // Just cancel
        pendingCodeMods.clear();
        await message.channel.send('ok j\'ai annulé. dis-moi ce que tu veux que je change!');
      }
      return;
    }

    // Regular AI assistant response
    await handleAIAssistant(message);
    return;
  }

  const handledSupport = await handleSupportCommand(message);
  if (handledSupport) {
    return;
  }

  const handledWordStats = await handleWordStats(message);
  if (handledWordStats) {
    return;
  }

  const handledActionVerite = await handleActionVeriteCommand(message);
  if (handledActionVerite) {
    return;
  }

  const handledQuiz = await handleQuizCommand(message);
  if (handledQuiz) {
    return;
  }

  const handledConfession = await handleConfession(message);
  if (handledConfession) {
    return;
  }

  const handledCounting = await handleCounting(message);
  if (handledCounting) {
    return;
  }

  const handledWordGame = await handleWordGame(message);
  if (handledWordGame) {
    return;
  }

  const handledStoryContribution = await handleStoryContribution(message);
  if (handledStoryContribution) {
    return;
  }

  try {
    await handleThreadCreation(message);
  } catch (error) {
    const canNotify = message.channel
      .permissionsFor(message.guild.members.me)
      ?.has(PermissionsBitField.Flags.SendMessages);
    if (canNotify) {
      await message.channel.send('Impossible de créer le thread pour ce message.');
    }
  }
});

client.once('ready', async () => {
  console.log(`Bot connecté en tant que ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: '☕ !support', type: 0 }]
  });

  // Register slash commands
  try {
    const guild = client.guilds.cache.first();
    if (guild) {
      const commands = [
        new SlashCommandBuilder()
          .setName('ping')
          .setDescription('Vérifier que le bot fonctionne'),
        new SlashCommandBuilder()
          .setName('story')
          .setDescription('Gestionnaire d\'histoires collaboratives')
          .addSubcommand(sub =>
            sub.setName('start')
              .setDescription('Lancer une nouvelle histoire')
              .addStringOption(opt => opt.setName('theme').setDescription('Thème de l\'histoire').setRequired(true))
              .addStringOption(opt =>
                opt.setName('mode')
                  .setDescription('Mode: classic ou roleplay')
                  .setChoices({ name: 'Classique', value: 'classic' }, { name: 'Roleplay', value: 'roleplay' })
                  .setRequired(false)
              )
          )
          .addSubcommand(sub =>
            sub.setName('join')
              .setDescription('[Roleplay] S\'enregistrer avec un rôle')
              .addStringOption(opt => opt.setName('role').setDescription('Nom de votre rôle/personnage').setRequired(true))
          )
          .addSubcommand(sub =>
            sub.setName('ready')
              .setDescription('[Roleplay] Lancer la partie après les inscriptions')
          )
          .addSubcommand(sub =>
            sub.setName('end')
              .setDescription('Terminer l\'histoire actuelle')
          )
      ];

      // Ajouter la commande /clear
      commands.push(
        new SlashCommandBuilder()
          .setName('clear')
          .setDescription('Supprimer des messages dans le salon')
          .addIntegerOption(opt =>
            opt.setName('nombre')
              .setDescription('Nombre de messages à supprimer (1-100)')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(100)
          )
      );

      // Ajouter la commande /roast
      commands.push(
        new SlashCommandBuilder()
          .setName('roast')
          .setDescription('Insulter quelqu\'un de façon hilarante')
          .addUserOption(opt =>
            opt.setName('cible')
              .setDescription('La personne à insulter')
              .setRequired(true)
          )
      );

      // Ajouter la commande /versusai
      commands.push(
        new SlashCommandBuilder()
          .setName('versusai')
          .setDescription('OpenAI vs Grok débattent un sujet')
          .addStringOption(opt =>
            opt.setName('sujet')
              .setDescription('Le sujet à débattre')
              .setRequired(true)
          )
      );

      // Ajouter la commande /debate-respond
      commands.push(
        new SlashCommandBuilder()
          .setName('debate-respond')
          .setDescription('Propose un argument et déclenche un débat des 2 IAs')
          .addStringOption(opt =>
            opt.setName('argument')
              .setDescription('Ton argument à débattre')
              .setRequired(true)
          )
      );

      // Ajouter la commande /debate-respond-grok
      commands.push(
        new SlashCommandBuilder()
          .setName('debate-respond-grok')
          .setDescription('Attaque Grok avec un argument')
          .addStringOption(opt =>
            opt.setName('argument')
              .setDescription('Ton argument contre Grok')
              .setRequired(true)
          )
      );

      // Ajouter la commande /debate-respond-openai
      commands.push(
        new SlashCommandBuilder()
          .setName('debate-respond-openai')
          .setDescription('Attaque OpenAI avec un argument')
          .addStringOption(opt =>
            opt.setName('argument')
              .setDescription('Ton argument contre OpenAI')
              .setRequired(true)
          )
      );

      await guild.commands.set(commands);
      console.log('✅ Slash commands enregistrées');
    }
  } catch (err) {
    console.error('❌ Erreur enregistrement slash commands:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  // Handle slash commands
  if (interaction.isChatInputCommand()) {
    try {
      const { commandName, options } = interaction;

      if (commandName === 'ping') {
        await interaction.reply(`🏓 Pong! Latence: ${client.ws.ping}ms`);
        return;
      }

      if (commandName === 'clear') {
        await handleClearCommand(interaction);
        return;
      }

      if (commandName === 'roast') {
        await handleRoastCommand(interaction);
        return;
      }

      if (commandName === 'versusai') {
        await handleVersusAiCommand(interaction);
        return;
      }

      if (commandName === 'debate-respond') {
        await handleDebateRespondCommand(interaction);
        return;
      }

      if (commandName === 'debate-respond-grok') {
        await handleDebateRespondGrokCommand(interaction);
        return;
      }

      if (commandName === 'debate-respond-openai') {
        await handleDebateRespondOpenaiCommand(interaction);
        return;
      }

      if (commandName === 'story') {
        const subcommand = options.getSubcommand();

        if (subcommand === 'start') {
          await handleStorySlashStart(interaction);
        } else if (subcommand === 'join') {
          await handleStorySlashJoin(interaction);
        } else if (subcommand === 'ready') {
          await handleStorySlashReady(interaction);
        } else if (subcommand === 'end') {
          await handleStorySlashEnd(interaction);
        }
      }
    } catch (err) {
      console.error('❌ Erreur slash command:', err);
      try {
        await interaction.reply({ content: '❌ Une erreur est survenue.', ephemeral: true });
      } catch {}
    }
    return;
  }

  if (!interaction.isButton()) {
    return;
  }

  // Handle merge/no-merge buttons
  if (interaction.customId.startsWith('merge_')) {
    const parts = interaction.customId.replace('merge_', '').split('_');
    const branchName = parts.slice(0, -1).join('_');
    const targetBranch = parts[parts.length - 1];
    
    try {
      await interaction.deferUpdate();
      const repoPath = './';
      
      execSync(`cd "${repoPath}" && git checkout ${targetBranch} && git merge ${branchName}`, { stdio: 'ignore' });
      
      // Push to remote
      try {
        const pushCmd = getGitPushCommand(targetBranch);
        if (pushCmd) {
          execSync(`cd "${repoPath}" && ${pushCmd}`, { stdio: 'ignore' });
        }
      } catch (pushError) {
        console.warn('⚠️ Git push failed:', pushError.message);
      }
      
      await interaction.channel.send(`✅ Branche \`${branchName}\` fusionnée sur \`${targetBranch}\`!`);
      console.log(`✅ Branch ${branchName} merged to ${targetBranch}`);
    } catch (error) {
      await interaction.channel.send(`❌ Erreur merge: ${error.message}`);
      console.error('❌ Merge failed:', error);
    }
    return;
  }

  if (interaction.customId.startsWith('nomerge_')) {
    const branchName = interaction.customId.replace('nomerge_', '');
    try {
      await interaction.deferUpdate();
      await interaction.channel.send(`❌ Fusion de \`${branchName}\` annulée. Branche conservée pour vérification.`);
      console.log(`❌ Branch ${branchName} merge cancelled`);
    } catch (error) {
      console.error('❌ Error handling no-merge:', error);
    }
    return;
  }

  const [namespace, action] = interaction.customId.split(':');
  if (namespace !== 'action-verite') {
    return;
  }

  const game = actionVeriteGames.get(interaction.message.id);
  if (!game) {
    await interaction.reply({
      content: 'Cette partie est terminée ou inactive.',
      ephemeral: true
    });
    return;
  }

  const lock = actionVeriteLocks.get(interaction.message.id) ?? Promise.resolve();
  const nextLock = lock.then(async () => {
    if (action === 'termine') {
      if (!game.activeUserId) {
        await interaction.reply({
          content: 'Aucune partie en cours pour le moment.',
          ephemeral: true
        });
        return;
      }

      if (interaction.user.id !== game.activeUserId) {
        await interaction.reply({
          content: `Seul <@${game.activeUserId}> peut terminer la partie en cours.`,
          ephemeral: true
        });
        return;
      }

      game.activeUserId = null;
      game.threadId = null;
      await interaction.update({
        components: [createActionVeriteRow(false)]
      });
      await interaction.channel.send('La partie est terminée. Les boutons sont de nouveau disponibles.');
      return;
    }

    if (game.activeUserId) {
      await interaction.reply({
        content: `Une partie est déjà en cours avec <@${game.activeUserId}>.`,
        ephemeral: true
      });
      return;
    }

    game.activeUserId = interaction.user.id;
    const choiceLabel = action === 'action' ? 'Action' : 'Vérité';
    let threadMessage = 'Le fil de discussion est prêt.';

    try {
      const thread = await interaction.message.startThread({
        name: `Action ou Vérité — ${interaction.user.username}`,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay
      });
      game.threadId = thread.id;
      await thread.send(`${interaction.user} a choisi **${choiceLabel}**. À vous de jouer !`);
      threadMessage = `Thread créé : ${thread.name}`;
    } catch (error) {
      // Ignore thread creation errors and fallback to channel only.
      threadMessage = 'Impossible de créer le thread, la partie se déroule ici.';
    }

    await interaction.update({
      components: [createActionVeriteRow(true)]
    });
    await interaction.channel.send(`${interaction.user} a choisi **${choiceLabel}** ! ${threadMessage}`);
  });

  actionVeriteLocks.set(interaction.message.id, nextLock.catch(() => {}));
  await nextLock;
});

await initializeDatabase();
client.login(config.token);
