import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sqlite3 from 'sqlite3';
import OpenAI from 'openai';
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
      const errorEmbed = new EmbedBuilder()
        .setTitle('Counting - erreur')
        .setDescription(
          [
            `Le bon nombre était **${nextNumber}**.`,
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
      model: 'gpt-5-2',
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
    const isValid = content.toUpperCase().startsWith('YES');
    const explanation = content.replace(/^(YES|NO)[:\s]*/i, '').trim();

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
      model: 'gpt-5-2',
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

    // Initialize game with first word
    if (!currentWord) {
      await setWordGameState(message.channel.id, userWord, message.author.id, 0);
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
      await message.react('❌');
      await createWordGameErrorThread(message);

      const errorEmbed = new EmbedBuilder()
        .setTitle('❌ Mot Rejeté')
        .setDescription(
          `**${userWord}** n'est pas suffisamment lié à **${currentWord}**.\n\n` +
          `**Raison :** ${explanation}\n\n` +
          `Le streak de **${channelStreak}** mot${channelStreak > 1 ? 's' : ''} est perdu ! 😢\n` +
          `Relance en cours...`
        )
        .setColor(0xff6b6b)
        .setTimestamp();
      
      await message.channel.send({ content: `${message.author}`, embeds: [errorEmbed] });

      // Generate new starting word
      const newWord = await generateNewWord();
      await setWordGameState(message.channel.id, newWord, null, 0);

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
    await updateWordGameScore(message.author.id, message.channel.id, totalPoints, newStreak);
    await message.react('✅');

    // Show progress every 5 words or when bonus is earned
    if (newStreak % 5 === 0 || streakBonus > 0) {
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

client.on('messageCreate', async (message) => {
  if (message.author.bot) {
    return;
  }

  if (!message.guild) {
    await handleAdminConfessionLookup(message);
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

client.once('ready', () => {
  console.log(`Bot connecté en tant que ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: '☕ !support', type: 0 }]
  });
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) {
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
