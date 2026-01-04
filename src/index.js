import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sqlite3 from 'sqlite3';
import {
  ChannelType,
  Client,
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
      value INTEGER NOT NULL
    )
  `);
  await runQuery(
    'INSERT OR IGNORE INTO counters (key, value) VALUES (?, ?)',
    ['counting_last', 0]
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

async function getCountingLast() {
  const row = await getQuery('SELECT value FROM counters WHERE key = ?', ['counting_last']);
  return row?.value ?? 0;
}

async function setCountingLast(value) {
  await runQuery('UPDATE counters SET value = ? WHERE key = ?', [value, 'counting_last']);
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
  const confessionText = `Confession #${confessionId}\n${message.content.trim()}`;
  await message.channel.send({ content: confessionText });
  await message.delete();
  return true;
}

async function handleCounting(message) {
  if (message.channel.id !== config.countingChannelId) {
    return false;
  }

  const lastNumber = await getCountingLast();
  const nextNumber = lastNumber + 1;
  const parsed = parseCountingNumber(message.content);

  if (parsed !== nextNumber) {
    await setCountingLast(0);
    await message.channel.send({
      content: `Erreur ! Le bon nombre était ${nextNumber}. Le compteur repart à 1.`
    });
    return true;
  }

  await setCountingLast(parsed);
  return true;
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

client.on('messageCreate', async (message) => {
  if (message.author.bot) {
    return;
  }

  if (!message.guild) {
    await handleAdminConfessionLookup(message);
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
