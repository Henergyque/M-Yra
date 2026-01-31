import { SlashCommandBuilder } from 'discord.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('COMMAND-REGISTRY');

/**
 * Centralized command registry
 * Manages slash commands, message handlers, and prefix commands
 */
export const commandRegistry = {
  /**
   * Slash commands (Discord interactions)
   */
  slash: [
    {
      name: 'ask',
      description: 'Ask Claude any question',
      category: 'ai',
      options: [
        {
          name: 'question',
          description: 'Your question',
          type: 3,
          required: true
        }
      ],
      build: () => new SlashCommandBuilder()
        .setName('ask')
        .setDescription('Ask Claude any question')
        .addStringOption(opt => opt
          .setName('question')
          .setDescription('Your question')
          .setRequired(true)
        ),
      handler: 'ask.js',
      models: ['opus']
    },

    {
      name: 'roast',
      description: 'Roast a user (harsh humor)',
      category: 'games',
      options: [
        {
          name: 'user',
          description: 'User to roast',
          type: 9,
          required: true
        }
      ],
      build: () => new SlashCommandBuilder()
        .setName('roast')
        .setDescription('Roast a user')
        .addUserOption(opt => opt
          .setName('user')
          .setDescription('User to roast')
          .setRequired(true)
        ),
      handler: 'roast.js',
      models: ['grok']
    },

    {
      name: 'debate',
      description: 'Start a structured debate',
      category: 'games',
      options: [
        {
          name: 'topic',
          description: 'Debate topic',
          type: 3,
          required: true
        }
      ],
      build: () => new SlashCommandBuilder()
        .setName('debate')
        .setDescription('Start a structured debate')
        .addStringOption(opt => opt
          .setName('topic')
          .setDescription('Debate topic')
          .setRequired(true)
        ),
      handler: 'debate.js',
      models: ['opus', 'openai']
    },

    {
      name: 'quiz',
      description: 'Start a trivia quiz',
      category: 'games',
      build: () => new SlashCommandBuilder()
        .setName('quiz')
        .setDescription('Start a trivia quiz'),
      handler: 'quiz.js',
      models: ['gemini']
    },

    {
      name: 'story',
      description: 'Start or continue a collaborative story',
      category: 'games',
      options: [
        {
          name: 'action',
          description: 'What happens next? (optional)',
          type: 3,
          required: false
        }
      ],
      build: () => new SlashCommandBuilder()
        .setName('story')
        .setDescription('Start or continue a collaborative story')
        .addStringOption(opt => opt
          .setName('action')
          .setDescription('What happens next?')
          .setRequired(false)
        ),
      handler: 'story.js',
      models: ['sonnet']
    },

    {
      name: 'actionverite',
      description: 'Truth or Dare game',
      category: 'games',
      build: () => new SlashCommandBuilder()
        .setName('actionverite')
        .setDescription('Truth or Dare game'),
      handler: 'actionverite.js',
      models: ['grok']
    },

    {
      name: 'confession',
      description: 'Post anonymous confession',
      category: 'fun',
      options: [
        {
          name: 'message',
          description: 'Your confession',
          type: 3,
          required: true
        }
      ],
      build: () => new SlashCommandBuilder()
        .setName('confession')
        .setDescription('Post anonymous confession')
        .addStringOption(opt => opt
          .setName('message')
          .setDescription('Your confession')
          .setRequired(true)
          .setMaxLength(2000)
        ),
      handler: 'confession.js',
      models: []
    }
  ],

  /**
   * Message handlers (triggered by regex patterns)
   */
  messages: [
    {
      name: 'counting',
      trigger: /^counting\s+(\d+)/i,
      description: 'Counting game continuation',
      category: 'games',
      handler: 'counting.js',
      models: ['mistral']
    },

    {
      name: 'wordstats',
      trigger: /^!wordstats/i,
      description: 'Show word game statistics',
      category: 'games',
      handler: 'wordstats.js',
      models: ['mistral']
    },

    {
      name: 'actionverite-response',
      trigger: /^!actionverite\s+(action|vérité)/i,
      description: 'Continue action-verite game',
      category: 'games',
      handler: 'actionverite-response.js',
      models: ['grok']
    }
  ],

  /**
   * Prefix commands (old-style ! commands)
   */
  prefix: [
    {
      name: '!confession',
      prefix: '!',
      command: 'confession',
      description: 'Post anonymous confession',
      usage: '!confession <message>',
      handler: 'confession.js',
      category: 'fun'
    },

    {
      name: '!memory',
      prefix: '!',
      command: 'memory',
      description: 'Manage memories',
      handler: 'memory.js',
      category: 'utility'
    },

    {
      name: '!stats',
      prefix: '!',
      command: 'stats',
      description: 'Show bot statistics',
      handler: 'stats.js',
      category: 'utility'
    }
  ],

  /**
   * Get command by name and type
   */
  getCommand(name, type = 'slash') {
    const registry = this[type];
    if (!registry) return null;
    return registry.find(cmd => cmd.name === name);
  },

  /**
   * Get all commands by category
   */
  getByCategory(category, type = 'slash') {
    const registry = this[type];
    if (!registry) return [];
    return registry.filter(cmd => cmd.category === category);
  },

  /**
   * Get all slash command builders
   */
  getSlashCommandBuilders() {
    return this.slash.map(cmd => cmd.build?.() || null).filter(Boolean);
  },

  /**
   * Register custom command
   */
  registerCommand(command, type = 'slash') {
    if (!this[type]) {
      logger.error(`Invalid command type: ${type}`);
      return false;
    }

    // Check for duplicates
    if (this[type].some(cmd => cmd.name === command.name)) {
      logger.warn(`Command already registered: ${command.name}`);
      return false;
    }

    this[type].push(command);
    logger.info(`Registered ${type} command: ${command.name}`);
    return true;
  },

  /**
   * Get statistics
   */
  getStats() {
    return {
      slashCommands: this.slash.length,
      messageHandlers: this.messages.length,
      prefixCommands: this.prefix.length,
      categories: {
        games: this.slash.filter(c => c.category === 'games').length,
        ai: this.slash.filter(c => c.category === 'ai').length,
        fun: this.slash.filter(c => c.category === 'fun').length,
        utility: this.slash.filter(c => c.category === 'utility').length
      }
    };
  }
};

logger.info('Command registry initialized', commandRegistry.getStats());
