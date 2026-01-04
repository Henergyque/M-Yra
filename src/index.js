import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sqlite3 from 'sqlite3';
import {
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
const dbPath = path.join(dataDir, 'bot.sqlite');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
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
  await runQuery(
    'INSERT OR IGNORE INTO counters (key, value) VALUES (?, ?)',
    ['counting_last', '0']
  );
  await runQuery(
    'INSERT OR IGNORE INTO counters (key, value) VALUES (?, ?)',
    ['counting_last_user', '']
  );
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

const quizThemes = [
  {
    name: 'Jeux vidéo',
    questions: [
      {
        question: 'Quel est le studio derrière la série The Legend of Zelda ?',
        options: ['Nintendo', 'Capcom', 'Square Enix'],
        correctIndex: 0
      },
      {
        question: 'Quel personnage est la mascotte de Sega ?',
        options: ['Sonic', 'Mario', 'Kirby'],
        correctIndex: 0
      },
      {
        question: 'Dans Minecraft, quel matériau permet de créer une table d’enchantement ?',
        options: ['Diamant', 'Obsidienne', 'Fer', 'Or'],
        correctIndex: 1
      },
      {
        question: 'Quel jeu a popularisé le genre Battle Royale en 2017 ?',
        options: ['PUBG', 'Fortnite', 'Apex Legends'],
        correctIndex: 0
      },
      {
        question: 'Quel est le nom du plombier principal de Nintendo ?',
        options: ['Luigi', 'Mario', 'Wario'],
        correctIndex: 1
      },
      {
        question: 'Dans Overwatch, quel rôle soigne principalement ses alliés ?',
        options: ['Tank', 'Dégâts', 'Soutien'],
        correctIndex: 2
      },
      {
        question: 'Quelle console a introduit la manette DualSense ?',
        options: ['PlayStation 4', 'PlayStation 5', 'PlayStation 3'],
        correctIndex: 1
      },
      {
        question: 'Dans League of Legends, quel est l’objectif principal ?',
        options: ['Détruire le nexus', 'Capturer des drapeaux', 'Survivre 100 minutes'],
        correctIndex: 0
      },
      {
        question: 'Quel est le nom du héros principal de Halo ?',
        options: ['Master Chief', 'Solid Snake', 'Doomguy'],
        correctIndex: 0
      },
      {
        question: 'Quel jeu est connu pour le mode « Creative » et « Survie » ?',
        options: ['Minecraft', 'Terraria', 'No Man’s Sky'],
        correctIndex: 0
      }
    ]
  },
  {
    name: 'Musique',
    questions: [
      {
        question: 'Quel instrument compte 88 touches ?',
        options: ['Piano', 'Guitare', 'Saxophone'],
        correctIndex: 0
      },
      {
        question: 'Quel groupe est connu pour la chanson "Bohemian Rhapsody" ?',
        options: ['Queen', 'The Beatles', 'Nirvana'],
        correctIndex: 0
      },
      {
        question: 'Quel style musical est associé au DJ ?',
        options: ['Électro', 'Opéra', 'Jazz'],
        correctIndex: 0
      },
      {
        question: 'Quel artiste a sorti l’album "Thriller" ?',
        options: ['Michael Jackson', 'Prince', 'Elton John'],
        correctIndex: 0
      },
      {
        question: 'Quel instrument est à cordes et se joue avec un archet ?',
        options: ['Violon', 'Piano', 'Batterie'],
        correctIndex: 0
      },
      {
        question: 'Quel genre musical est né à la Nouvelle-Orléans ?',
        options: ['Jazz', 'Rap', 'Techno'],
        correctIndex: 0
      },
      {
        question: 'Combien de cordes a une guitare classique standard ?',
        options: ['4', '6', '8'],
        correctIndex: 1
      },
      {
        question: 'Quel groupe est connu pour "Smells Like Teen Spirit" ?',
        options: ['Nirvana', 'Metallica', 'U2'],
        correctIndex: 0
      },
      {
        question: 'Lequel de ces instruments est une percussion ?',
        options: ['Flûte', 'Tambour', 'Violoncelle'],
        correctIndex: 1
      },
      {
        question: 'Quel terme désigne la vitesse d’un morceau ?',
        options: ['Tempo', 'Timbre', 'Tonalité'],
        correctIndex: 0
      }
    ]
  },
  {
    name: 'Art',
    questions: [
      {
        question: 'Qui a peint "La Joconde" ?',
        options: ['Léonard de Vinci', 'Picasso', 'Van Gogh'],
        correctIndex: 0
      },
      {
        question: 'Quel mouvement artistique est associé à Monet ?',
        options: ['Impressionnisme', 'Cubisme', 'Surréalisme'],
        correctIndex: 0
      },
      {
        question: 'Quelle sculpture est un symbole de Paris ?',
        options: ['Le Penseur', 'Vénus de Milo', 'La Statue de la Liberté'],
        correctIndex: 0
      },
      {
        question: 'Quel artiste est connu pour "La Nuit étoilée" ?',
        options: ['Van Gogh', 'Dalí', 'Matisse'],
        correctIndex: 0
      },
      {
        question: 'Lequel est un matériau de sculpture ?',
        options: ['Marbre', 'Verre', 'Papier'],
        correctIndex: 0
      },
      {
        question: 'Quel musée abrite la Joconde ?',
        options: ['Louvre', 'Orsay', 'Tate Modern'],
        correctIndex: 0
      },
      {
        question: 'Qui a peint "Guernica" ?',
        options: ['Picasso', 'Rembrandt', 'Monet'],
        correctIndex: 0
      },
      {
        question: 'Quel art est associé au papier plié ?',
        options: ['Origami', 'Graffiti', 'Mosaïque'],
        correctIndex: 0
      },
      {
        question: 'Quelle technique utilise de petits carreaux colorés ?',
        options: ['Mosaïque', 'Fresque', 'Aquarelle'],
        correctIndex: 0
      },
      {
        question: 'Quel artiste est associé au surréalisme ?',
        options: ['Dalí', 'Renoir', 'Turner'],
        correctIndex: 0
      }
    ]
  },
  {
    name: 'Culture générale',
    questions: [
      {
        question: 'Quelle est la capitale de la France ?',
        options: ['Paris', 'Lyon', 'Marseille'],
        correctIndex: 0
      },
      {
        question: 'Combien y a-t-il de continents sur Terre ?',
        options: ['5', '6', '7'],
        correctIndex: 2
      },
      {
        question: 'Quel est le plus grand océan ?',
        options: ['Pacifique', 'Atlantique', 'Indien'],
        correctIndex: 0
      },
      {
        question: 'Quel est le symbole chimique de l’eau ?',
        options: ['H2O', 'O2', 'CO2'],
        correctIndex: 0
      },
      {
        question: 'Quelle planète est la plus proche du Soleil ?',
        options: ['Mercure', 'Mars', 'Vénus'],
        correctIndex: 0
      },
      {
        question: 'Combien de couleurs dans l’arc-en-ciel ?',
        options: ['6', '7', '8'],
        correctIndex: 1
      },
      {
        question: 'Quel animal est surnommé le roi de la jungle ?',
        options: ['Lion', 'Tigre', 'Éléphant'],
        correctIndex: 0
      },
      {
        question: 'Quelle est la langue officielle du Brésil ?',
        options: ['Portugais', 'Espagnol', 'Français'],
        correctIndex: 0
      },
      {
        question: 'Quel est l’élément chimique du symbole Fe ?',
        options: ['Fer', 'Fluor', 'Plomb'],
        correctIndex: 0
      },
      {
        question: 'Quel est le plus grand désert du monde ?',
        options: ['Antarctique', 'Sahara', 'Gobi'],
        correctIndex: 0
      }
    ]
  }
];

const quizThemeEmojis = ['🎮', '🎵', '🎨', '🌍'];
const quizAnswerEmojis = ['🇦', '🇧', '🇨', '🇩'];
const quizQuestionCount = 10;
const quizVoteDurationMs = 20000;
const quizQuestionDurationMs = 15000;

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

  const lastNumberRow = await getQuery(
    'SELECT value FROM counters WHERE key = ?',
    ['counting_last']
  );
  const lastUserRow = await getQuery(
    'SELECT value FROM counters WHERE key = ?',
    ['counting_last_user']
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
  await runQuery('UPDATE counters SET value = ? WHERE key = ?', [String(lastNumber), 'counting_last']);
  await runQuery('UPDATE counters SET value = ? WHERE key = ?', [lastUserId ?? '', 'counting_last_user']);
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
});

await initializeDatabase();
client.login(config.token);
