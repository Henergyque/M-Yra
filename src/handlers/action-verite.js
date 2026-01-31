import { ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { grok } from '../ai/clients.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const actionVeriteCommand = '!actionverite';
const actionVeriteGames = new Map();
const actionVeriteLocks = new Map();

export function createActionVeriteEmbed() {
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

export function createActionVeriteRow(isLocked) {
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

export async function handleActionVeriteCommand(message) {
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

export function getActionVeriteGames() {
  return actionVeriteGames;
}

export function getActionVeriteLocks() {
  return actionVeriteLocks;
}
