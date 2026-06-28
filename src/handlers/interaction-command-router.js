export async function dispatchChatInputCommand(interaction, context) {
  const { client, config, handlers } = context;
  const { commandName, options } = interaction;

  if (commandName === 'ping') {
    await interaction.reply(`🏓 Pong! Latence: ${client.ws.ping}ms`);
    return true;
  }

  if (commandName === 'play') {
    await handlers.handlePlayCommand(interaction);
    return true;
  }

  if (commandName === 'skip') {
    await handlers.handleSkipCommand(interaction);
    return true;
  }

  if (commandName === 'stop') {
    await handlers.handleStopCommand(interaction);
    return true;
  }

  if (commandName === 'queue') {
    await handlers.handleQueueCommand(interaction);
    return true;
  }

  if (commandName === 'clear') {
    await handlers.handleClearCommand(interaction);
    return true;
  }

  if (commandName === 'roast') {
    await handlers.handleRoastCommand(interaction);
    return true;
  }

  if (commandName === 'versusai') {
    await handlers.handleVersusAiCommand(interaction);
    return true;
  }

  if (commandName === 'debate-respond') {
    await handlers.handleDebateRespondCommand(interaction);
    return true;
  }

  if (commandName === 'debate-respond-grok') {
    await handlers.handleDebateRespondGrokCommand(interaction);
    return true;
  }

  if (commandName === 'debate-respond-openai') {
    await handlers.handleDebateRespondOpenaiCommand(interaction);
    return true;
  }

  if (commandName === 'model') {
    await handlers.handleModelCommand(interaction);
    return true;
  }

  if (commandName === 'preferences') {
    await handlers.handlePreferencesCommand(interaction, options);
    return true;
  }

  if (commandName === 'config') {
    await handlers.handleConfigCommand(interaction, options, client, config.creatorId);
    return true;
  }

  if (commandName === 'maintenance') {
    await handlers.handleMaintenanceCommand(interaction);
    return true;
  }

  if (commandName === 'diagnostic') {
    await handlers.handleDiagnosticCommand(interaction);
    return true;
  }

  if (commandName === 'memory-reset') {
    await handlers.handleMemoryResetCommand(interaction);
    return true;
  }

  if (commandName === 'parler') {
    await handlers.handleParlerCommand(interaction);
    return true;
  }

  if (commandName === 'automod-simple') {
    await handlers.handleAutoModSimpleCommand(interaction);
    return true;
  }

  if (commandName === 'jeu-moderation') {
    await handlers.handleGameModerationCommand(interaction, options);
    return true;
  }

  if (commandName === 'story') {
    const subcommand = options.getSubcommand();

    if (subcommand === 'start') {
      await handlers.handleStorySlashStart(interaction);
    } else if (subcommand === 'join') {
      await handlers.handleStorySlashJoin(interaction);
    } else if (subcommand === 'ready') {
      await handlers.handleStorySlashReady(interaction);
    } else if (subcommand === 'end') {
      await handlers.handleStorySlashEnd(interaction);
    }

    return true;
  }

  return false;
}
