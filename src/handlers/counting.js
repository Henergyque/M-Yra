import { ChannelType, EmbedBuilder, ThreadAutoArchiveDuration } from 'discord.js';
import { config } from '../config.js';
import { getQuery, runQuery } from '../db.js';
import { getChannelForFeature } from '../utils/channel-helper.js';
import { sendMaintenanceNotice } from '../utils/maintenance.js';

const countingLocks = new Map();
const countingCache = new Map();

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
