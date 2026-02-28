import { EmbedBuilder, MessageFlags } from 'discord.js';
import { getAllChannelConfigs, getStoredChannelConfig, removeChannelConfig, setChannelConfig } from '../utils/channel-config.js';
import { getUserPreferences, resetUserPreferences, setUserPreference } from '../services/user-preferences.js';

export async function handleModelCommand(interaction) {
  try {
    const choice = 'opus';
    const userId = interaction.user.id;
    await setUserPreference(userId, 'model', choice);

    const modelNames = {
      opus: 'Claude Opus 4.6 (perfection)'
    };

    const embed = {
      title: '🤖 Modèle IA Sélectionné',
      description: `Votre prochaine question utilisera : **${modelNames[choice]}**`,
      color: 0x5865f2,
      footer: { text: 'Préférence sauvegardée pour vos prochaines questions (modifiable via /preferences)' }
    };

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  } catch (error) {
    console.error('Erreur /model:', error);
    await interaction.reply({ content: `Erreur: ${error.message}`, flags: MessageFlags.Ephemeral });
  }
}

export async function handlePreferencesCommand(interaction, options) {
  const subcommand = options.getSubcommand();
  const userId = interaction.user.id;

  if (subcommand === 'view') {
    const prefs = await getUserPreferences(userId);

    if (!prefs) {
      await interaction.reply({
        content: '📋 Vous n\'avez pas encore de préférences configurées.\nUtilisez `/preferences model`, `/preferences style` ou `/preferences language` pour commencer.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('⚙️ Vos Préférences')
      .setColor(0x5865f2)
      .addFields(
        { name: '🤖 Modèle IA', value: 'Claude Opus 4.6 (assistant only)', inline: true },
        { name: '💬 Style', value: prefs.response_style || 'Normal', inline: true },
        { name: '🌐 Langue', value: prefs.language || 'Français', inline: true }
      )
      .setFooter({ text: 'Utilisez /preferences pour modifier' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (subcommand === 'model') {
    const choice = 'opus';
    await setUserPreference(userId, 'model', choice);
    await interaction.reply({
      content: `✅ Modèle IA défini sur **${choice}**`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (subcommand === 'style') {
    const choice = options.getString('choice');
    await setUserPreference(userId, 'style', choice);
    await interaction.reply({
      content: `✅ Style de réponse défini sur **${choice}**`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (subcommand === 'language') {
    const choice = options.getString('choice');
    await setUserPreference(userId, 'language', choice);
    await interaction.reply({
      content: `✅ Langue définie sur **${choice}**`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (subcommand === 'reset') {
    await resetUserPreferences(userId);
    await interaction.reply({
      content: '🔄 Vos préférences ont été réinitialisées.',
      flags: MessageFlags.Ephemeral
    });
  }
}

export async function handleConfigCommand(interaction, options, client, creatorId) {
  if (interaction.user.id !== creatorId) {
    await interaction.reply({ content: '❌ Seul le créateur peut configurer les channels.', flags: MessageFlags.Ephemeral });
    return;
  }

  const subcommand = options.getSubcommand();

  if (subcommand === 'list') {
    const configuredFeatures = await getAllChannelConfigs(true);

    if (configuredFeatures.length === 0) {
      await interaction.reply({ content: '📭 Aucune configuration trouvée.', flags: MessageFlags.Ephemeral });
      return;
    }

    let list = '⚙️ **Configurations actuelles:**\n';
    for (const featureConfig of configuredFeatures) {
      const channel = await client.channels.fetch(featureConfig.channel_id).catch(() => null);
      const channelName = channel ? `<#${featureConfig.channel_id}>` : '*deleted*';
      const status = featureConfig.enabled ? '✅' : '❌';
      const updatedAt = featureConfig.updated_at ? new Date(featureConfig.updated_at).toLocaleDateString('fr-FR') : 'n/a';
      list += `${status} **${featureConfig.feature}**: ${channelName} (${updatedAt})\n`;
    }

    await interaction.reply({ content: list, flags: MessageFlags.Ephemeral });
    return;
  }

  if (subcommand === 'set') {
    const feature = options.getString('feature');
    const channel = options.getChannel('channel');

    if (!channel) {
      await interaction.reply({ content: '❌ Channel introuvable.', flags: MessageFlags.Ephemeral });
      return;
    }

    const updated = await setChannelConfig(feature, channel.id);
    if (!updated) {
      await interaction.reply({ content: '❌ Erreur lors de la sauvegarde de la configuration.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply({
      content: `✅ **${feature}** configuré → <#${channel.id}>`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (subcommand === 'remove') {
    const feature = options.getString('feature');

    const existing = await getStoredChannelConfig(feature);
    if (!existing) {
      await interaction.reply({ content: `❌ **${feature}** n'est pas configurée.`, flags: MessageFlags.Ephemeral });
      return;
    }

    const removed = await removeChannelConfig(feature);
    if (!removed) {
      await interaction.reply({ content: '❌ Erreur lors de la suppression de la configuration.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply({
      content: `🗑️ **${feature}** a été supprimée.`,
      flags: MessageFlags.Ephemeral
    });
  }
}
