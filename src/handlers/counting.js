import { ChannelType, EmbedBuilder, ThreadAutoArchiveDuration } from 'discord.js';
import { config } from '../config.js';
import { getQuery, runQuery } from '../db.js';
import { getChannelForFeature } from '../utils/channel-helper.js';
import { sendMaintenanceNotice } from '../utils/maintenance.js';

const countingLocks = new Map();
const countingCache = new Map();
const countingRecentValid = new Map();
const DUPLICATE_GRACE_MS = 5_000;

function getParisDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

async function incrementFormatWarning(guildId, userId) {
  const dateKey = getParisDateKey();
  const counterKey = `counting_warning:${guildId}:${userId}:${dateKey}`;

  const row = await getQuery('SELECT value FROM counters WHERE key = ?', [counterKey]);
  const current = Number.parseInt(row?.value ?? '0', 10);
  const nextValue = current + 1;

  await runQuery(
    'INSERT INTO counters (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [counterKey, String(nextValue)]
  );

  return nextValue;
}

function parseCountingNumber(messageContent) {
  const trimmed = messageContent.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  return Number.parseInt(trimmed, 10);
}

export async function getCountingState(channelId) {
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

export async function setCountingState(channelId, lastNumber, lastUserId) {
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

async function createCountingErrorThread(message) {
  if (message.channel.type !== ChannelType.GuildText) {
    return null;
  }

  try {
    const thread = await message.startThread({
      name: 'Discussion counting',
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay
    });
    return thread;
  } catch (error) {
    // Ignore thread creation errors to avoid blocking counting flow.
    return null;
  }
}

export async function handleCounting(message) {
  const lock = countingLocks.get(message.channel.id) ?? Promise.resolve();
  const nextLock = lock.then(async () => {
    const countingChannelId = await getChannelForFeature('counting', 'countingChannelId', config);

    if (!countingChannelId || message.channel.id !== countingChannelId) {
      return false;
    }

    const maintenanceBlocked = await sendMaintenanceNotice(message);
    if (maintenanceBlocked) {
      return true;
    }

    const { lastNumber, lastUserId } = await getCountingState(message.channel.id);
    const nextNumber = lastNumber + 1;
    const parsed = parseCountingNumber(message.content);
    const isSameUser = lastUserId === message.author.id;

    if (parsed === null) {
      const warningCount = await incrementFormatWarning(message.guild.id, message.author.id);
      const warningCycle = ((warningCount - 1) % 3) + 1;

      const warningText = [
        `${message.author} ⚠️ **Avertissement ${warningCycle}/3**`,
        'M-Yra IA: le salon counting accepte uniquement des chiffres.',
        'Pour discuter, utilise le thread du counting ou les salons dédiés.'
      ];

      await message.channel.send(warningText.join('\n'));
      return true;
    }

    const recentValid = countingRecentValid.get(message.channel.id);
    const isNearDuplicate = (
      typeof parsed === 'number'
      && parsed === lastNumber
      && recentValid
      && recentValid.number === lastNumber
      && (Date.now() - recentValid.timestamp) <= DUPLICATE_GRACE_MS
    );

    if (isNearDuplicate) {
      await message.delete().catch(() => {});
      return true;
    }

    if (parsed !== nextNumber || isSameUser) {
      await setCountingState(message.channel.id, 0, null);
      await message.react('❌');
      const errorThread = await createCountingErrorThread(message);

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

      if (errorThread) {
        await errorThread.send({
          content: `🧷 Thread ouvert pour <@${message.author.id}> : discutez du gage ici.`
        });
      }

      return true;
    }

    await setCountingState(message.channel.id, parsed, message.author.id);
    countingRecentValid.set(message.channel.id, {
      number: parsed,
      timestamp: Date.now()
    });
    await message.react('✅');
    return true;
  });

  countingLocks.set(message.channel.id, nextLock.catch(() => {}));
  return nextLock;
}
