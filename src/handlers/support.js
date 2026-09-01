import { config } from '../config.js';

const supportLink = 'https://buymeacoffee.com/henergyque';
const supportMessage = `Si tu veux soutenir le bot, voici un petit café ☕ : ${supportLink}`;

export async function handleSupportCommand(message) {
  const trimmed = message.content.trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const command = (parts[0] || '').toLowerCase();

  if (command !== '!support') {
    return false;
  }

  if (parts.length === 1) {
    await message.channel.send(supportMessage);
    return true;
  }

  // Posting to another channel is creator-only
  if (message.author.id !== config.creatorId && message.author.id !== message.guild?.ownerId) {
    await message.channel.send('❌ Seul le créateur peut envoyer le message support dans un autre salon.');
    return true;
  }

  const channelArg = parts[1];
  const channelIdMatch = channelArg.match(/^(?:<#)?(\d{17,20})>?$/);
  const targetChannelId = channelIdMatch ? channelIdMatch[1] : null;

  if (!targetChannelId) {
    await message.channel.send('❌ Format invalide. Utilise `!support #salon`');
    return true;
  }

  const targetChannel = await message.guild.channels.fetch(targetChannelId).catch(() => null);
  if (!targetChannel?.isTextBased?.()) {
    await message.channel.send('❌ Salon cible introuvable ou non textuel.');
    return true;
  }

  await targetChannel.send(supportMessage);

  if (targetChannel.id !== message.channelId) {
    await message.channel.send(`✅ Message support envoyé dans <#${targetChannel.id}>`);
  }

  return true;
}
