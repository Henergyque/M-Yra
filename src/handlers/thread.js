import { ChannelType, EmbedBuilder, ThreadAutoArchiveDuration } from 'discord.js';
import { config } from '../config.js';
import { getChannelsForFeature } from '../utils/channel-helper.js';

function formatThreadName(message) {
  const base = message.content?.trim() || message.author.username;
  const safe = base.replace(/\s+/g, ' ').slice(0, 80);
  return `Discussion - ${safe}`;
}

export async function handleThreadCreation(message) {
  const threadChannelIds = await getChannelsForFeature('thread_create', 'threadChannelIds', config);
  
  if (!threadChannelIds.includes(message.channel.id)) {
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
