import { MessageFlags } from 'discord.js';
import { enqueueTrack, getMusicState, getQueueSnapshot, joinMusicChannel, skipTrack, stopMusic } from '../voice/musicPlayer.js';

export async function handlePlayCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: '❌ Commande disponible uniquement sur un serveur.', flags: MessageFlags.Ephemeral });
    return;
  }

  const query = interaction.options.getString('recherche');
  await interaction.deferReply();

  try {
    const memberVoiceChannelId = interaction.member?.voice?.channelId;
    const state = getMusicState(interaction.guild.id);
    const targetVoiceChannelId = state?.voiceChannelId || memberVoiceChannelId;

    if (!targetVoiceChannelId) {
      await interaction.editReply('❌ Rejoins un salon vocal ou configure-en un avec `/config set feature:Musique`.');
      return;
    }

    await joinMusicChannel(interaction.guild, targetVoiceChannelId, interaction.channelId);
    const result = await enqueueTrack(interaction.guild, query);

    if (!result.ok) {
      await interaction.editReply(`❌ ${result.reason}`);
      return;
    }

    if (result.position === 0) {
      await interaction.editReply(`🎵 Lecture lancée: **${result.track.title}**`);
    } else {
      await interaction.editReply(`➕ Ajoutée à la file (position ${result.position}): **${result.track.title}**`);
    }
  } catch (error) {
    console.error('❌ Erreur /play:', error);
    await interaction.editReply(`❌ Erreur: ${error.message}`);
  }
}

export async function handleSkipCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: '❌ Commande disponible uniquement sur un serveur.', flags: MessageFlags.Ephemeral });
    return;
  }

  const skipped = skipTrack(interaction.guild.id);
  await interaction.reply({
    content: skipped ? '⏭️ Musique passée.' : '❌ Rien n\'est en cours de lecture.',
    flags: MessageFlags.Ephemeral
  });
}

export async function handleStopCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: '❌ Commande disponible uniquement sur un serveur.', flags: MessageFlags.Ephemeral });
    return;
  }

  const stopped = stopMusic(interaction.guild.id);
  await interaction.reply({
    content: stopped ? '⏹️ Musique arrêtée, le bot a quitté le vocal.' : '❌ Aucune session musicale active.',
    flags: MessageFlags.Ephemeral
  });
}

export async function handleQueueCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: '❌ Commande disponible uniquement sur un serveur.', flags: MessageFlags.Ephemeral });
    return;
  }

  const { current, queue } = getQueueSnapshot(interaction.guild.id);

  if (!current && queue.length === 0) {
    await interaction.reply({ content: '📭 Aucune musique en cours ni en attente.', flags: MessageFlags.Ephemeral });
    return;
  }

  const lines = [];
  if (current) {
    lines.push(`▶️ **En cours:** ${current.title}${current.isAutoplay ? ' _(autoplay)_' : ''}`);
  }
  if (queue.length > 0) {
    lines.push('', '**File d\'attente:**');
    queue.forEach((track, index) => {
      lines.push(`${index + 1}. ${track.title}`);
    });
  }

  await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
}
