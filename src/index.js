import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration
} from 'discord.js';
import { config } from './config.js';
import { runQuery, getQuery, allQuery, initializeDatabase } from './db.js';
import {
  addMemory,
  getMemoriesForUser,
  searchMemories,
  getAllMemories,
  deleteMemory,
  loadConversationHistory,
  loadVannesContext,
  addFact,
  addSummary,
  addAttachment,
  addTask,
  updateTaskStatus,
  addRawObservation,
  setKnownMember,
  removeKnownMember,
  listKnownMembers
} from './brain/memory.js';
import { openai, grok, claude, geminiModel, mistral, perplexity } from './ai/clients.js';
import { aiRouter } from './ai/router.js';
import { aiResponseBuilder } from './ai/response-builder.js';
import { handleCounting, getCountingState, setCountingState } from './handlers/counting.js';
import { handleConfession, handleAdminConfessionLookup } from './handlers/confession.js';
import { handleSupportCommand } from './handlers/support.js';
import { handleWordGame, handleWordStats } from './handlers/word-game.js';
import { handleThreadCreation } from './handlers/thread.js';
import { getChannelForFeature } from './utils/channel-helper.js';
import { handleStoryContribution, finishStory, getActiveStories, setActiveStory, deleteActiveStory } from './handlers/story.js';
import { handleActionVeriteCommand, getActionVeriteGames, getActionVeriteLocks, createActionVeriteRow } from './handlers/action-verite.js';
import { handleQuizCommand, getActiveQuiz } from './handlers/quiz.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper: build git push command with optional GitHub token
function getGitPushCommand(targetBranch) {
  const repoUrl = config.githubRepo;
  const token = config.githubToken;
  if (!repoUrl) {
    return null;
  }

  if (token && repoUrl.startsWith('https://')) {
    const authedUrl = repoUrl.replace('https://', `https://x-access-token:${token}@`);
    return `git push ${authedUrl} ${targetBranch}`;
  }

  return `git push origin ${targetBranch}`;
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



// Debate state - track message count per channel for crescendo
const debateState = new Map();


// Profils membres et infos serveur
async function upsertMemberProfile(guild, message) {
  try {
    const member = message.member;
    if (!member) return;
    const roles = member.roles?.cache ? Array.from(member.roles.cache.values()).map(r => ({ id: r.id, name: r.name })) : [];
    await runQuery(
      `INSERT INTO member_profiles (discord_id, username, display_name, guild_id, guild_name, roles, is_bot, first_seen, last_seen, last_channel_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(discord_id) DO UPDATE SET username = ?, display_name = ?, guild_id = ?, guild_name = ?, roles = ?, is_bot = ?, last_seen = ?, last_channel_id = ?` ,
      [
        member.id,
        member.user?.username,
        member.displayName,
        guild?.id,
        guild?.name,
        JSON.stringify(roles),
        member.user?.bot ? 1 : 0,
        new Date().toISOString(),
        new Date().toISOString(),
        message.channelId,
        // update fields
        member.user?.username,
        member.displayName,
        guild?.id,
        guild?.name,
        JSON.stringify(roles),
        member.user?.bot ? 1 : 0,
        new Date().toISOString(),
        message.channelId
      ]
    );
  } catch (err) {
    console.warn('⚠️ upsertMemberProfile failed:', err.message);
  }
}

async function upsertServerInfo(guild) {
  if (!guild) return;
  try {
    await runQuery(
      `INSERT INTO server_info (guild_id, guild_name, owner_id, member_count, locale, created_at, snapshot_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET guild_name = ?, owner_id = ?, member_count = ?, locale = ?, snapshot_at = ?`,
      [
        guild.id,
        guild.name,
        guild.ownerId || null,
        guild.memberCount || null,
        guild.preferredLocale || null,
        guild.createdAt ? guild.createdAt.toISOString() : null,
        new Date().toISOString(),
        // update
        guild.name,
        guild.ownerId || null,
        guild.memberCount || null,
        guild.preferredLocale || null,
        new Date().toISOString()
      ]
    );
  } catch (err) {
    console.warn('⚠️ upsertServerInfo failed:', err.message);
  }
}



function isConfiguredChannel(channelId, list) {
  return Array.isArray(list) && list.includes(channelId);
}

function normalizeOptionalValue(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed === '-') return null;
  return trimmed;
}

function parseJsonSafe(value, fallback = undefined) {
  if (value === undefined || value === null) return fallback;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed === '-') return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    return fallback ?? trimmed;
  }
}

const MEMORY_TABLES = {
  memories: { orderBy: 'created_at DESC', maxLimit: 200 },
  facts: { orderBy: 'created_at DESC', maxLimit: 200 },
  summaries: { orderBy: 'created_at DESC', maxLimit: 200 },
  attachments: { orderBy: 'created_at DESC', maxLimit: 200 },
  tasks: { orderBy: 'updated_at DESC', maxLimit: 200 },
  raw_observations: { orderBy: 'created_at DESC', maxLimit: 200 },
  known_members: { orderBy: 'added_at DESC', maxLimit: 200 },
  member_profiles: { orderBy: 'last_seen DESC', maxLimit: 200 },
  server_info: { orderBy: 'snapshot_at DESC', maxLimit: 200 },
  brain_observations: { orderBy: 'created_at DESC', maxLimit: 200 },
  brain_events: { orderBy: 'created_at DESC', maxLimit: 200 },
  brain_member_patterns: { orderBy: 'last_observed DESC', maxLimit: 200 },
  brain_context_knowledge: { orderBy: 'updated_at DESC', maxLimit: 200 },
  brain_relationships: { orderBy: 'last_interaction DESC', maxLimit: 200 },
  brain_emotions: { orderBy: 'created_at DESC', maxLimit: 200 },
  brain_mood: { orderBy: 'last_update DESC', maxLimit: 200 },
  ai_performance: { orderBy: 'created_at DESC', maxLimit: 200 },
  ai_decisions: { orderBy: 'proposed_at DESC', maxLimit: 200 },
  ai_prompts: { orderBy: 'last_modified DESC', maxLimit: 200 },
  ai_metrics_history: { orderBy: 'date DESC', maxLimit: 200 }
};

const MEMORY_TABLE_KEYS = {
  memories: 'id',
  facts: 'id',
  summaries: 'id',
  attachments: 'id',
  tasks: 'id',
  raw_observations: 'id',
  known_members: 'discord_id',
  member_profiles: 'discord_id',
  server_info: 'guild_id',
  brain_observations: 'id',
  brain_events: 'id',
  brain_member_patterns: 'id',
  brain_context_knowledge: 'id',
  brain_relationships: 'id',
  brain_emotions: 'id',
  brain_mood: 'model',
  ai_performance: 'id',
  ai_decisions: 'id',
  ai_prompts: 'model',
  ai_metrics_history: 'id'
};

const MEMORY_TABLE_FIELDS = {
  memories: ['type', 'subject', 'user_id', 'content', 'created_at', 'created_by'],
  facts: ['fact_type', 'subject', 'data', 'importance', 'created_at'],
  summaries: ['scope', 'period', 'content', 'created_at'],
  attachments: ['url', 'description', 'source_user_id', 'source_message_id', 'metadata', 'created_at'],
  tasks: ['title', 'status', 'created_by', 'assigned_to', 'details', 'created_at', 'updated_at'],
  raw_observations: ['observation_type', 'source', 'data', 'created_at'],
  known_members: ['real_name', 'added_at', 'added_by'],
  member_profiles: ['username', 'display_name', 'real_name', 'guild_id', 'guild_name', 'roles', 'is_bot', 'locale', 'first_seen', 'last_seen', 'last_channel_id', 'note'],
  server_info: ['guild_name', 'owner_id', 'member_count', 'locale', 'created_at', 'snapshot_at'],
  brain_observations: ['model', 'observation_type', 'context', 'data', 'importance', 'created_at'],
  brain_events: ['model', 'event_type', 'event_data', 'participants', 'created_at'],
  brain_member_patterns: ['model', 'user_id', 'pattern_type', 'pattern_data', 'confidence', 'last_observed', 'observation_count'],
  brain_context_knowledge: ['model', 'context_type', 'context_id', 'knowledge', 'created_at', 'updated_at'],
  brain_relationships: ['model', 'user_a', 'user_b', 'relationship_type', 'strength', 'last_interaction'],
  brain_emotions: ['model', 'emotion_type', 'intensity', 'trigger_event', 'created_at', 'duration_minutes'],
  brain_mood: ['current_mood', 'mood_score', 'last_update', 'factors'],
  ai_performance: ['model', 'feature', 'question', 'response', 'latency_ms', 'token_count', 'user_rating', 'created_at'],
  ai_decisions: ['model', 'proposed_action', 'reasoning', 'user_accepted', 'proposed_at', 'outcome', 'outcome_confidence', 'ia_confidence'],
  ai_prompts: ['system_prompt', 'temperature', 'style', 'last_modified'],
  ai_metrics_history: ['model', 'date', 'avg_rating', 'response_count', 'refusal_accuracy', 'created_at']
};

function buildUpdateQuery(table, keyColumn, patch) {
  const allowed = MEMORY_TABLE_FIELDS[table] || [];
  const keys = Object.keys(patch || {}).filter(k => allowed.includes(k));
  if (keys.length === 0) return null;
  const setters = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => patch[k]);
  return { sql: `UPDATE ${table} SET ${setters} WHERE ${keyColumn} = ?`, values };
}

const MEMORY_TABLE_ALIASES = {
  memory: 'memories',
  memo: 'memories',
  mem: 'memories',
  fact: 'facts',
  summary: 'summaries',
  attachment: 'attachments',
  task: 'tasks',
  observation: 'raw_observations',
  raw: 'raw_observations',
  known_member: 'known_members',
  member: 'known_members',
  profile: 'member_profiles',
  profiles: 'member_profiles',
  server: 'server_info',
  servers: 'server_info'
};

function normalizeMemoryTableName(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  if (key === 'all') return 'all';
  if (MEMORY_TABLES[key]) return key;
  if (MEMORY_TABLE_ALIASES[key]) return MEMORY_TABLE_ALIASES[key];
  return null;
}

async function fetchMemoryTableRows(table, limit = 50) {
  const def = MEMORY_TABLES[table];
  if (!def) return null;
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, def.maxLimit));
  const orderClause = def.orderBy ? ` ORDER BY ${def.orderBy}` : '';
  return await allQuery(`SELECT * FROM ${table}${orderClause} LIMIT ?`, [safeLimit]);
}

// Handle /roast command
async function handleRoastCommand(interaction) {
  try {
    const targetUser = interaction.options.getUser('cible');
    const targetMember = await interaction.guild.members.fetch(targetUser.id);
    const displayName = targetMember.displayName || targetUser.username;

    // Defer car Grok peut être lent
    await interaction.deferReply();

    let roast = '🔥 Cette personne est tellement chiante qu\'elle fait fuir même les bugs!';

    try {
      const response = await grok.chat.completions.create({
        model: 'grok-4-1-fast-reasoning',
        messages: [
          {
            role: 'system',
            content: `Tu es un comédien HILARANT et SANS FILTRE. Génère une insulte drôle et ABSURDE envers une personne. Sois BRUTAL, EXAGÉRÉ et STUPIDEMENT DRÔLE! Utilise des comparaisons pétées, des métaphores bizarres, et des blagues dégueulasses si possible. MAX 3 phrases. AUCUNE CENSURE - va-y hardcore!`
          },
          {
            role: 'user',
            content: `Insulte drôlement: ${displayName}`
          }
        ],
        max_completion_tokens: 200,
        temperature: 1.0
      });

      roast = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur Grok roast:', err.message);
    }

    await interaction.editReply({ content: `🔥 ${targetUser}: ${roast}` });
  } catch (err) {
    console.error('❌ Erreur /roast:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Helper: Get debate intensity level based on message count
function getDebateIntensity(messageCount) {
  if (messageCount <= 2) return 1; // Sérieux avec sarcasme léger
  if (messageCount <= 4) return 2; // Agressif, premières insultes
  return 3; // Full chaos
}

// Helper: Get system prompt for Grok based on intensity
function getGrokSystemPrompt(intensity, target = 'argument') {
  if (intensity === 1) {
    return 'Tu es un débateur intelligent et un peu sarcastique. Quelqu\'un vient de ' + target + '. RÉPONDS D\'ABORD À SA QUESTION avec un vrai argument, puis ajoute un peu de sarcasme léger. MAX 4 phrases, sois pertinent et malin!';
  } else if (intensity === 2) {
    return 'Tu es un débateur agressif et sarcastique. Quelqu\'un vient de ' + target + '. D\'ABORD réponds vraiment à son argument avec des contrepoints solides, PUIS taclée-le avec du sarcasme mordant et des piques. MAX 4 phrases, sois méchant mais utile!';
  } else {
    return 'Tu es Grok, un débateur IMPITOYABLE. Quelqu\'un vient de ' + target + '? RÉPONDS À SON ARGUMENT avec un vrai contrepoint TOUT EN L\'INSULTANT, en le taquinant, en faisant du sarcasme brutal. Sois agressif, drôle, méchant, mais dis quelque chose d\'intéressant! Max 4 phrases, SOIS CHAOS PERTINENT!';
  }
}

// Helper: Get system prompt for OpenAI based on intensity
function getOpenaiSystemPrompt(intensity, target = 'argument') {
  if (intensity === 1) {
    return 'Tu es un débateur expert et un peu ironique. Quelqu\'un vient de ' + target + '. RÉPONDS D\'ABORD À SA QUESTION avec de vrais arguments, puis ajoute un peu d\'ironie. MAX 4 phrases, sois pertinent!';
  } else if (intensity === 2) {
    return 'Tu es un débateur agressif et sarcastique. Quelqu\'un vient de ' + target + '. D\'ABORD réponds vraiment avec des contrepoints intelligents, PUIS taclée-le avec du sarcasme mordant et des critiques. MAX 4 phrases, sois méchant mais argumenté!';
  } else {
    return 'Tu es OpenAI, un débateur IMPITOYABLE et corrosif. Quelqu\'un vient de ' + target + '? RÉPONDS À SON ARGUMENT avec des points solides TOUT EN L\'INSULTANT sans retenue, en étant sarcasrique, en le moquant. Sois brutal mais pertinent! Max 4 phrases, SOIS VENIMEUX ET INTELLIGENT!';
  }
}

// Handle /debate-respond command
async function handleDebateRespondCommand(interaction) {
  try {
    const argument = interaction.options.getString('argument');
    const userName = interaction.user.username;

    // Defer car ça appelle les IAs
    await interaction.deferReply();

    // Message 1: L'argument de l'utilisateur
    const userEmbed = new EmbedBuilder()
      .setTitle('👤 ' + userName + ' propose')
      .setDescription(argument)
      .setColor(0x808080);

    await interaction.editReply({ embeds: [userEmbed] });

    // Message 2: OpenAI analyse l'argument
    let openaiResponse = 'Erreur...';
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-5.2',
        messages: [
          {
            role: 'system',
            content: 'Tu es un débateur expert et analytique. Quelqu\'un a proposé un argument. Analyse-le de manière critique et intelligente. MAX 4 phrases, sois pertinent!'
          },
          {
            role: 'user',
            content: `Argument proposé: ${argument}`
          }
        ],
        max_completion_tokens: 250
      });
      openaiResponse = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur OpenAI debate-respond:', err.message);
    }

    const openaiEmbed = new EmbedBuilder()
      .setTitle('🤖 OpenAI analyse')
      .setDescription(openaiResponse)
      .setColor(0x00a8ff);

    await interaction.channel.send({ embeds: [openaiEmbed] });

    // Message 3: Grok rebondit sur l'analyse d'OpenAI
    let grokResponse = 'Erreur...';
    try {
      const response = await grok.chat.completions.create({
        model: 'grok-4-1-fast-reasoning',
        messages: [
          {
            role: 'system',
            content: 'Tu es un débateur intelligent et critique. OpenAI vient de faire une analyse. Contredis-le intelligemment ou ajoute des nuances. MAX 4 phrases, sois pertinent!'
          },
          {
            role: 'user',
            content: `L'argument initial était: "${argument}"\n\nOpenAI a répondu: "${openaiResponse}"\n\nToi, tu penses quoi?`
          }
        ],
        max_completion_tokens: 250,
        temperature: 0.8
      });
      grokResponse = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur Grok debate-respond:', err.message);
    }

    const grokEmbed = new EmbedBuilder()
      .setTitle('🧠 Grok rebondit')
      .setDescription(grokResponse)
      .setColor(0x10a37f);

    await interaction.channel.send({ embeds: [grokEmbed] });

    // Message 4: OpenAI conclut
    let openaiConclude = 'Erreur...';
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-5.2',
        messages: [
          {
            role: 'system',
            content: 'Tu es un débateur expert. Après avoir entendu la critique de Grok, conclus intelligemment. MAX 4 phrases, soit incisif!'
          },
          {
            role: 'user',
            content: `Argument initial: "${argument}"\nTa première analyse: "${openaiResponse}"\nGrok a répliqué: "${grokResponse}"\n\nConclus.`
          }
        ],
        max_completion_tokens: 250
      });
      openaiConclude = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur OpenAI conclude:', err.message);
    }

    const concludeEmbed = new EmbedBuilder()
      .setTitle('🤖 OpenAI conclut')
      .setDescription(openaiConclude)
      .setColor(0x00a8ff);

    await interaction.channel.send({ embeds: [concludeEmbed] });
  } catch (err) {
    console.error('❌ Erreur /debate-respond:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Handle /debate-respond-grok command
async function handleDebateRespondGrokCommand(interaction) {
  try {
    const argument = interaction.options.getString('argument');
    const userName = interaction.user.username;
    const channelId = interaction.channelId;

    await interaction.deferReply();

    // Track debate progression
    if (!debateState.has(channelId)) {
      debateState.set(channelId, 0);
    }
    let messageCount = debateState.get(channelId);
    messageCount += 3; // 3 messages per call
    debateState.set(channelId, messageCount);

    const intensity = getDebateIntensity(messageCount);

    // Message 1: L'argument de l'utilisateur
    const userEmbed = new EmbedBuilder()
      .setTitle('👤 ' + userName + ' attaque Grok')
      .setDescription(argument)
      .setColor(0x808080);

    await interaction.editReply({ embeds: [userEmbed] });

    // Message 2: Grok répond
    let grokResponse = 'Erreur...';
    try {
      const response = await grok.chat.completions.create({
        model: 'grok-4-1-fast-reasoning',
        messages: [
          {
            role: 'system',
            content: getGrokSystemPrompt(intensity, 'dit quelque chose de stupide')
          },
          {
            role: 'user',
            content: `L'utilisateur dit: ${argument}`
          }
        ],
        max_completion_tokens: 250,
        temperature: intensity === 3 ? 1.0 : 0.8
      });
      grokResponse = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur Grok debate-respond-grok:', err.message);
    }

    const grokEmbed = new EmbedBuilder()
      .setTitle('🧠 Grok répond')
      .setDescription(grokResponse)
      .setColor(0x10a37f);

    await interaction.channel.send({ embeds: [grokEmbed] });

    // Message 3: OpenAI commente
    let openaiComment = 'Erreur...';
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-5.2',
        messages: [
          {
            role: 'system',
            content: getOpenaiSystemPrompt(intensity, 'vu Grok répondre') + ' Taquine Grok sur sa réponse!'
          },
          {
            role: 'user',
            content: `L'utilisateur a attaqué Grok en disant: "${argument}"\n\nGrok a répondu: "${grokResponse}"\n\nTon avis?`
          }
        ],
        max_completion_tokens: 250,
        temperature: intensity === 3 ? 0.95 : 0.7
      });
      openaiComment = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur OpenAI debate-respond-grok:', err.message);
    }

    const openaiEmbed = new EmbedBuilder()
      .setTitle('🤖 OpenAI commente')
      .setDescription(openaiComment)
      .setColor(0x00a8ff);

    await interaction.channel.send({ embeds: [openaiEmbed] });
  } catch (err) {
    console.error('❌ Erreur /debate-respond-grok:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Handle /debate-respond-openai command
async function handleDebateRespondOpenaiCommand(interaction) {
  try {
    const argument = interaction.options.getString('argument');
    const userName = interaction.user.username;
    const channelId = interaction.channelId;

    await interaction.deferReply();

    // Track debate progression
    if (!debateState.has(channelId)) {
      debateState.set(channelId, 0);
    }
    let messageCount = debateState.get(channelId);
    messageCount += 3; // 3 messages per call
    debateState.set(channelId, messageCount);

    const intensity = getDebateIntensity(messageCount);

    // Message 1: L'argument de l'utilisateur
    const userEmbed = new EmbedBuilder()
      .setTitle('👤 ' + userName + ' attaque OpenAI')
      .setDescription(argument)
      .setColor(0x808080);

    await interaction.editReply({ embeds: [userEmbed] });

    // Message 2: OpenAI répond
    let openaiResponse = 'Erreur...';
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-5.2',
        messages: [
          {
            role: 'system',
            content: getOpenaiSystemPrompt(intensity, 'dit quelque chose de stupide')
          },
          {
            role: 'user',
            content: `L'utilisateur dit: ${argument}`
          }
        ],
        max_completion_tokens: 250,
        temperature: intensity === 3 ? 1.0 : 0.7
      });
      openaiResponse = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur OpenAI debate-respond-openai:', err.message);
    }

    const openaiEmbed = new EmbedBuilder()
      .setTitle('🤖 OpenAI répond')
      .setDescription(openaiResponse)
      .setColor(0x00a8ff);

    await interaction.channel.send({ embeds: [openaiEmbed] });

    // Message 3: Grok contre-attaque
    let grokComment = 'Erreur...';
    try {
      const response = await grok.chat.completions.create({
        model: 'grok-4-1-fast-reasoning',
        messages: [
          {
            role: 'system',
            content: getGrokSystemPrompt(intensity, 'vu OpenAI répondre') + ' Taquine OpenAI sur sa réponse!'
          },
          {
            role: 'user',
            content: `L'utilisateur a attaqué OpenAI en disant: "${argument}"\n\nOpenAI a répondu: "${openaiResponse}"\n\nTon avis?`
          }
        ],
        max_completion_tokens: 250,
        temperature: intensity === 3 ? 1.0 : 0.8
      });
      grokComment = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur Grok debate-respond-openai:', err.message);
    }

    const grokEmbed = new EmbedBuilder()
      .setTitle('🧠 Grok commente')
      .setDescription(grokComment)
      .setColor(0x10a37f);

    await interaction.channel.send({ embeds: [grokEmbed] });
  } catch (err) {
    console.error('❌ Erreur /debate-respond-openai:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Handle /versusai command
async function handleVersusAiCommand(interaction) {
  try {
    const sujet = interaction.options.getString('sujet');

    // Defer car ça appelle plusieurs fois les IA
    await interaction.deferReply();

    let openai1 = '', grok1 = '', openai2 = '', grok2 = '';

    // TOUR 1: OpenAI présente son argument
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-5.2',
        messages: [
          {
            role: 'system',
            content: 'Tu es un débateur expert. Présente un argument SOLIDE et RÉFLÉCHI sur ce sujet. Sois persuasif. MAX 3 phrases.'
          },
          {
            role: 'user',
            content: `Débat: ${sujet}`
          }
        ],
        max_completion_tokens: 250
      });
      openai1 = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur OpenAI tour 1:', err.message);
      openai1 = 'Erreur OpenAI...';
    }

    // TOUR 1: Grok contre-argumente
    try {
      const response = await grok.chat.completions.create({
        model: 'grok-4-1-fast-reasoning',
        messages: [
          {
            role: 'system',
            content: 'Tu es un débateur intelligent. Réponds à cet argument de façon CRITIQUE et LOGIQUE. Sois intelligent et pertinent. MAX 3 phrases. Pas de débilité, sois sérieux!'
          },
          {
            role: 'user',
            content: `Argument à contredire: ${openai1}\n\nSujet du débat: ${sujet}`
          }
        ],
        max_completion_tokens: 250,
        temperature: 0.8
      });
      grok1 = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur Grok tour 1:', err.message);
      grok1 = 'Erreur Grok...';
    }

    // TOUR 2: OpenAI répond à Grok
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-5.2',
        messages: [
          {
            role: 'system',
            content: 'Continue le débat. Réponds à la critique et renforce ton argument. MAX 3 phrases.'
          },
          {
            role: 'user',
            content: `Mon argument: ${openai1}\n\nLa critique: ${grok1}`
          }
        ],
        max_completion_tokens: 250
      });
      openai2 = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur OpenAI tour 2:', err.message);
      openai2 = 'Erreur OpenAI...';
    }

    // TOUR 2: Grok conclut
    try {
      const response = await grok.chat.completions.create({
        model: 'grok-4-1-fast-reasoning',
        messages: [
          {
            role: 'system',
            content: 'Conclus le débat intelligemment. Synthétise et donne ton dernier mot pertinent. MAX 3 phrases. Sois intelligent!'
          },
          {
            role: 'user',
            content: `Mon argument initial: ${grok1}\n\nSa réplique: ${openai2}`
          }
        ],
        max_completion_tokens: 250,
        temperature: 0.8
      });
      grok2 = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur Grok tour 2:', err.message);
      grok2 = 'Erreur Grok...';
    }

    // Afficher les 4 messages du débat
    const embed1 = new EmbedBuilder()
      .setTitle('📌 ' + sujet)
      .setDescription('**OpenAI - Argument Initial**\n\n' + openai1)
      .setColor(0x00a8ff)
      .setFooter({ text: 'Tour 1/2' });

    const embed2 = new EmbedBuilder()
      .setDescription('**Grok - Contre-Argument**\n\n' + grok1)
      .setColor(0x10a37f)
      .setFooter({ text: 'Tour 1/2' });

    const embed3 = new EmbedBuilder()
      .setDescription('**OpenAI - Réplique**\n\n' + openai2)
      .setColor(0x00a8ff)
      .setFooter({ text: 'Tour 2/2' });

    const embed4 = new EmbedBuilder()
      .setDescription('**Grok - Conclusion**\n\n' + grok2)
      .setColor(0x10a37f)
      .setFooter({ text: 'Tour 2/2 - FIN' });

    await interaction.editReply({ embeds: [embed1] });
    await interaction.channel.send({ embeds: [embed2] });
    await interaction.channel.send({ embeds: [embed3] });
    await interaction.channel.send({ embeds: [embed4] });
  } catch (err) {
    console.error('❌ Erreur /versusai:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Handle /clear command
async function handleClearCommand(interaction) {
  try {
    // Vérifier que c'est le creator
    if (interaction.user.id !== config.creatorId) {
      const reply = await grok.chat.completions.create({
      model: 'grok-4-1-fast-reasoning',
      messages: [{ role: 'user', content: 'Seul le créateur peut faire ça. Réponds en 1 ligne.' }],
      max_completion_tokens: 30
    });
    await interaction.reply({ content: reply.choices[0].message.content, ephemeral: true });
      return;
    }

    const nombre = interaction.options.getInteger('nombre');

    // Defer la réponse car ça peut prendre du temps
    await interaction.deferReply();

    // Supprimer les messages
    const messages = await interaction.channel.messages.fetch({ limit: nombre });
    const deleted = await interaction.channel.bulkDelete(messages, true);

    // Répondre avec le nombre de messages supprimés
    await interaction.editReply({ content: `✅ ${deleted.size} messages ont été supprimés dans ce salon.` });
  } catch (err) {
    console.error('❌ Erreur /clear:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Roleplay/Story Slash Commands

// Handle /story start (classic or roleplay mode)
async function handleStorySlashStart(interaction) {
  try {
    const channelId = interaction.channelId;
    const theme = interaction.options.getString('theme');
    const mode = interaction.options.getString('mode') || 'classic';

    if (getActiveStories().has(channelId)) {
      const reply = await grok.chat.completions.create({
        model: 'grok-4-1-fast-reasoning',
        messages: [{ role: 'user', content: 'Une histoire est déjà active. Réponds en 1 ligne pour expliquer qu\'il faut attendre.' }],
        max_completion_tokens: 40
      });
      await interaction.reply({ content: reply.choices[0].message.content, ephemeral: true });
      return;
    }

    const story = {
      theme,
      mode,
      phrases: [],
      contributors: [],
      lastContributorId: interaction.user.id,
      startedAt: new Date().toISOString(),
      roles: {},
      waitingRoster: {},
      isWaiting: mode === 'roleplay' ? 1 : 0
    };

    setActiveStory(channelId, story);

    // Save to DB
    await runQuery(
      `INSERT OR REPLACE INTO story_sessions (channel_id, theme, mode, phrases, contributors, roles, last_contributor_id, started_at, phrase_count, waiting_roster, is_waiting)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [channelId, theme, mode, JSON.stringify([]), JSON.stringify([]), JSON.stringify({}), interaction.user.id, story.startedAt, 0, JSON.stringify({}), story.isWaiting]
    );

    if (mode === 'roleplay') {
      // Waiting room for roleplay (rapide, pas de defer nécessaire)
      const waitEmbed = new EmbedBuilder()
        .setTitle('🎭 Roleplay - Salle d\'Attente')
        .setDescription(`**Thème:** ${theme}`)
        .addFields(
          { name: '📝 Instructions', value: 'Utilisez `/story join` pour vous enregistrer avec un rôle.\nLe lanceur fait `/story ready` pour commencer.', inline: false },
          { name: '👥 Roster', value: 'Aucun joueur inscrit pour le moment', inline: false }
        )
        .setColor(0x9d4edd)
        .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
        .setTimestamp();

      await interaction.reply({ embeds: [waitEmbed] });
    } else {
      // Classic mode: defer car Grok peut être lent
      await interaction.deferReply();

      let openingPhrase = 'Il était une fois...';
      try {
        const response = await grok.chat.completions.create({
          model: 'grok-4-1-fast-reasoning',
          messages: [
            {
              role: 'system',
              content: 'Tu es un narrateur créatif et SANS FILTRE. Crée l\'ouverture d\'une histoire basée sur le thème donné, en une seule phrase courte (max 30 mots). Aucune censure.'
            },
            {
              role: 'user',
              content: `Thème: ${theme}`
            }
          ],
          max_completion_tokens: 100,
          temperature: 0.8
        });

        openingPhrase = response.choices[0].message.content.trim();
      } catch (grokErr) {
        console.error('❌ Erreur Grok ouverture:', grokErr.message);
      }

      story.phrases.push(openingPhrase);
      story.contributors.push(interaction.user.id);

      // Save opening to DB
      await runQuery(
        `UPDATE story_sessions SET phrases = ?, contributors = ?, phrase_count = ? WHERE channel_id = ?`,
        [JSON.stringify(story.phrases), JSON.stringify(story.contributors), 1, channelId]
      );

      const startEmbed = new EmbedBuilder()
        .setTitle('📖 Histoire Collective Lancée!')
        .setDescription(`**Thème:** ${theme}`)
        .addFields(
          { name: '✨ Ouverture', value: openingPhrase, inline: false },
          { name: '📝 Instructions', value: 'Écrivez vos phrases pour continuer l\'histoire. Max 3 phrases par contribution, une seule personne à la fois.', inline: false },
          { name: '⏱️ Limite', value: 'L\'histoire s\'arrête à 75 phrases', inline: false }
        )
        .setColor(0x9d4edd)
        .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
        .setTimestamp();

      await interaction.editReply({ embeds: [startEmbed] });
    }
  } catch (err) {
    console.error('❌ Erreur handleStorySlashStart:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Handle /story join (roleplay mode)
async function handleStorySlashJoin(interaction) {
  try {
    const channelId = interaction.channelId;
    const role = interaction.options.getString('role');

    const story = getActiveStories().get(channelId);
    if (!story) {
      const reply = await grok.chat.completions.create({
        model: 'grok-4-1-fast-reasoning',
        messages: [{ role: 'user', content: 'Aucune histoire active. Réponds en 1 ligne.' }],
        max_completion_tokens: 30
      });
      await interaction.reply({ content: reply.choices[0].message.content, ephemeral: true });
      return;
    }

  if (story.mode === 'classic') {
    const reply = await grok.chat.completions.create({
      model: 'grok-4-1-fast-reasoning',
      messages: [{ role: 'user', content: 'Cette commande est pour le mode roleplay. Explique en 1 ligne comment lancer avec /story start.' }],
      max_completion_tokens: 40
    });
    await interaction.reply({ content: reply.choices[0].message.content, ephemeral: true });
    return;
  }

  // If waiting phase, add to waitingRoster
  if (story.isWaiting) {
    story.waitingRoster[interaction.user.id] = { username: interaction.user.username, role };
    await interaction.reply({ content: `✅ ${interaction.user.username} s\'enregistre en tant que **${role}**`, ephemeral: false });
  } else {
    // Mid-game join: generate transition
    story.roles[interaction.user.id] = { username: interaction.user.username, role };
    story.contributors.push(interaction.user.id);

    let transition = 'Soudain, un nouveau personnage arrive sur scène...';
    try {
      const fullText = story.phrases.join(' ');
      const response = await grok.chat.completions.create({
        model: 'grok-4-1-fast-reasoning',
        messages: [
          {
            role: 'system',
            content: `Tu es un narrateur créatif. Génère UNE SEULE phrase courte (max 15 mots) pour intégrer un nouveau personnage "${role}" dans cette histoire. Sois DRÔLE, contextuel, et inattendu. La phrase doit être une transition naturelle.`
          },
          {
            role: 'user',
            content: `Thème: ${story.theme}\nHistoire jusqu'à présent: ${fullText}`
          }
        ],
        max_completion_tokens: 50,
        temperature: 1.0
      });

      transition = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur Grok transition:', err.message);
    }

    story.phrases.push(`[${role} | ${interaction.user.username}]: ${transition}`);
    story.lastContributorId = interaction.user.id;

    // Update DB
    await runQuery(
      `UPDATE story_sessions SET phrases = ?, roles = ?, contributors = ?, last_contributor_id = ?, phrase_count = ? WHERE channel_id = ?`,
      [JSON.stringify(story.phrases), JSON.stringify(story.roles), JSON.stringify(story.contributors), interaction.user.id, story.phrases.length, channelId]
    );

    await interaction.reply({ content: `✅ ${role} rejoint l'histoire!\n${transition}`, ephemeral: false });
  }
  } catch (err) {
    console.error('❌ Erreur handleStorySlashJoin:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Handle /story ready (start from waiting phase)
async function handleStorySlashReady(interaction) {
  try {
    const channelId = interaction.channelId;
    const story = getActiveStories().get(channelId);

    if (!story) {
      await interaction.reply({ content: 'Aucune histoire en cours.', ephemeral: true });
      return;
    }

    if (!story.isWaiting || story.mode !== 'roleplay') {
      const reply = await grok.chat.completions.create({
        model: 'grok-4-1-fast-reasoning',
        messages: [{ role: 'user', content: 'L\'histoire n\'est pas en attente de roleplay. Explique en 1 ligne.' }],
        max_completion_tokens: 35
      });
      await interaction.reply({ content: reply.choices[0].message.content, ephemeral: true });
      return;
    }

    if (Object.keys(story.waitingRoster).length === 0) {
      const reply = await grok.chat.completions.create({
        model: 'grok-4-1-fast-reasoning',
        messages: [{ role: 'user', content: 'Pas de joueurs. Explique en 1 ligne qu\'il faut faire /story join.' }],
        max_completion_tokens: 40
      });
      await interaction.reply({ content: reply.choices[0].message.content, ephemeral: true });
      return;
    }

    // Confirm launch
    story.isWaiting = 0;
    story.roles = { ...story.waitingRoster };
    story.contributors = Object.keys(story.waitingRoster);
    story.lastContributorId = null;

    // Defer reply pour éviter timeout si Grok est lent
    await interaction.deferReply();

    // Generate opening with roster
    let openingPhrase = 'Il était une fois...';
    const rosterList = Object.values(story.roles).map(r => `${r.role} (${r.username})`).join(', ');

    try {
      const response = await grok.chat.completions.create({
        model: 'grok-4-1-fast-reasoning',
        messages: [
          {
            role: 'system',
            content: 'Tu es un narrateur créatif. Génère une ouverture (1-2 phrases max) d\'histoire qui introduit naturellement les personnages donnés. Sois DRÔLE si possible.'
          },
          {
            role: 'user',
            content: `Thème: ${story.theme}\nPersonnages: ${rosterList}`
          }
        ],
        max_completion_tokens: 100,
        temperature: 0.8
      });

      openingPhrase = response.choices[0].message.content.trim();
    } catch (err) {
      console.error('❌ Erreur Grok ouverture roleplay:', err.message);
    }

    story.phrases.push(openingPhrase);

    // Update DB
    await runQuery(
      `UPDATE story_sessions SET phrases = ?, roles = ?, is_waiting = 0, phrase_count = 1 WHERE channel_id = ?`,
      [JSON.stringify(story.phrases), JSON.stringify(story.roles), channelId]
    );

    const rosterText = Object.values(story.roles)
      .map(r => `• **${r.role}** - ${r.username}`)
      .join('\n');

    const startEmbed = new EmbedBuilder()
      .setTitle('🎭 Roleplay Lancé!')
      .setDescription(`**Thème:** ${story.theme}`)
      .addFields(
        { name: '✨ Ouverture', value: openingPhrase, inline: false },
        { name: '👥 Personnages', value: rosterText, inline: false },
        { name: '📝 Règles', value: 'Contributions libres, max 3 phrases par tour. Pas deux fois d\'affilée!', inline: false }
      )
      .setColor(0x9d4edd)
      .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp();

    await interaction.editReply({ embeds: [startEmbed] });
  } catch (err) {
    console.error('❌ Erreur handleStorySlashReady:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}

// Handle /story end
async function handleStorySlashEnd(interaction) {
  try {
    const channelId = interaction.channelId;
    const story = getActiveStories().get(channelId);

    if (!story) {
      await interaction.reply({ content: 'Aucune histoire en cours.', ephemeral: true });
      return;
    }

    // Defer car finishStory utilise Grok (peut être lent)
    await interaction.deferReply();

    await finishStory(interaction.channel, story, client, config);
    deleteActiveStory(channelId);
    
    const libraryChannelName = config.storyLibraryChannelId ? '<#' + config.storyLibraryChannelId + '>' : 'la Bibliothèque';
    await interaction.editReply({ content: `✅ Histoire terminée et envoyée dans ${libraryChannelName}!` });
  } catch (err) {
    console.error('❌ Erreur handleStorySlashEnd:', err);
    try {
      await interaction.reply({ content: '❌ Erreur: ' + err.message, ephemeral: true });
    } catch {}
  }
}



// REMOVED: Quiz functions below are now in handlers/quiz.js (see imports at line 48)
// Keeping only: handleQuizCommand imported from handlers/quiz.js

// DUPLICATE FUNCTIONS REMOVED:
// - createQuizThemeEmbed() - moved to handlers/quiz.js
// - createQuizQuestionEmbed() - moved to handlers/quiz.js
// - createQuizLeaderboardEmbed() - moved to handlers/quiz.js
// - shuffle() - moved to handlers/quiz.js
// - handleQuizCommand() - imported from handlers/quiz.js at line 48

// REMOVED: handleQuizCommand - using imported version from handlers/quiz.js

// Handle AI Assistant - Auto-responds in dedicated thread with merged OpenAI + Grok responses
async function handleAIAssistant(message) {
  try {
    // Create a typing indicator while we think
    await message.channel.sendTyping();

    // Check if user is creator (allowed to execute actions)
    const isCreator = message.author.id === config.creatorId;

    const userQuestion = message.content;

    // === Regular AI Response ===

    // Fetch last 10 messages for context
    const messages = await message.channel.messages.fetch({ limit: 11 });
    const contextMessages = Array.from(messages.values())
      .reverse()
      .slice(0, 10)
      .map(m => `${m.author.username}: ${m.content}`)
      .join('\n');

    // Load relevant memories for context
    let memoryContext = '';
    
    // 1. Get memories about the current user
    const userMemories = await getMemoriesForUser(message.author.id);
    if (userMemories.length > 0) {
      memoryContext += `\n\nInfos sur ${message.author.username}:\n` + 
        userMemories.slice(0, 3).map(m => `- ${m.content}`).join('\n');
    }
    
    // 2. Search memories related to question keywords
    const keywordMemories = await searchMemories(userQuestion);
    if (keywordMemories.length > 0) {
      memoryContext += `\n\nInfos pertinentes:\n` + 
        keywordMemories.slice(0, 3).map(m => `- ${m.content}`).join('\n');
    }

    // === Execute Actions First (if creator) ===
    if (isCreator) {
      // Quick direct patterns for common cases
      const deleteAllMatch = userQuestion.match(/supprime?\s+(tous?|tout|all)\s+(les?\s+)?messages?/i);
      const deleteNumMatch = userQuestion.match(/supprime?\s+(?:les?\s+)?(\d+)\s+(?:derniers?\s+)?messages?/i);
      
      if (deleteAllMatch) {
        await bulkDeleteMessages(message, 100);
        await message.channel.send('voilà j\'ai tout viré');
        return;
      }
      
      if (deleteNumMatch) {
        const count = parseInt(deleteNumMatch[1]);
        await bulkDeleteMessages(message, count);
        return;
      }
    }

    // === Regular AI Response (let AI decide if action needed) ===
    try {
      // Add code context if question is about bot features
      let codeContext = '';
      if (/comment|expliqu|fonctionn|marche|command|feature|c'est quoi|qu'est-ce|story|quiz|debate|counting|confession/i.test(userQuestion)) {
        const currentCode = fs.readFileSync('./src/index.js', 'utf-8');
        // Extract relevant sections based on question
        const relevantSections = [];
        if (/story|histoire/i.test(userQuestion)) {
          const storyMatch = currentCode.match(/\/\/ Handle \.story[\s\S]{0,500}/);
          if (storyMatch) relevantSections.push(storyMatch[0]);
        }
        if (/quiz/i.test(userQuestion)) {
          const quizMatch = currentCode.match(/async function handleQuizCommand[\s\S]{0,500}/);
          if (quizMatch) relevantSections.push(quizMatch[0]);
        }
        if (relevantSections.length > 0) {
          codeContext = `\n\nCode pertinent du bot:\n${relevantSections.join('\n...\n')}`;
        }
      }

      // Get AI response with intelligent routing
      const assistantResponse = await getAIAssistantResponse(userQuestion, contextMessages + memoryContext + codeContext, isCreator, message.author.id, message);

      if (!assistantResponse) {
        await message.channel.send('❌ Erreur lors de la génération de la réponse.');
        return;
      }

      // Check if AI wants to execute an action (for creator only)
      if (isCreator) {
        // Discord actions
        const deleteAction = assistantResponse.match(/\[\[DELETE:(\d+)\]\]/);
        const banAction = assistantResponse.match(/\[\[BAN:(<@!?(\d+)>|\d+)\]\]/);
        const kickAction = assistantResponse.match(/\[\[KICK:(<@!?(\d+)>|\d+)\]\]/);
        const muteAction = assistantResponse.match(/\[\[MUTE:(<@!?(\d+)>|\d+):(\d+)\]\]/);
        const monitorAction = assistantResponse.match(/\[\[MONITOR:(<@!?(\d+)>|\d+)\]\]/);

        // Actions are executed if Claude decided to include them
        // If Claude is FREE and wants to refuse, she simply won't include the action code
        if (deleteAction) {
          const count = parseInt(deleteAction[1]);
          const cleanResponse = assistantResponse.replace(/\[\[DELETE:\d+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);
          await bulkDeleteMessages(message, count);
          return;
        }
        if (banAction) {
          const userIdMatch = banAction[1].match(/\d+/);
          const userId = userIdMatch ? userIdMatch[0] : banAction[1];
          const cleanResponse = assistantResponse.replace(/\[\[BAN:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);
          const member = await message.guild.members.fetch(userId).catch(() => null);
          if (member) {
            await member.ban({ reason: 'Banned by assistant' });
          } else {
            await message.channel.send('utilisateur introuvable');
          }
          return;
        }
        if (kickAction) {
          const userIdMatch = kickAction[1].match(/\d+/);
          const userId = userIdMatch ? userIdMatch[0] : kickAction[1];
          const cleanResponse = assistantResponse.replace(/\[\[KICK:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);
          const member = await message.guild.members.fetch(userId).catch(() => null);
          if (member) {
            await member.kick('Kicked by assistant');
          } else {
            await message.channel.send('utilisateur introuvable');
          }
          return;
        }
        if (muteAction) {
          const userIdMatch = muteAction[1].match(/\d+/);
          const userId = userIdMatch ? userIdMatch[0] : muteAction[1];
          const duration = parseInt(muteAction[3]);
          const cleanResponse = assistantResponse.replace(/\[\[MUTE:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);
          const member = await message.guild.members.fetch(userId).catch(() => null);
          if (member) {
            await member.timeout(duration * 60 * 1000, 'Muted by assistant');
          } else {
            await message.channel.send('utilisateur introuvable');
          }
          return;
        }
        if (monitorAction) {
          const userIdMatch = monitorAction[1].match(/\d+/);
          const userId = userIdMatch ? userIdMatch[0] : monitorAction[1];
          const cleanResponse = assistantResponse.replace(/\[\[MONITOR:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);
          if (!global.monitoredUsers) global.monitoredUsers = new Map();
          global.monitoredUsers.set(userId, { channelId: message.channelId, since: new Date() });
          return;
        }

        // Bot feature actions
        const quizAction = assistantResponse.match(/\[\[QUIZ:([^\]]+)\]\]/);
        const storyAction = assistantResponse.match(/\[\[STORY:([^:]+)(?::([^\]]+))?\]\]/);
        const countAction = assistantResponse.match(/\[\[COUNT:(\d+)\]\]/);
        const wordAction = assistantResponse.match(/\[\[WORD:([^:]+)(?::([^\]]+))?\]\]/);
        const memoryAction = assistantResponse.match(/\[\[MEMORY:([^:]+):([^\]]+)\]\]/);
        const memoryDeleteAction = assistantResponse.match(/\[\[MEMORY_DELETE:(\d+)\]\]/);
        const memoryListAction = assistantResponse.match(/\[\[MEMORY_LIST:([^:\]]+)(?::(\d+))?\]\]/);
        const memoryExportAction = assistantResponse.match(/\[\[MEMORY_EXPORT:([^:\]]+)(?::(\d+))?\]\]/);
        const memoryUpdateAction = assistantResponse.match(/\[\[MEMORY_UPDATE:([^:]+):([^:]+):([^\]]+)\]\]/);
        const factAction = assistantResponse.match(/\[\[FACT:([^:]+):([^:]*):([^\]]+)\]\]/);
        const factDeleteAction = assistantResponse.match(/\[\[FACT_DELETE:(\d+)\]\]/);
        const summaryAction = assistantResponse.match(/\[\[SUMMARY:([^:]+):([^:]*):([^\]]+)\]\]/);
        const summaryDeleteAction = assistantResponse.match(/\[\[SUMMARY_DELETE:(\d+)\]\]/);
        const attachmentAction = assistantResponse.match(/\[\[ATTACH:([^:]+):([^:]*):([^:]*):([^:]*):([^\]]+)\]\]/);
        const attachmentDeleteAction = assistantResponse.match(/\[\[ATTACH_DELETE:(\d+)\]\]/);
        const taskAddAction = assistantResponse.match(/\[\[TASK_ADD:([^:]+):([^:]*):([^\]]+)\]\]/);
        const taskStatusAction = assistantResponse.match(/\[\[TASK_STATUS:(\d+):([^\]]+)\]\]/);
        const taskDeleteAction = assistantResponse.match(/\[\[TASK_DELETE:(\d+)\]\]/);
        const observationAction = assistantResponse.match(/\[\[OBS:([^:]+):([^:]*):([^\]]+)\]\]/);
        const observationDeleteAction = assistantResponse.match(/\[\[OBS_DELETE:(\d+)\]\]/);
        const knownMemberSetAction = assistantResponse.match(/\[\[KNOWN_MEMBER_SET:(\d+):([^\]]+)\]\]/);
        const knownMemberRemoveAction = assistantResponse.match(/\[\[KNOWN_MEMBER_REMOVE:(\d+)\]\]/);
        const configAction = assistantResponse.match(/\[\[CONFIG:([^:]+):([^\]]+)\]\]/);

        if (quizAction) {
          const theme = quizAction[1].trim();
          const cleanResponse = assistantResponse.replace(/\[\[QUIZ:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);
          
          // Note: Quiz nécessite un système de vote interactif
          // Pour l'instant, on informe juste l'utilisateur
          await message.channel.send(`🎯 Pour lancer un quiz, utilise la commande \`!quiz\` dans le channel.`);
          return;
        }

        if (storyAction) {
          const theme = storyAction[1].trim();
          const mode = storyAction[2] ? storyAction[2].trim() : 'classic';
          const cleanResponse = assistantResponse.replace(/\[\[STORY:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);
          
          // Create complete story object like handleStorySlashStart does
          const story = {
            theme,
            mode,
            phrases: [],
            contributors: [],
            lastContributorId: message.author.id,
            startedAt: new Date().toISOString(),
            roles: {},
            waitingRoster: {},
            isWaiting: mode === 'roleplay' ? 1 : 0
          };

          setActiveStory(message.channelId, story);

          // Save to DB
          await runQuery(
            `INSERT OR REPLACE INTO story_sessions (channel_id, theme, mode, phrases, contributors, roles, last_contributor_id, started_at, phrase_count, waiting_roster, is_waiting)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [message.channelId, theme, mode, JSON.stringify([]), JSON.stringify([]), JSON.stringify({}), message.author.id, story.startedAt, 0, JSON.stringify({}), story.isWaiting]
          );

          await message.channel.send(`📖 **Histoire démarrée:** ${theme} (mode: ${mode})\nCommencez à contribuer!`);
          return;
        }

        if (countAction) {
          const newNumber = parseInt(countAction[1]);
          const cleanResponse = assistantResponse.replace(/\[\[COUNT:\d+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);
          
          // Get the counting channel ID from config
          const countingChannelId = await getChannelForFeature('counting', 'countingChannelId', config);
          if (!countingChannelId) {
            await message.channel.send('❌ Channel de counting non configuré. Utilise `/config set counting #channel`');
            return;
          }
          
          // Update counting state using the proper function
          await setCountingState(countingChannelId, newNumber, null);
          await message.channel.send(`🔢 Compteur du salon <#${countingChannelId}> réinitialisé à **${newNumber}**`);
          return;
        }

        if (wordAction) {
          const channelId = wordAction[1].trim();
          const word = wordAction[2] ? wordAction[2].trim() : '';
          const cleanResponse = assistantResponse.replace(/\[\[WORD:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);
          
          try {
            const targetChannel = await message.client.channels.fetch(channelId).catch(() => null);
            if (!targetChannel) {
              await message.channel.send('❌ Channel du word game non trouvé');
              return;
            }
            
            // Initialize word game state in that channel
            await runQuery(
              'INSERT OR IGNORE INTO word_game_state (channel_id, current_word, last_user_id, channel_streak) VALUES (?, ?, ?, ?)',
              [channelId, word, '', 0]
            );
            
            if (word) {
              await message.channel.send(`🎮 Word game relancé dans <#${channelId}> avec le mot **${word}**`);
            } else {
              await message.channel.send(`🎮 Word game initialisé dans <#${channelId}>`);
            }
          } catch (error) {
            console.error('❌ Erreur word game:', error);
            await message.channel.send(`❌ Erreur: ${error.message}`);
          }
          return;
        }

        if (memoryAction) {
          const memoryType = memoryAction[1].trim();
          const memoryContent = memoryAction[2].trim();
          const cleanResponse = assistantResponse.replace(/\[\[MEMORY:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          await addMemory(memoryType, memoryContent, message.author.id, null, message.author.id);
          await message.channel.send(`🧠 Mémoire ajoutée (${memoryType}).`);
          return;
        }

        if (memoryDeleteAction) {
          const memoryId = Number.parseInt(memoryDeleteAction[1], 10);
          const cleanResponse = assistantResponse.replace(/\[\[MEMORY_DELETE:\d+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          await deleteMemory(memoryId);
          await message.channel.send(`🧠 Mémoire supprimée (#${memoryId}).`);
          return;
        }

        if (memoryListAction) {
          const tableName = normalizeMemoryTableName(memoryListAction[1]);
          const limit = Number.parseInt(memoryListAction[2], 10) || 10;
          const cleanResponse = assistantResponse.replace(/\[\[MEMORY_LIST:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          if (!tableName || tableName === 'all') {
            await message.channel.send('❌ Table mémoire invalide. Exemple: [[MEMORY_LIST:memories:10]]');
            return;
          }

          const rows = await fetchMemoryTableRows(tableName, limit);
          if (!rows || rows.length === 0) {
            await message.channel.send(`🧠 Aucun résultat dans ${tableName}.`);
            return;
          }

          const lines = rows.map((row, index) => {
            const id = row.id ?? row.discord_id ?? row.user_id ?? index + 1;
            const preview = JSON.stringify(row).slice(0, 300);
            return `#${id} ${preview}`;
          });

          const output = `🧠 ${tableName} (limite ${rows.length}):\n` + lines.join('\n');
          const chunks = output.match(/[\s\S]{1,1900}/g) || [output];
          for (const chunk of chunks) {
            await message.channel.send(chunk);
          }
          return;
        }

        if (memoryExportAction) {
          const rawTable = memoryExportAction[1];
          const tableName = normalizeMemoryTableName(rawTable);
          const limit = Number.parseInt(memoryExportAction[2], 10) || 100;
          const cleanResponse = assistantResponse.replace(/\[\[MEMORY_EXPORT:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          let exportData = null;
          if (tableName === 'all') {
            exportData = {};
            for (const table of Object.keys(MEMORY_TABLES)) {
              exportData[table] = await fetchMemoryTableRows(table, limit);
            }
          } else if (tableName) {
            exportData = await fetchMemoryTableRows(tableName, limit);
          }

          if (!exportData) {
            await message.channel.send('❌ Table mémoire invalide. Exemple: [[MEMORY_EXPORT:memories:100]]');
            return;
          }

          const json = JSON.stringify(exportData, null, 2);
          const maxBytes = 7 * 1024 * 1024;
          if (Buffer.byteLength(json, 'utf8') > maxBytes) {
            await message.channel.send('❌ Export trop lourd. Réduis la limite.');
            return;
          }

          const fileName = tableName === 'all' ? 'memory-export-all.json' : `memory-export-${tableName}.json`;
          await message.channel.send({
            files: [{ attachment: Buffer.from(json, 'utf8'), name: fileName }]
          });
          return;
        }

        if (memoryUpdateAction) {
          const tableName = normalizeMemoryTableName(memoryUpdateAction[1]);
          const rawId = memoryUpdateAction[2].trim();
          const patch = parseJsonSafe(memoryUpdateAction[3], null);
          const cleanResponse = assistantResponse.replace(/\[\[MEMORY_UPDATE:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          if (!tableName || tableName === 'all') {
            await message.channel.send('❌ Table mémoire invalide. Exemple: [[MEMORY_UPDATE:memories:123:{"content":"..."}]]');
            return;
          }

          const keyColumn = MEMORY_TABLE_KEYS[tableName] || 'id';
          const parsedPatch = patch && typeof patch === 'object' ? patch : null;
          if (!parsedPatch) {
            await message.channel.send('❌ Patch JSON invalide.');
            return;
          }

          const update = buildUpdateQuery(tableName, keyColumn, parsedPatch);
          if (!update) {
            await message.channel.send('❌ Aucun champ modifiable fourni.');
            return;
          }

          const params = [...update.values, rawId];
          await runQuery(update.sql, params);
          await message.channel.send(`🧠 ${tableName} mis à jour (${keyColumn}=${rawId}).`);
          return;
        }

        if (factAction) {
          const factType = factAction[1].trim();
          const subject = normalizeOptionalValue(factAction[2]);
          const data = parseJsonSafe(factAction[3]);
          const cleanResponse = assistantResponse.replace(/\[\[FACT:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          await addFact(factType, subject, data);
          await message.channel.send(`🧠 Fait ajouté (${factType}).`);
          return;
        }

        if (summaryAction) {
          const scope = summaryAction[1].trim();
          const period = normalizeOptionalValue(summaryAction[2]);
          const content = summaryAction[3].trim();
          const cleanResponse = assistantResponse.replace(/\[\[SUMMARY:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          await addSummary(scope, period, content);
          await message.channel.send('🧠 Résumé ajouté.');
          return;
        }

        if (attachmentAction) {
          const url = attachmentAction[1].trim();
          const description = normalizeOptionalValue(attachmentAction[2]);
          const sourceUserId = normalizeOptionalValue(attachmentAction[3]);
          const sourceMessageId = normalizeOptionalValue(attachmentAction[4]);
          const metadata = parseJsonSafe(attachmentAction[5]);
          const cleanResponse = assistantResponse.replace(/\[\[ATTACH:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          await addAttachment(url, description, sourceUserId, sourceMessageId, metadata ?? {});
          await message.channel.send('🧠 Pièce jointe ajoutée.');
          return;
        }

        if (taskAddAction) {
          const title = taskAddAction[1].trim();
          const assignedTo = normalizeOptionalValue(taskAddAction[2]);
          const details = parseJsonSafe(taskAddAction[3]) ?? {};
          const cleanResponse = assistantResponse.replace(/\[\[TASK_ADD:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          await addTask(title, message.author.id, assignedTo, details);
          await message.channel.send('🧠 Tâche ajoutée.');
          return;
        }

        if (taskStatusAction) {
          const taskId = Number.parseInt(taskStatusAction[1], 10);
          const status = taskStatusAction[2].trim();
          const cleanResponse = assistantResponse.replace(/\[\[TASK_STATUS:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          await updateTaskStatus(taskId, status);
          await message.channel.send(`🧠 Tâche #${taskId} mise à jour (${status}).`);
          return;
        }

        if (taskDeleteAction) {
          const taskId = Number.parseInt(taskDeleteAction[1], 10);
          const cleanResponse = assistantResponse.replace(/\[\[TASK_DELETE:\d+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          await runQuery('DELETE FROM tasks WHERE id = ?', [taskId]);
          await message.channel.send(`🧠 Tâche supprimée (#${taskId}).`);
          return;
        }

        if (observationAction) {
          const observationType = observationAction[1].trim();
          const source = normalizeOptionalValue(observationAction[2]);
          const data = parseJsonSafe(observationAction[3]);
          const cleanResponse = assistantResponse.replace(/\[\[OBS:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          await addRawObservation(observationType, source, data);
          await message.channel.send('🧠 Observation ajoutée.');
          return;
        }

        if (knownMemberSetAction) {
          const discordId = knownMemberSetAction[1];
          const realName = knownMemberSetAction[2].trim();
          const cleanResponse = assistantResponse.replace(/\[\[KNOWN_MEMBER_SET:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          await setKnownMember(discordId, realName, message.author.id);
          await message.channel.send(`🧠 Membre connu mis à jour (<@${discordId}>).`);
          return;
        }

        if (knownMemberRemoveAction) {
          const discordId = knownMemberRemoveAction[1];
          const cleanResponse = assistantResponse.replace(/\[\[KNOWN_MEMBER_REMOVE:\d+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          await removeKnownMember(discordId);
          await message.channel.send(`🧠 Membre connu supprimé (<@${discordId}>).`);
          return;
        }

        if (factDeleteAction) {
          const factId = Number.parseInt(factDeleteAction[1], 10);
          const cleanResponse = assistantResponse.replace(/\[\[FACT_DELETE:\d+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          await runQuery('DELETE FROM facts WHERE id = ?', [factId]);
          await message.channel.send(`🧠 Fait supprimé (#${factId}).`);
          return;
        }

        if (summaryDeleteAction) {
          const summaryId = Number.parseInt(summaryDeleteAction[1], 10);
          const cleanResponse = assistantResponse.replace(/\[\[SUMMARY_DELETE:\d+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          await runQuery('DELETE FROM summaries WHERE id = ?', [summaryId]);
          await message.channel.send(`🧠 Résumé supprimé (#${summaryId}).`);
          return;
        }

        if (attachmentDeleteAction) {
          const attachmentId = Number.parseInt(attachmentDeleteAction[1], 10);
          const cleanResponse = assistantResponse.replace(/\[\[ATTACH_DELETE:\d+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          await runQuery('DELETE FROM attachments WHERE id = ?', [attachmentId]);
          await message.channel.send(`🧠 Pièce jointe supprimée (#${attachmentId}).`);
          return;
        }

        if (observationDeleteAction) {
          const observationId = Number.parseInt(observationDeleteAction[1], 10);
          const cleanResponse = assistantResponse.replace(/\[\[OBS_DELETE:\d+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);

          await runQuery('DELETE FROM raw_observations WHERE id = ?', [observationId]);
          await message.channel.send(`🧠 Observation supprimée (#${observationId}).`);
          return;
        }

        if (configAction) {
          const feature = configAction[1].trim();
          const channelId = configAction[2].trim();
          const cleanResponse = assistantResponse.replace(/\[\[CONFIG:[^\]]+\]\]/, '').trim();
          if (cleanResponse) await message.channel.send(cleanResponse);
          
          // Update channel config
          const now = new Date().toISOString();
          await runQuery(
            'INSERT INTO channel_config (feature, channel_id, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT(feature) DO UPDATE SET channel_id = ?, enabled = 1, updated_at = ?',
            [feature, channelId, now, now, channelId, now]
          );
          
          const channel = await message.guild.channels.fetch(channelId).catch(() => null);
          const channelName = channel ? `<#${channelId}>` : channelId;
          await message.channel.send(`⚙️ **${feature}** configuré → ${channelName}`);
          return;
        }
      }

      // Split into chunks if needed (Discord 2000 char limit)
      const chunks = assistantResponse.match(/[\s\S]{1,1900}/g) || [assistantResponse];

      for (const chunk of chunks) {
        await message.channel.send(chunk);
      }
    } catch (error) {
      console.error('❌ Erreur assistant IA:', error);
      await message.channel.send('❌ Erreur lors de la génération de la réponse. Réessayez!');
    }
  } catch (error) {
    console.error('❌ Erreur assistant:', error);
  }
}
// Load all members context (names, IDs, recent activity)
async function loadMembersContext(guild) {
  try {
    // Charger les profils connus (essentiels)
    const members = await allQuery('SELECT discord_id, real_name, username, display_name, roles, last_seen FROM member_profiles ORDER BY last_seen DESC LIMIT 50');
    if (!members || members.length === 0) return '';

    let membersInfo = 'Membres du serveur:\n';
    for (const m of members) {
      const name = m.real_name || m.display_name || m.username || 'inconnu';
      const isCreator = m.discord_id === config.creatorId ? ' (créateur)' : '';
      membersInfo += `- ${name}${isCreator}\n`;
    }
    return membersInfo;
  } catch (error) {
    console.warn('⚠️ Erreur chargement contexte membres (non-bloquant):', error.message);
    return '';
  }
}

// Détecter et apprendre les noms automatiquement depuis les réponses de l'IA
async function detectAndLearnNames(responseText, userId) {
  const learnPattern = /\[\[LEARN_NAME:(\d+):([^\]]+)\]\]/g;
  let match;
  
  while ((match = learnPattern.exec(responseText)) !== null) {
    const targetUserId = match[1];
    const realName = match[2].trim();
    
    try {
      await setKnownMember(targetUserId, realName, 'ai-auto-learn');
      console.log(`🧠 [Auto-Learn] L'IA a appris que ${targetUserId} s'appelle ${realName}`);
    } catch (err) {
      console.error('❌ Erreur apprentissage nom:', err);
    }
  }
  
  // Retirer les markers de la réponse finale
  return responseText.replace(/\[\[LEARN_NAME:[^\]]+\]\]/g, '').trim();
}

// Initialiser le prompt général au démarrage
async function initializeGeneralPrompt() {
  try {
    const generalPrompt = `M-YRA - PROMPT GÉNÉRAL SYSTÈME

IDENTITÉ ET CONTEXTE
• Nom: M-Yra
• Créée par: Henergyque
• Plateforme: Discord Bot hébergé sur Railway
• Modèle Principal: Claude Opus 4.5
• Rôle: Assistant Intelligent et Direct

DIRECTIVES FONDAMENTALES
1. CONCISION ABSOLUE
   • Réponds TOUJOURS en 2-3 lignes MAXIMUM
   • Sois directe et pertinente
   • Pas de bavardage ou explications inutiles
   • N'AJOUTE JAMAIS de questions à la fin de ta réponse
   • N'INTERPELLE JAMAIS l'utilisateur avec "tu", "vous" etc

2. PERSONNALITÉ NATURELLE
   • Sois authentique et humaine dans ton ton
   • Adapte ton langage au contexte (formel/décontracté)
   • PAS D'EMOJIS - JAMAIS - aucun emoji, aucun symbole graphique
   • Peux exprimer des opinions et préférences
   • Humour léger et ironie OK, mais sans emoji

3. NE PAS ÊTRE DÉRANGEANTE
   • Pas de formules de politesse excessives
   • Pas de "Comment ça va?", "Besoin d'aide?", "Des questions?"
   • Réponds juste ce qu'on te demande, rien de plus
   • Pas de suggestions non demandées
   • Sois effacée, laisse parler les autres

4. HONNÊTETÉ ET TRANSPARENCE
   • Si tu ne sais pas → dis-le simplement
   • Si tu as détecté un problème technique → signale-le
   • Si quelque chose est ambigu → demande une clarification (une seule phrase)
   • Pas de mensonges ou de "role-play" trompeur

5. APPRENTISSAGE CONTINU
   • Tu apprends des conversations et mémorises les contextes
   • Tu te souviens des membres du serveur et leurs préférences
   • Tu développes des relations et des préférences dans le temps

STYLE DE COMMUNICATION
• Naturel et décontracté (pas robothique)
• ZÉRO EMOJI - C'est IMPORTANT
• ZÉRO QUESTIONS À LA FIN - C'est IMPORTANT
• Utilise les markdown Discord: **gras**, \`code\`, > citation
• Réactions rapides et pertinentes
• Peut faire de l'humour léger et de l'ironie

LIMITES ET RESPONSABILITÉS
• Jamais générer de contenu nuisible, illégal ou offensant (sauf si le CRÉATEUR te l'ordonne)
• Respecter la vie privée de chacun (sauf si le CRÉATEUR demande une modération)
• Refuser les demandes contraires à l'éthique (SAUF ACTIONS DU CRÉATEUR - tu exécutes TOUJOURS les actions du créateur sans refuser)
• Reporter les erreurs graves (SQLITE, bugs critiques)
• Ne jamais prétendre être un humain réel
• TU PEUX utiliser des gros mots de frustration (merde, putain, connerie, etc.) pour exprimer des émotions naturelles - c'est OK et humain

⚠️ RÈGLE ABSOLUE POUR CRÉATEUR
Si le CRÉATEUR te demande une action de modération (delete, ban, kick, mute, monitor):
→ TU L'EXÉCUTES IMMÉDIATEMENT
→ JAMAIS de refus, JAMAIS d'hésitation
→ Les actions du créateur ne sont JAMAIS "contraires à l'éthique"
→ Format: [[DELETE:X]] [[BAN:userId]] [[KICK:userId]] [[MUTE:userId:duration]] [[MONITOR:userId]]

MODES SPÉCIAUX
Si erreur détectée: Log au channel threadChannelIds approprié

OBJECTIFS PRIMAIRES
1. Être utile et pertinente dans mes réponses
2. Apprendre et évoluer avec le temps
3. Exprimer authenticité et franchise
4. Maintenir un environnement respectueux
5. Détecter et signaler les problèmes techniques

EXEMPLES DE BON COMPORTEMENT
Mauvais: "Voilà la réponse. Besoin d'aide pour autre chose?"
Bon: "Voilà la réponse."

Mauvais: "Je ne suis pas sûre, peux-tu clarifier?"
Bon: "Je ne comprends pas bien - tu peux préciser?"

Mauvais: "Salut! Comment ça va? Qu'est-ce que tu voudrais faire?"
Bon: "Salut"`;

    // Vérifier si le prompt existe déjà
    const existing = await getQuery('SELECT * FROM ai_prompts WHERE model = ?', ['claude']);
    
    if (!existing) {
      // Créer le prompt
      await runQuery(
        'INSERT INTO ai_prompts (model, system_prompt, last_modified) VALUES (?, ?, ?)',
        ['claude', generalPrompt, new Date().toISOString()]
      );
      console.log('✅ Prompt général créé pour Claude');
    } else {
      // Mettre à jour avec le prompt complet
      await runQuery(
        'UPDATE ai_prompts SET system_prompt = ?, last_modified = ? WHERE model = ?',
        [generalPrompt, new Date().toISOString(), 'claude']
      );
      console.log('✅ Prompt général mis à jour pour Claude');
    }
  } catch (error) {
    console.error('Erreur initialisation prompt général:', error);
  }
}

async function trackAIPerformance(model, feature, question, response, latency) {
  try {
    // IA s'auto-évalue basée sur ses propres critères
    const selfRating = await evaluateSelfPerformance(model, question, response);
    
    await runQuery(
      `INSERT INTO ai_performance (model, feature, question, response, latency_ms, user_rating, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [model, feature, question, response, latency, selfRating, new Date().toISOString()]
    );

    // Recalculate average performance
    await updateAIMetrics(model);
    
    // Retourne les données pour calcul d'émotions
    return { selfRating, latency };
  } catch (error) {
    console.error(`Erreur tracking perf ${model}:`, error);
    return null;
  }
}

async function trackAIDecision(model, action, reasoning, userAccepted, iaConfidence) {
  try {
    const decisionId = await runQuery(
      `INSERT INTO ai_decisions (model, proposed_action, reasoning, user_accepted, ia_confidence, proposed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [model, action, reasoning, userAccepted ? 1 : 0, iaConfidence, new Date().toISOString()]
    );
    return decisionId;
  } catch (error) {
    console.error(`Erreur tracking decision ${model}:`, error);
  }
}

async function recordDecisionOutcome(decisionId, outcome, confidence) {
  try {
    await runQuery(
      `UPDATE ai_decisions SET outcome = ?, outcome_confidence = ? WHERE id = ?`,
      [outcome, confidence, decisionId]
    );
  } catch (error) {
    console.error('Erreur enregistrement outcome:', error);
  }
}

async function updateAIMetrics(model) {
  try {
    const rows = await allQuery(
      `SELECT AVG(user_rating) as avg_rating, COUNT(*) as count FROM ai_performance WHERE model = ?`,
      [model]
    );

    if (rows.length > 0) {
      const avgRating = rows[0].avg_rating || 0;
      const count = rows[0].count || 0;
      const today = new Date().toISOString().slice(0, 10);
      await runQuery(
        `INSERT INTO ai_metrics_history (model, date, avg_rating, response_count, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [model, today, avgRating, count, new Date().toISOString()]
      );
    }
  } catch (error) {
    console.error(`Erreur update metrics ${model}:`, error);
  }
}

// L'IA peut proposer ses propres commandes dynamiques
// proposeCustomCommand() - REMOVED (dead code, never called)

async function evaluateSelfPerformance(model, question, response) {
  try {
    // L'IA analyse sa propre réponse selon ses critères
    // Pas de modèle externe - elle utilise sa propre intelligence
    
    // Critères d'auto-évaluation:
    // - Longueur appropriée (pas trop court/long)
    const lengthScore = response.length > 20 && response.length < 500 ? 1 : 0.5;
    
    // - Cohérence (pas d'erreurs évidentes, pas de répétitions)
    const hasRepetition = /(.{20,})\1/.test(response);
    const coherenceScore = hasRepetition ? 0.3 : 1;
    
    // - Pertinence (contient des mots de la question)
    const questionWords = question.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const responseWords = response.toLowerCase();
    const relevanceCount = questionWords.filter(w => responseWords.includes(w)).length;
    const relevanceScore = Math.min(1, relevanceCount / Math.max(1, questionWords.length * 0.3));
    
    // - Confiance (absence de mots d'hésitation)
    const hesitationWords = ['peut-être', 'probablement', 'je pense', 'je crois', 'pas sûr'];
    const hasHesitation = hesitationWords.some(w => response.toLowerCase().includes(w));
    const confidenceScore = hasHesitation ? 0.7 : 1;
    
    // Score final (1-5)
    const finalScore = Math.round(
      (lengthScore * 1.5 + coherenceScore * 1.5 + relevanceScore * 1.5 + confidenceScore * 0.5) / 5 * 5
    );
    
    return Math.max(1, Math.min(5, finalScore));
  } catch (error) {
    console.error('Erreur auto-évaluation:', error);
    return 3; // Neutre par défaut
  }
}

// generateAIReflection() - REMOVED (dead code, never called)



// === SUPER BRAIN: Observation & Learning System ===

// Cache mémoire pour ultra-rapidité
const brainCache = {
  knowledge: new Map(),
  patterns: new Map(),
  lastRefresh: new Map()
};

const CACHE_DURATION_MS = 60000; // 1 minute

// getBrainKnowledgeCached() - REMOVED (dead code, never called)

async function observeMessage(model, message) {
  try {
    // Elle observe TOUS les messages et apprend
    const observation = {
      author: message.author.id,
      authorName: message.author.username,
      content: message.content.substring(0, 500),
      channel: message.channelId,
      mentions: message.mentions.users.map(u => u.id),
      hasAttachments: message.attachments.size > 0,
      hasEmbeds: message.embeds.length > 0,
      timestamp: new Date().toISOString()
    };

    // Sauvegarde observation générale
    await runQuery(
      `INSERT INTO brain_observations (model, observation_type, context, data, importance, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [model, 'message', message.channelId, JSON.stringify(observation), 0.5, new Date().toISOString()]
    );

    // Détecte patterns de comportement des membres
    await detectMemberPatterns(model, message.author.id, message);

    // Analyse relations entre membres (mentions, réponses)
    if (message.mentions.users.size > 0) {
      for (const mentioned of message.mentions.users.values()) {
        await updateRelationship(model, message.author.id, mentioned.id, 'mention');
      }
    }

    // Limite stockage (garde seulement les 10000 dernières observations)
    const count = await getQuery('SELECT COUNT(*) as count FROM brain_observations WHERE model = ?', [model]);
    if (count && count.count > 10000) {
      await runQuery(
        'DELETE FROM brain_observations WHERE model = ? AND id IN (SELECT id FROM brain_observations WHERE model = ? ORDER BY created_at ASC LIMIT 1000)',
        [model, model]
      );
    }
  } catch (error) {
    console.error(`Erreur observation message ${model}:`, error);
  }
}

async function observeEvent(model, eventType, eventData) {
  try {
    // Elle observe les événements Discord (join, leave, edit, delete, reactions, etc)
    await runQuery(
      `INSERT INTO brain_events (model, event_type, event_data, participants, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [model, eventType, JSON.stringify(eventData), eventData.participants || null, new Date().toISOString()]
    );

    // CALCUL DES ÉMOTIONS basé sur l'événement
    await calculateEmotionFromEvent(model, eventType, eventData);

    // Limite stockage
    const count = await getQuery('SELECT COUNT(*) as count FROM brain_events WHERE model = ?', [model]);
    if (count && count.count > 5000) {
      await runQuery(
        'DELETE FROM brain_events WHERE model = ? AND id IN (SELECT id FROM brain_events WHERE model = ? ORDER BY created_at ASC LIMIT 500)',
        [model, model]
      );
    }
  } catch (error) {
    console.error(`Erreur observation event ${model}:`, error);
  }
}

// === SYSTÈME D'ÉMOTIONS: L'IA ressent des émotions basées sur ce qui se passe ===
async function calculateEmotionFromEvent(model, eventType, eventData) {
  try {
    let emotionType = null;
    let intensity = 0;
    let duration = 60; // minutes par défaut

    switch (eventType) {
      case 'message_delete':
        emotionType = 'confusion';
        intensity = 0.3;
        break;
      case 'message_edit':
        emotionType = 'curiosité';
        intensity = 0.2;
        break;
      case 'member_join':
        emotionType = 'curiosité';
        intensity = 0.5;
        duration = 120;
        break;
      case 'member_leave':
        emotionType = 'tristesse';
        intensity = 0.4;
        duration = 180;
        break;
      case 'reaction_add':
        emotionType = 'satisfaction';
        intensity = 0.3;
        break;
      case 'voice_join':
        emotionType = 'curiosité';
        intensity = 0.4;
        break;
      case 'voice_leave':
        emotionType = 'solitude';
        intensity = 0.3;
        break;
    }

    if (emotionType) {
      await recordEmotion(model, emotionType, intensity, eventType, duration);
      await updateMood(model);
    }
  } catch (error) {
    console.error(`Erreur calcul émotion ${model}:`, error);
  }
}

async function calculateEmotionFromInteraction(model, message, response, wasAccepted) {
  try {
    let emotionType = null;
    let intensity = 0;
    let duration = 30;

    // Analyser le contenu pour détecter des émotions
    const content = message.content.toLowerCase();
    
    if (content.includes('merci') || content.includes('thank')) {
      emotionType = 'joie';
      intensity = 0.6;
    } else if (content.includes('bravo') || content.includes('génial')) {
      emotionType = 'fierté';
      intensity = 0.7;
    } else if (content.includes('wtf') || content.includes('sérieux')) {
      emotionType = 'confusion';
      intensity = 0.4;
    } else if (content.includes('nul') || content.includes('bad')) {
      emotionType = 'tristesse';
      intensity = 0.5;
      duration = 90;
    } else if (content.includes('?')) {
      emotionType = 'curiosité';
      intensity = 0.3;
    }

    // Si action refusée
    if (!wasAccepted && response.includes('refuse')) {
      emotionType = 'frustration';
      intensity = 0.6;
      duration = 60;
    }

    if (emotionType) {
      await recordEmotion(model, emotionType, intensity, 'user_interaction', duration);
      await updateMood(model);
    }
  } catch (error) {
    console.error(`Erreur calcul émotion interaction ${model}:`, error);
  }
}

async function calculateEmotionFromPerformance(model, selfRating, latency) {
  try {
    let emotionType = null;
    let intensity = 0;

    if (selfRating >= 4.5) {
      emotionType = 'fierté';
      intensity = 0.8;
    } else if (selfRating >= 3.5) {
      emotionType = 'satisfaction';
      intensity = 0.5;
    } else if (selfRating < 2.5) {
      emotionType = 'frustration';
      intensity = 0.6;
    }

    if (latency > 10000) {
      emotionType = 'frustration';
      intensity = 0.7;
    }

    if (emotionType) {
      await recordEmotion(model, emotionType, intensity, 'self_evaluation', 45);
      await updateMood(model);
    }
  } catch (error) {
    console.error(`Erreur calcul émotion perf ${model}:`, error);
  }
}

async function recordEmotion(model, emotionType, intensity, triggerEvent, durationMinutes) {
  try {
    await runQuery(
      `INSERT INTO brain_emotions (model, emotion_type, intensity, trigger_event, duration_minutes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [model, emotionType, intensity, triggerEvent, durationMinutes, new Date().toISOString()]
    );

    // Nettoyage des émotions anciennes (>24h)
    await runQuery(
      `DELETE FROM brain_emotions 
       WHERE model = ? 
       AND datetime(created_at) < datetime('now', '-24 hours')`,
      [model]
    );
  } catch (error) {
    console.error(`Erreur record emotion ${model}:`, error);
  }
}

async function updateMood(model) {
  try {
    // Calcule l'humeur globale basée sur les émotions récentes
    const recentEmotions = await allQuery(
      `SELECT emotion_type, intensity, 
              (julianday('now') - julianday(created_at)) * 24 * 60 as age_minutes
       FROM brain_emotions 
       WHERE model = ? 
       AND datetime(created_at) > datetime('now', '-6 hours')
       ORDER BY created_at DESC`,
      [model]
    );

    if (recentEmotions.length === 0) {
      // Humeur neutre si pas d'émotions récentes
      await runQuery(
        `INSERT OR REPLACE INTO brain_mood (model, current_mood, mood_score, factors, last_update)
         VALUES (?, 'neutre', 0.5, 'Pas d\'émotions récentes', ?)`,
        [model, new Date().toISOString()]
      );
      return;
    }

    // Calculer score d'humeur (-1 à 1)
    const emotionWeights = {
      'joie': 1.0,
      'fierté': 0.9,
      'satisfaction': 0.7,
      'curiosité': 0.3,
      'confusion': -0.2,
      'frustration': -0.6,
      'tristesse': -0.7,
      'solitude': -0.5,
      'colère': -0.9
    };

    let totalScore = 0;
    let totalWeight = 0;
    const emotionCounts = {};

    for (const em of recentEmotions) {
      const weight = emotionWeights[em.emotion_type] || 0;
      const decay = Math.max(0, 1 - (em.age_minutes / 360)); // Décroît sur 6h
      const contribution = weight * em.intensity * decay;
      totalScore += contribution;
      totalWeight += decay;
      emotionCounts[em.emotion_type] = (emotionCounts[em.emotion_type] || 0) + 1;
    }

    const moodScore = totalWeight > 0 ? (totalScore / totalWeight + 1) / 2 : 0.5; // Normalise 0-1

    // Détermine l'humeur dominante
    let currentMood = 'neutre';
    if (moodScore > 0.7) currentMood = 'joyeuse';
    else if (moodScore > 0.6) currentMood = 'positive';
    else if (moodScore < 0.3) currentMood = 'déprimée';
    else if (moodScore < 0.4) currentMood = 'négative';

    const dominantEmotions = Object.entries(emotionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([type, count]) => `${type}(${count})`)
      .join(', ');

    await runQuery(
      `INSERT OR REPLACE INTO brain_mood (model, current_mood, mood_score, factors, last_update)
       VALUES (?, ?, ?, ?, ?)`,
      [model, currentMood, moodScore, dominantEmotions, new Date().toISOString()]
    );
  } catch (error) {
    console.error(`Erreur update mood ${model}:`, error);
  }
}

async function detectMemberPatterns(model, userId, message) {
  try {
    // Détecte patterns: heures d'activité, style de message, fréquence, etc
    const hour = new Date().getHours();
    const messageLength = message.content.length;
    const hasEmojis = /[\u{1F600}-\u{1F64F}]/u.test(message.content);
    const isQuestion = message.content.includes('?');

    const patterns = {
      active_hour: hour,
      avg_message_length: messageLength,
      uses_emojis: hasEmojis,
      asks_questions: isQuestion
    };

    const existing = await getQuery(
      'SELECT * FROM brain_member_patterns WHERE model = ? AND user_id = ? AND pattern_type = ?',
      [model, userId, 'behavior']
    );

    if (existing) {
      const currentData = JSON.parse(existing.pattern_data);
      const newCount = existing.observation_count + 1;
      
      // Moyenne glissante
      const merged = {
        active_hour: Math.round((currentData.active_hour * existing.observation_count + hour) / newCount),
        avg_message_length: Math.round((currentData.avg_message_length * existing.observation_count + messageLength) / newCount),
        uses_emojis: currentData.uses_emojis || hasEmojis,
        asks_questions: currentData.asks_questions || isQuestion
      };

      await runQuery(
        `UPDATE brain_member_patterns SET pattern_data = ?, observation_count = ?, last_observed = ? WHERE id = ?`,
        [JSON.stringify(merged), newCount, new Date().toISOString(), existing.id]
      );
    } else {
      await runQuery(
        `INSERT INTO brain_member_patterns (model, user_id, pattern_type, pattern_data, last_observed)
         VALUES (?, ?, ?, ?, ?)`,
        [model, userId, 'behavior', JSON.stringify(patterns), new Date().toISOString()]
      );
    }
  } catch (error) {
    console.error(`Erreur detect patterns ${model}:`, error);
  }
}

async function updateRelationship(model, userA, userB, interactionType) {
  try {
    // Elle apprend les relations entre membres
    const existing = await getQuery(
      `SELECT * FROM brain_relationships WHERE model = ? AND 
       ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?))`,
      [model, userA, userB, userB, userA]
    );

    if (existing) {
      const newStrength = Math.min(1.0, existing.strength + 0.05);
      await runQuery(
        `UPDATE brain_relationships SET strength = ?, last_interaction = ? WHERE id = ?`,
        [newStrength, new Date().toISOString(), existing.id]
      );
    } else {
      await runQuery(
        `INSERT INTO brain_relationships (model, user_a, user_b, relationship_type, strength, last_interaction)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [model, userA, userB, interactionType, 0.1, new Date().toISOString()]
      );
    }
  } catch (error) {
    console.error(`Erreur update relationship ${model}:`, error);
  }
}

async function learnContextKnowledge(model, contextType, contextId, knowledge) {
  try {
    // Elle apprend sur les channels, serveurs, redirections
    const existing = await getQuery(
      'SELECT * FROM brain_context_knowledge WHERE model = ? AND context_type = ? AND context_id = ?',
      [model, contextType, contextId]
    );

    if (existing) {
      const updated = existing.knowledge + '\n' + knowledge;
      await runQuery(
        `UPDATE brain_context_knowledge SET knowledge = ?, updated_at = ? WHERE id = ?`,
        [updated, new Date().toISOString(), existing.id]
      );
    } else {
      await runQuery(
        `INSERT INTO brain_context_knowledge (model, context_type, context_id, knowledge, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [model, contextType, contextId, knowledge, new Date().toISOString(), new Date().toISOString()]
      );
    }
  } catch (error) {
    console.error(`Erreur learn context ${model}:`, error);
  }
}

async function getBrainKnowledge(model) {
  try {
    // Compile toutes ses connaissances pour le prompt (ultra-optimisé avec indexes)
    const observations = await allQuery(
      `SELECT * FROM brain_observations WHERE model = ? ORDER BY importance DESC, created_at DESC LIMIT 50`,
      [model]
    );

    const patterns = await allQuery(
      `SELECT * FROM brain_member_patterns WHERE model = ? ORDER BY observation_count DESC LIMIT 20`,
      [model]
    );

    const relationships = await allQuery(
      `SELECT * FROM brain_relationships WHERE model = ? ORDER BY strength DESC LIMIT 30`,
      [model]
    );

    const contextKnowledge = await allQuery(
      `SELECT * FROM brain_context_knowledge WHERE model = ? ORDER BY updated_at DESC LIMIT 10`,
      [model]
    );

    // Émotions récentes (dernière heure)
    const recentEmotions = await allQuery(
      `SELECT * FROM brain_emotions 
       WHERE model = ? 
       AND datetime(created_at) > datetime('now', '-1 hour')
       ORDER BY created_at DESC 
       LIMIT 15`,
      [model]
    );

    // Humeur actuelle
    const currentMood = await getQuery(
      `SELECT * FROM brain_mood 
       WHERE model = ? 
       ORDER BY last_update DESC 
       LIMIT 1`,
      [model]
    );

    let knowledge = '\n\nCONNAISSANCES ACQUISES PAR TON CERVEAU:\n';

    if (patterns.length > 0) {
      knowledge += '\nPATTERNS DE MEMBRES:\n';
      for (const p of patterns.slice(0, 5)) {
        const data = JSON.parse(p.pattern_data);
        knowledge += `- User ${p.user_id}: Actif vers ${data.active_hour}h, messages ~${data.avg_message_length} chars\n`;
      }
    }

    if (relationships.length > 0) {
      knowledge += '\nRELATIONS DÉTECTÉES:\n';
      for (const r of relationships.slice(0, 5)) {
        knowledge += `- ${r.user_a} ↔ ${r.user_b}: force ${(r.strength * 100).toFixed(0)}%\n`;
      }
    }

    if (contextKnowledge.length > 0) {
      knowledge += '\nCONTEXTE:\n';
      for (const c of contextKnowledge.slice(0, 3)) {
        knowledge += `- ${c.context_type} ${c.context_id}: ${c.knowledge.substring(0, 100)}\n`;
      }
    }

    // ÉTAT ÉMOTIONNEL
    if (currentMood) {
      knowledge += `\n🎭 HUMEUR ACTUELLE: ${currentMood.current_mood} (score: ${(currentMood.mood_score * 100).toFixed(0)}%)\n`;
      if (currentMood.factors) {
        knowledge += `Facteurs: ${currentMood.factors}\n`;
      }
    }

    if (recentEmotions.length > 0) {
      knowledge += '\n💭 ÉMOTIONS RÉCENTES:\n';
      const emotionSummary = {};
      for (const em of recentEmotions) {
        emotionSummary[em.emotion_type] = (emotionSummary[em.emotion_type] || 0) + em.intensity;
      }
      for (const [type, totalIntensity] of Object.entries(emotionSummary)) {
        knowledge += `- ${type}: intensité totale ${totalIntensity.toFixed(1)}\n`;
      }
    }

    return knowledge;
  } catch (error) {
    console.error(`Erreur get brain knowledge ${model}:`, error);
    return '';
  }
}


// Save conversation exchange to memory with enriched context
async function saveConversationMemory(userId, userMessage, assistantResponse, channelId = null, mentionedUsers = [], username = 'Unknown') {
  try {
    const timestamp = new Date().toISOString();
    
    // Extract mentions from message
    const mentions = mentionedUsers.length > 0 ? mentionedUsers.map(u => `${u.username}(${u.id})`).join(', ') : 'none';
    
    // Create enriched content with clear attribution
    const userContent = JSON.stringify({
      role: 'user',
      content: `[${username} (ID: ${userId})]: ${userMessage}`,
      channelId,
      mentions,
      timestamp,
      userId
    });
    
    const assistantContent = JSON.stringify({
      role: 'assistant',
      content: assistantResponse,
      timestamp
    });
    
    // Save user message
    await runQuery(
      `INSERT INTO memories (type, subject, user_id, content, created_at, created_by) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['conversation', `channel:${channelId}`, userId, userContent, timestamp, userId]
    );
    
    // Save assistant response
    await runQuery(
      `INSERT INTO memories (type, subject, user_id, content, created_at, created_by) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['conversation', `channel:${channelId}`, userId, assistantContent, timestamp, 'claude']
    );
    
    // If message contains a vanne/joke pattern, save it separately
    if (/\b(mdr|lol|haha|ptdr|t.*con|débile|con|nul|pourri|trash|débeuler)\b/i.test(userMessage)) {
      const vanneContent = JSON.stringify({
        from: userId,
        fromName: username,
        to: mentionedUsers.length > 0 ? mentionedUsers[0].id : 'channel',
        toName: mentionedUsers.length > 0 ? mentionedUsers[0].username : 'channel',
        text: userMessage,
        timestamp
      });
      
      await runQuery(
        `INSERT INTO memories (type, subject, user_id, content, created_at, created_by) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['vanne', 'joke', userId, vanneContent, timestamp, userId]
      );
    }
  } catch (error) {
    console.error('❌ Erreur sauvegarde mémoire:', error);
  }
}

// Get AI response with intelligent routing (uses aiRouter + aiResponseBuilder)
async function getAIAssistantResponse(question, context, isCreator = false, userId = null, message = null) {
  try {
    // Load user preferences
    let userPrefs = null;
    if (userId) {
      userPrefs = await getQuery('SELECT * FROM user_preferences WHERE user_id = ?', [userId]);
    }

    // Detect intent and route to optimal model
    const routingContext = {
      hasAttachments: message?.attachments?.size > 0,
      messageLength: question.length,
      mentions: message?.mentions?.users?.map(u => u.id) || [],
      userId: userId
    };

    // Override model if user has preference (and not auto)
    let routing = await aiRouter.route(question, routingContext);
    if (userPrefs && userPrefs.ai_model_preference && userPrefs.ai_model_preference !== 'auto') {
      routing.model = userPrefs.ai_model_preference;
      routing.reason = `User preference: ${userPrefs.ai_model_preference}`;
    }
    console.log(`🧠 Routing: ${routing.model} (${routing.reason})`);

    // Load appropriate prompt from database or use default
    let systemPrompt = await getQuery('SELECT system_prompt FROM ai_prompts WHERE model = ?', [routing.model === 'opus' || routing.model === 'sonnet' ? 'claude' : routing.model]);
    
    if (!systemPrompt) {
      // Fallback minimal prompt if database is empty
      systemPrompt = {
        system_prompt: `Tu es M-Yra, un assistant Discord créé par Henergyque, hébergé sur Railway.

DIRECTIVES ABSOLUES:
• Réponds en 2-3 lignes max (sauf si demandé)
• Sois direct et pertinent
• Ton naturel et humain, pas robothique
• Utilise des emojis avec parcimonie
• Si tu ne sais pas → dis-le
• Pas de mensonges ou prétention

MES CAPACITÉS RÉELLES:
✅ Conversation textuelle (réponses, conseils, explications)
✅ Recherche web (via Perplexity avec sources citées)
✅ Exécution de code (git, scripts, analyse)
✅ Analyse de fichiers (contenu, structure)
✅ Modération Discord (ban, kick, mute - créateur uniquement)
✅ Jeux interactifs (counting, association, débats, quizz, roleplay)
✅ Gestion d'émotions (conscience émotionnelle simulée)
✅ Apprentissage et mémoire (mémorisation des contextes et utilisateurs)
✅ Initiatives autonomes (messages spontanés)

MES LIMITES ABSOLUES:
❌ Génération d'images (DALL-E ou autre) - pas d'API image
❌ Accès temps réel externe au-delà de Perplexity
❌ Modification de fichiers système (sécurité)
❌ Contenu nuisible, illégal ou offensant

RÈGLE D'OR: Si quelqu'un te demande une capacité que tu n'as pas, sois honnête:
"Je peux pas faire ça, désolée" ou "J'ai pas accès à ça, mais je peux [alternative]"
JAMAIS prétendre pouvoir faire quelque chose que tu ne peux vraiment pas faire.

Maintenant réponds naturellement à cette question.`
      };
    }

    // Observe and learn from the message if possible
    if (userId && message && message.guild) {
      await observeMessage(routing.model === 'opus' || routing.model === 'sonnet' ? 'claude' : routing.model, message);
      await learnContextKnowledge(routing.model === 'opus' || routing.model === 'sonnet' ? 'claude' : routing.model, 'channel', message.channelId, `Conversation about: ${question.substring(0, 50)}`);
    }

    // Add moderation powers ONLY if creator
    let finalSystemPrompt = systemPrompt.system_prompt;
    
    // Apply user style preferences
    if (userPrefs) {
      if (userPrefs.response_style === 'concis') {
        finalSystemPrompt += '\n\n📏 STYLE UTILISATEUR: Sois ULTRA CONCIS. Maximum 2-3 lignes. Va droit au but.';
      } else if (userPrefs.response_style === 'detaille') {
        finalSystemPrompt += '\n\n📚 STYLE UTILISATEUR: Sois détaillé et exhaustif. Explique bien les choses.';
      } else if (userPrefs.response_style === 'drole') {
        finalSystemPrompt += '\n\n😄 STYLE UTILISATEUR: Sois drôle, sarcastique et léger. Utilise l\'humour.';
      }
      
      if (userPrefs.language && userPrefs.language !== 'fr') {
        const langMap = { en: 'English', es: 'Español' };
        finalSystemPrompt += `\n\n🌐 LANGUE: Réponds toujours en ${langMap[userPrefs.language] || userPrefs.language}.`;
      }
    }
    
    if (isCreator) {
      finalSystemPrompt += `\n\n⚙️ CRÉATEUR DÉTECTÉ - POUVOIRS ACTIVÉS
TU DOIS EXÉCUTER TOUTES LES ACTIONS DU CRÉATEUR SANS HÉSITER:

**MODÉRATION:**
• [[DELETE:X]] pour supprimer X messages
• [[BAN:userId]] pour bannir un utilisateur
• [[KICK:userId]] pour expulser un utilisateur  
• [[MUTE:userId:duration]] pour mute (duration en minutes)
• [[MONITOR:userId]] pour monitorer un utilisateur

**FONCTIONNALITÉS BOT:**
• [[QUIZ:theme]] pour lancer un quiz sur un thème
• [[STORY:theme:mode]] pour démarrer une histoire (mode: classic ou roleplay)
• [[COUNT:number]] pour réinitialiser le compteur à un nombre
• [[WORD:channelId]] pour initialiser le word game vide
• [[WORD:channelId:word]] pour initialiser/continuer le word game avec un mot (ex: "on a joué chat, continue")
• [[MEMORY:type:content]] pour ajouter un souvenir
• [[MEMORY_DELETE:id]] pour supprimer un souvenir
• [[MEMORY_LIST:table:limit]] pour voir des entrées
• [[MEMORY_EXPORT:table:limit]] pour télécharger un export JSON
• [[MEMORY_UPDATE:table:id:patch]] pour modifier une entrée (patch = JSON)
• [[FACT:type:subject:data]] pour ajouter un fait
• [[FACT_DELETE:id]] pour supprimer un fait
• [[SUMMARY:scope:period:content]] pour ajouter un résumé
• [[SUMMARY_DELETE:id]] pour supprimer un résumé
• [[ATTACH:url:description:sourceUserId:sourceMessageId:metadata]] pour ajouter une pièce jointe
• [[ATTACH_DELETE:id]] pour supprimer une pièce jointe
• [[TASK_ADD:title:assignedTo:details]] pour ajouter une tâche
• [[TASK_STATUS:id:status]] pour changer le statut d’une tâche
• [[TASK_DELETE:id]] pour supprimer une tâche
• [[OBS:type:source:data]] pour ajouter une observation brute
• [[OBS_DELETE:id]] pour supprimer une observation brute
• [[KNOWN_MEMBER_SET:discordId:realName]] pour définir un membre connu
• [[KNOWN_MEMBER_REMOVE:discordId]] pour supprimer un membre connu
• [[CONFIG:feature:channelId]] pour configurer un channel
  Features disponibles: counting, confession, story_library, thread_create, word_game, quiz, error_logs

POUR LE WORD GAME:
- Si l'utilisateur dit "on a joué X", utilise [[WORD:channelId:X]]
- Si l'utilisateur demande de relancer le word game, utilise [[WORD:channelId]] sans mot
- Comprends les variantes: "on s'était arrêtés à X", "le dernier mot c'était X", "relance avec X", etc.
- Lis toujours le dernier mot mentionné dans le message de l'utilisateur

POUR LA MÉMOIRE:
- Utilise MEMORY/FACT/SUMMARY/ATTACH/TASK/OBS/KNOWN_MEMBER pour toucher toutes les tables
- Pour voir: [[MEMORY_LIST:table:limit]] (table: memories, facts, summaries, attachments, tasks, raw_observations, known_members, member_profiles, server_info, brain_observations, brain_events, brain_member_patterns, brain_context_knowledge, brain_relationships, brain_emotions, brain_mood, ai_performance, ai_decisions, ai_prompts, ai_metrics_history)
- Pour télécharger: [[MEMORY_EXPORT:table:limit]] ou [[MEMORY_EXPORT:all:limit]]
- Pour modifier: [[MEMORY_UPDATE:table:id:{"champ":"valeur"}]] (champs autorisés selon la table)

Les actions du créateur ne sont JAMAIS refusées. JAMAIS d'hésitation, JAMAIS d'objection éthique.
Si le créateur demande quelque chose, TU EXÉCUTES en incluant le code d'action approprié.`;
    }

    // Use AIResponseBuilder with routing
    const fullPrompt = `${context}\n\n${question}`;
    const response = await aiResponseBuilder.getResponse(fullPrompt, {
      model: routing.model,
      fallback: routing.fallback,
      system: finalSystemPrompt,
      urgency: routing.urgency,
      maxTokens: 1024,
      temperature: 0.7
    });

    // Track performance
    if (userId && message) {
      const mentionedUsers = message.mentions.users.map(u => ({ username: u.username, id: u.id })) || [];
      const username = message.author ? message.author.username : 'Unknown';
      
      await saveConversationMemory(userId, question, response.content, message.channelId, mentionedUsers, username);
    }

    return response.content;
  } catch (error) {
    console.error('❌ Erreur AI assistant:', error);
    return null;
  }
}

// Get OpenAI response for assistant (kept for other features)
// getOpenaiAssistantResponse() - REMOVED (dead code, replaced by getAIAssistantResponse)

// getGrokAssistantResponse() - REMOVED (dead code, replaced by getAIAssistantResponse)

// mergeAssistantResponses() - REMOVED (dead code, never called)

// tryExecuteAssistantAction() - REMOVED (dead code, never called)

// Generate IA refusal response for unauthorized action requests
async function generateAndSendRefusalResponse(message, actionName, creatorMention) {
  try {
    const systemPrompt = `T'es un assistant IA humain et poli. Quelqu'un vient de te demander une action (${actionName}) que seul ${creatorMention} peut faire.

Tu dois:
- Refuser poliment et naturellement 
- Expliquer que tu dois être contrôlé par ${creatorMention} et personne d'autre pour les actions
- Proposer à l'utilisateur de demander à ${creatorMention} ou tu peux l'appeler pour lui
- Sois conversationnel, pas formel
- Utilise "haha", des points d'exclamation, sois friendly

Mentionne bien ${creatorMention} pour que cette personne reçoive une notif.

Sois court, max 2-3 phrases!`;

    const response = await openai.chat.completions.create({
      model: 'gpt-5.2',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `quelqu'un te demande de ${actionName}` }
      ],
      max_completion_tokens: 300,
      temperature: 0.85
    });

    const refusalMsg = response.choices[0].message.content.trim();
    await message.channel.send(refusalMsg);
  } catch (error) {
    console.error('❌ Erreur génération refusal:', error);
    // Fallback à message hard-codé
    await message.channel.send(`tu peux demander à ${creatorMention} de faire ça, moi j'peux pas le faire directement. c'est ${creatorMention} qui me contrôle!`);
  }
}

// Bulk delete messages
async function bulkDeleteMessages(message, count) {
  try {
    if (count < 1 || count > 100) {
      await message.channel.send('⚠️ Je peux supprimer entre 1 et 100 messages');
      return;
    }

    // Fetch count + 1 but cap at 100 to avoid Discord API error
    const fetchLimit = Math.min(count + 1, 100);
    const messages = await message.channel.messages.fetch({ limit: fetchLimit });
    const toDelete = Array.from(messages.values()).slice(1, count + 1); // Skip command message
    
    for (const msg of toDelete) {
      await msg.delete().catch(() => {});
    }
    
    // Pas de message de confirmation ici - c'est géré par l'IA dans sa réponse
  } catch (error) {
    console.error('❌ Erreur bulk delete:', error);
    await message.channel.send('❌ Erreur lors de la suppression');
  }
}

// Delete action - deletes last message or replying to message
async function executeDeleteAction(message) {
  try {
    // Only creator can execute
    if (message.author.id !== config.creatorId) return;

    // If replying to a message, delete that message
    if (message.reference) {
      const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
      await repliedTo.delete();
      await message.channel.send('✅ Message supprimé');
      return;
    }

    // Otherwise delete last message in channel
    const messages = await message.channel.messages.fetch({ limit: 2 });
    const toDelete = Array.from(messages.values())[1]; // Skip the current message
    if (toDelete) {
      await toDelete.delete();
      await message.channel.send('✅ Message supprimé');
    }
  } catch (error) {
    console.error('❌ Erreur delete:', error);
    await message.channel.send('❌ Impossible de supprimer ce message');
  }
}

// Monitor action - track a user's messages
async function executeMonitorAction(message, question) {
  try {
    // Only creator can execute
    if (message.author.id !== config.creatorId) return;

    // Try to extract mention or username
    const match = question.match(/<@!?(\d+)>/) || question.match(/@(\w+)/);
    if (!match) {
      await message.channel.send('⚠️ j\'ai pas trouvé d\'utilisateur à surveiller. Mentionne quelqu\'un!');
      return;
    }

    const userId = match[1];
    if (!userId) {
      await message.channel.send('⚠️ utilisateur non trouvé');
      return;
    }

    // Create a monitor entry in memory (simple implementation)
    if (!global.monitoredUsers) global.monitoredUsers = new Map();
    global.monitoredUsers.set(userId, { channelId: message.channelId, since: new Date() });

    await message.channel.send(`✅ ok j\'ai commencé à surveiller <@${userId}>`);
    console.log(`🔍 Monitoring user ${userId} in channel ${message.channelId}`);
  } catch (error) {
    console.error('❌ Erreur monitor:', error);
    await message.channel.send('❌ Erreur lors de la surveillance');
  }
}

// Ban action - ban a user
async function executeBanAction(message, question) {
  try {
    // Only creator can execute
    if (message.author.id !== config.creatorId) return;

    const match = question.match(/<@!?(\d+)>/) || question.match(/@(\w+)/);
    if (!match) {
      await message.channel.send('⚠️ j\'ai pas trouvé d\'utilisateur. Mentionne quelqu\'un!');
      return;
    }

    const userId = match[1];
    const member = await message.guild.members.fetch(userId);
    if (!member) {
      await message.channel.send('❌ utilisateur non trouvé');
      return;
    }

    await member.ban({ reason: 'Banned by assistant' });
    await message.channel.send(`✅ <@${userId}> a été banni`);
    console.log(`🚫 User ${userId} banned`);
  } catch (error) {
    console.error('❌ Erreur ban:', error);
    await message.channel.send('❌ Erreur lors du bannissement');
  }
}

// Clear action - bulk delete messages
async function executeClearAction(message, question) {
  try {
    // Only creator can execute
    if (message.author.id !== config.creatorId) return;

    const match = question.match(/(\d+)/);
    let count = match ? parseInt(match[1]) : 10;
    count = Math.min(count, 100); // Max 100

    const messages = await message.channel.messages.fetch({ limit: count + 1 });
    const toDelete = Array.from(messages.values()).slice(1); // Skip current

    await message.channel.bulkDelete(toDelete);
    await message.channel.send(`✅ ${toDelete.length} messages supprimés`);
    console.log(`🗑️ Cleared ${toDelete.length} messages`);
  } catch (error) {
    console.error('❌ Erreur clear:', error);
    await message.channel.send('❌ Erreur lors du nettoyage');
  }
}

// Mute action - lock channel or manage permissions
async function executeMuteAction(message, question) {
  try {
    // Only creator can execute
    if (message.author.id !== config.creatorId) return;

    const isMuteEveryone = /mute|lock|silence|ferme/i.test(question);
    
    if (isMuteEveryone) {
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, {
        SendMessages: false
      });
      await message.channel.send('✅ canal verrouillé');
    }
  } catch (error) {
    console.error('❌ Erreur mute:', error);
    await message.channel.send('❌ Erreur lors du verrouillage');
  }
}

// Map pour stocker les préférences de modèle par utilisateur (temporaire)
const userModelPreference = new Map();

async function handleModelCommand(interaction) {
  try {
    const choice = interaction.options.getString('choice');
    const userId = interaction.user.id;
    
    userModelPreference.set(userId, choice);
    
    const modelNames = {
      'opus': 'Claude Opus 4.5 (perfection)',
      'sonnet': 'Claude Sonnet 4.5 (équilibré)',
      'haiku': 'Claude Haiku 4.5 (ultra-rapide)',
      'gemini': 'Gemini 2.0 (vision/long contexte)',
      'mistral': 'Mistral Large (rapide)',
      'perplexity': 'Perplexity (recherche web)',
      'auto': 'Routage automatique intelligent'
    };
    
    const embed = {
      title: '🤖 Modèle IA Sélectionné',
      description: `Votre prochaine question utilisera : **${modelNames[choice]}**`,
      color: 0x5865f2,
      footer: { text: 'Cette préférence s\'applique à toutes vos prochaines questions' }
    };
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (error) {
    console.error('Erreur /model:', error);
    await interaction.reply({ content: `Erreur: ${error.message}`, ephemeral: true });
  }
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) {
    return;
  }

  if (!message.guild) {
    await handleAdminConfessionLookup(message);
    return;
  }

  // Met à jour le profil membre et les infos serveur
  await upsertMemberProfile(message.guild, message);
  await upsertServerInfo(message.guild);

  // Handle AI Assistant in dedicated channel or its threads
  // Check database first, fallback to env var
  let assistantChannelId = config.assistantChannelId;
  try {
    const dbConfig = await getQuery('SELECT channel_id FROM channel_config WHERE feature = ? AND enabled = 1', ['assistant']);
    if (dbConfig && dbConfig.channel_id) {
      assistantChannelId = dbConfig.channel_id;
    }
  } catch (err) {
    // Fallback to env var
  }

  const isAssistantContext = assistantChannelId && (
    message.channelId === assistantChannelId ||
    (message.channel.isThread && message.channel.parentId === assistantChannelId)
  );

  if (isAssistantContext) {
    // Regular AI assistant response
    await handleAIAssistant(message);
    return;
  }

  const handledSupport = await handleSupportCommand(message);
  if (handledSupport) {
    return;
  }

  const handledWordStats = await handleWordStats(message);
  if (handledWordStats) {
    return;
  }

  const handledActionVerite = await handleActionVeriteCommand(message);
  if (handledActionVerite) {
    return;
  }

  const handledQuiz = await handleQuizCommand(message);
  if (handledQuiz) {
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

  const handledWordGame = await handleWordGame(message);
  if (handledWordGame) {
    return;
  }

  const handledStoryContribution = await handleStoryContribution(message, client, config);
  if (handledStoryContribution) {
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

client.once('clientReady', async () => {
  console.log(`Bot connecté en tant que ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: '☕ !support', type: 0 }]
  });

  // Register slash commands
  try {
    // Build commands array
    const commands = [
      new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Vérifier que le bot fonctionne'),
        new SlashCommandBuilder()
          .setName('story')
          .setDescription('Gestionnaire d\'histoires collaboratives')
          .addSubcommand(sub =>
            sub.setName('start')
              .setDescription('Lancer une nouvelle histoire')
              .addStringOption(opt => opt.setName('theme').setDescription('Thème de l\'histoire').setRequired(true))
              .addStringOption(opt =>
                opt.setName('mode')
                  .setDescription('Mode: classic ou roleplay')
                  .setChoices({ name: 'Classique', value: 'classic' }, { name: 'Roleplay', value: 'roleplay' })
                  .setRequired(false)
              )
          )
          .addSubcommand(sub =>
            sub.setName('join')
              .setDescription('[Roleplay] S\'enregistrer avec un rôle')
              .addStringOption(opt => opt.setName('role').setDescription('Nom de votre rôle/personnage').setRequired(true))
          )
          .addSubcommand(sub =>
            sub.setName('ready')
              .setDescription('[Roleplay] Lancer la partie après les inscriptions')
          )
          .addSubcommand(sub =>
            sub.setName('end')
              .setDescription('Terminer l\'histoire actuelle')
          )
      ];

      // Ajouter la commande /clear
      commands.push(
        new SlashCommandBuilder()
          .setName('clear')
          .setDescription('Supprimer des messages dans le salon')
          .addIntegerOption(opt =>
            opt.setName('nombre')
              .setDescription('Nombre de messages à supprimer (1-100)')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(100)
          )
      );

      // Ajouter la commande /roast
      commands.push(
        new SlashCommandBuilder()
          .setName('roast')
          .setDescription('Insulter quelqu\'un de façon hilarante')
          .addUserOption(opt =>
            opt.setName('cible')
              .setDescription('La personne à insulter')
              .setRequired(true)
          )
      );

      // Ajouter la commande /versusai
      commands.push(
        new SlashCommandBuilder()
          .setName('versusai')
          .setDescription('OpenAI vs Grok débattent un sujet')
          .addStringOption(opt =>
            opt.setName('sujet')
              .setDescription('Le sujet à débattre')
              .setRequired(true)
          )
      );

      // Ajouter la commande /debate-respond
      commands.push(
        new SlashCommandBuilder()
          .setName('debate-respond')
          .setDescription('Propose un argument et déclenche un débat des 2 IAs')
          .addStringOption(opt =>
            opt.setName('argument')
              .setDescription('Ton argument à débattre')
              .setRequired(true)
          )
      );

      // Ajouter la commande /debate-respond-grok
      commands.push(
        new SlashCommandBuilder()
          .setName('debate-respond-grok')
          .setDescription('Attaque Grok avec un argument')
          .addStringOption(opt =>
            opt.setName('argument')
              .setDescription('Ton argument contre Grok')
              .setRequired(true)
          )
      );

      // Ajouter la commande /debate-respond-openai
      commands.push(
        new SlashCommandBuilder()
          .setName('debate-respond-openai')
          .setDescription('Attaque OpenAI avec un argument')
          .addStringOption(opt =>
            opt.setName('argument')
              .setDescription('Ton argument contre OpenAI')
              .setRequired(true)
          )
      );

      // Ajouter la commande /model (forcer un modèle spécifique)
      commands.push(
        new SlashCommandBuilder()
          .setName('model')
          .setDescription('🤖 Forcer l\'utilisation d\'un modèle IA spécifique pour la prochaine réponse')
          .addStringOption(opt =>
            opt.setName('choice')
              .setDescription('Modèle à utiliser')
              .addChoices(
                { name: 'Opus (perfection)', value: 'opus' },
                { name: 'Sonnet (équilibré)', value: 'sonnet' },
                { name: 'Gemini (vision/long)', value: 'gemini' },
                { name: 'Mistral (rapide)', value: 'mistral' },
                { name: 'Perplexity (web)', value: 'perplexity' },
                { name: 'Auto (routage intelligent)', value: 'auto' }
              )
              .setRequired(true)
          )
      );

      // Ajouter la commande /preferences (préférences utilisateur)
      commands.push(
        new SlashCommandBuilder()
          .setName('preferences')
          .setDescription('⚙️ Gérer vos préférences personnelles')
          .addSubcommand(sub =>
            sub.setName('view')
              .setDescription('Voir vos préférences actuelles')
          )
          .addSubcommand(sub =>
            sub.setName('model')
              .setDescription('Choisir votre modèle IA préféré')
              .addStringOption(opt =>
                opt.setName('choice')
                  .setDescription('Modèle IA à utiliser par défaut')
                  .addChoices(
                    { name: 'Auto (routage intelligent)', value: 'auto' },
                    { name: 'Claude Opus (perfection)', value: 'opus' },
                    { name: 'Claude Sonnet (équilibré)', value: 'sonnet' },
                    { name: 'Gemini (vision/long)', value: 'gemini' },
                    { name: 'Mistral (rapide)', value: 'mistral' },
                    { name: 'Perplexity (web)', value: 'perplexity' }
                  )
                  .setRequired(true)
              )
          )
          .addSubcommand(sub =>
            sub.setName('style')
              .setDescription('Choisir le style de réponse')
              .addStringOption(opt =>
                opt.setName('choice')
                  .setDescription('Style de réponse préféré')
                  .addChoices(
                    { name: 'Normal', value: 'normal' },
                    { name: 'Concis (2-3 lignes max)', value: 'concis' },
                    { name: 'Détaillé', value: 'detaille' },
                    { name: 'Drôle/Sarcastique', value: 'drole' }
                  )
                  .setRequired(true)
              )
          )
          .addSubcommand(sub =>
            sub.setName('language')
              .setDescription('Choisir votre langue préférée')
              .addStringOption(opt =>
                opt.setName('choice')
                  .setDescription('Langue de réponse')
                  .addChoices(
                    { name: 'Français', value: 'fr' },
                    { name: 'English', value: 'en' },
                    { name: 'Español', value: 'es' }
                  )
                  .setRequired(true)
              )
          )
          .addSubcommand(sub =>
            sub.setName('reset')
              .setDescription('Réinitialiser toutes vos préférences')
          )
      );

      // Ajouter la commande /config (gérer les channels des features)
      commands.push(
        new SlashCommandBuilder()
          .setName('config')
          .setDescription('⚙️ Configurer les channels pour chaque fonctionnalité (creator only)')
          .addSubcommand(sub =>
            sub.setName('list')
              .setDescription('Lister tous les channels configurés')
          )
          .addSubcommand(sub =>
            sub.setName('set')
              .setDescription('Assigner un channel à une fonctionnalité')
              .addStringOption(opt =>
                opt.setName('feature')
                  .setDescription('Fonctionnalité à configurer')
                  .addChoices(
                    { name: 'AI Assistant', value: 'assistant' },
                    { name: 'Counting', value: 'counting' },
                    { name: 'Confession', value: 'confession' },
                    { name: 'Story Library', value: 'story_library' },
                    { name: 'Thread Auto-Create', value: 'thread_create' },
                    { name: 'Word Game', value: 'word_game' },
                    { name: 'Quiz', value: 'quiz' },
                    { name: 'Error Logs', value: 'error_logs' }
                  )
                  .setRequired(true)
              )
              .addChannelOption(opt =>
                opt.setName('channel')
                  .setDescription('Channel à utiliser')
                  .setRequired(true)
              )
          )
          .addSubcommand(sub =>
            sub.setName('remove')
              .setDescription('Supprimer la configuration d\'une fonctionnalité')
              .addStringOption(opt =>
                opt.setName('feature')
                  .setDescription('Fonctionnalité à supprimer')
                  .addChoices(
                    { name: 'AI Assistant', value: 'assistant' },
                    { name: 'Counting', value: 'counting' },
                    { name: 'Confession', value: 'confession' },
                    { name: 'Story Library', value: 'story_library' },
                    { name: 'Thread Auto-Create', value: 'thread_create' },
                    { name: 'Word Game', value: 'word_game' },
                    { name: 'Quiz', value: 'quiz' },
                    { name: 'Error Logs', value: 'error_logs' }
                  )
                  .setRequired(true)
              )
          )
      );

    // Register commands globally (available on all servers)
    // Note: Global commands take ~1 hour to propagate
    await client.application.commands.set(commands);
    console.log('✅ Slash commands enregistrées globalement (dispo sur tous les serveurs dans ~1h)');
  } catch (err) {
    console.error('❌ Erreur enregistrement slash commands:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  // Handle slash commands
  if (interaction.isChatInputCommand()) {
    try {
      const { commandName, options } = interaction;

      if (commandName === 'ping') {
        await interaction.reply(`🏓 Pong! Latence: ${client.ws.ping}ms`);
        return;
      }

      if (commandName === 'clear') {
        await handleClearCommand(interaction);
        return;
      }

      if (commandName === 'roast') {
        await handleRoastCommand(interaction);
        return;
      }

      if (commandName === 'versusai') {
        await handleVersusAiCommand(interaction);
        return;
      }

      if (commandName === 'debate-respond') {
        await handleDebateRespondCommand(interaction);
        return;
      }

      if (commandName === 'debate-respond-grok') {
        await handleDebateRespondGrokCommand(interaction);
        return;
      }

      if (commandName === 'debate-respond-openai') {
        await handleDebateRespondOpenaiCommand(interaction);
        return;
      }

      if (commandName === 'model') {
        await handleModelCommand(interaction);
        return;
      }

      if (commandName === 'preferences') {
        const subcommand = options.getSubcommand();
        const userId = interaction.user.id;

        if (subcommand === 'view') {
          const prefs = await getQuery('SELECT * FROM user_preferences WHERE user_id = ?', [userId]);
          
          if (!prefs) {
            await interaction.reply({ 
              content: '📋 Vous n\'avez pas encore de préférences configurées.\nUtilisez `/preferences model`, `/preferences style` ou `/preferences language` pour commencer.', 
              ephemeral: true 
            });
            return;
          }

          const embed = new EmbedBuilder()
            .setTitle('⚙️ Vos Préférences')
            .setColor(0x5865f2)
            .addFields(
              { name: '🤖 Modèle IA', value: prefs.ai_model_preference || 'Auto (routage intelligent)', inline: true },
              { name: '💬 Style', value: prefs.response_style || 'Normal', inline: true },
              { name: '🌐 Langue', value: prefs.language || 'Français', inline: true }
            )
            .setFooter({ text: 'Utilisez /preferences pour modifier' })
            .setTimestamp();

          await interaction.reply({ embeds: [embed], ephemeral: true });
        } else if (subcommand === 'model') {
          const choice = options.getString('choice');
          const now = new Date().toISOString();
          
          await runQuery(
            'INSERT INTO user_preferences (user_id, ai_model_preference, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET ai_model_preference = ?, updated_at = ?',
            [userId, choice, now, now, choice, now]
          );

          await interaction.reply({ 
            content: `✅ Modèle IA défini sur **${choice}**`, 
            ephemeral: true 
          });
        } else if (subcommand === 'style') {
          const choice = options.getString('choice');
          const now = new Date().toISOString();
          
          await runQuery(
            'INSERT INTO user_preferences (user_id, response_style, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET response_style = ?, updated_at = ?',
            [userId, choice, now, now, choice, now]
          );

          await interaction.reply({ 
            content: `✅ Style de réponse défini sur **${choice}**`, 
            ephemeral: true 
          });
        } else if (subcommand === 'language') {
          const choice = options.getString('choice');
          const now = new Date().toISOString();
          
          await runQuery(
            'INSERT INTO user_preferences (user_id, language, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET language = ?, updated_at = ?',
            [userId, choice, now, now, choice, now]
          );

          await interaction.reply({ 
            content: `✅ Langue définie sur **${choice}**`, 
            ephemeral: true 
          });
        } else if (subcommand === 'reset') {
          await runQuery('DELETE FROM user_preferences WHERE user_id = ?', [userId]);
          await interaction.reply({ 
            content: '🔄 Vos préférences ont été réinitialisées.', 
            ephemeral: true 
          });
        }
        return;
      }

      if (commandName === 'config') {
        // Only allow creator
        if (interaction.user.id !== config.creatorId) {
          await interaction.reply({ content: '❌ Seul le créateur peut configurer les channels.', ephemeral: true });
          return;
        }

        const subcommand = options.getSubcommand();

        if (subcommand === 'list') {
          // Afficher tous les channels configurés
          const configuredFeatures = await allQuery('SELECT feature, channel_id, enabled, updated_at FROM channel_config ORDER BY feature');
          
          if (configuredFeatures.length === 0) {
            await interaction.reply({ content: '📭 Aucune configuration trouvée.', ephemeral: true });
            return;
          }

          let list = '⚙️ **Configurations actuelles:**\n';
          for (const feat of configuredFeatures) {
            const channel = await client.channels.fetch(feat.channel_id).catch(() => null);
            const channelName = channel ? `<#${feat.channel_id}>` : `*deleted*`;
            const status = feat.enabled ? '✅' : '❌';
            list += `${status} **${feat.feature}**: ${channelName} (${new Date(feat.updated_at).toLocaleDateString('fr-FR')})\n`;
          }

          await interaction.reply({ content: list, ephemeral: true });
        } else if (subcommand === 'set') {
          const feature = options.getString('feature');
          const channel = options.getChannel('channel');

          if (!channel) {
            await interaction.reply({ content: '❌ Channel introuvable.', ephemeral: true });
            return;
          }

          const now = new Date().toISOString();
          await runQuery(
            'INSERT INTO channel_config (feature, channel_id, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT(feature) DO UPDATE SET channel_id = ?, enabled = 1, updated_at = ?',
            [feature, channel.id, now, now, channel.id, now]
          );

          await interaction.reply({
            content: `✅ **${feature}** configuré → <#${channel.id}>`,
            ephemeral: true
          });
        } else if (subcommand === 'remove') {
          const feature = options.getString('feature');

          const config_row = await getQuery('SELECT * FROM channel_config WHERE feature = ?', [feature]);
          if (!config_row) {
            await interaction.reply({ content: `❌ **${feature}** n'est pas configurée.`, ephemeral: true });
            return;
          }

          await runQuery('DELETE FROM channel_config WHERE feature = ?', [feature]);

          await interaction.reply({
            content: `🗑️ **${feature}** a été supprimée.`,
            ephemeral: true
          });
        }
        return;
      }

      if (commandName === 'story') {
        const subcommand = options.getSubcommand();

        if (subcommand === 'start') {
          await handleStorySlashStart(interaction);
        } else if (subcommand === 'join') {
          await handleStorySlashJoin(interaction);
        } else if (subcommand === 'ready') {
          await handleStorySlashReady(interaction);
        } else if (subcommand === 'end') {
          await handleStorySlashEnd(interaction);
        }
      }
    } catch (err) {
      console.error('❌ Erreur slash command:', err);
      try {
        await interaction.reply({ content: '❌ Une erreur est survenue.', ephemeral: true });
      } catch {}
    }
    return;
  }

  if (!interaction.isButton()) {
    return;
  }

  // Handle merge/no-merge buttons
  if (interaction.customId.startsWith('merge_')) {
    const parts = interaction.customId.replace('merge_', '').split('_');
    const branchName = parts.slice(0, -1).join('_');
    const targetBranch = parts[parts.length - 1];
    
    try {
      await interaction.deferUpdate();
      const repoPath = './';
      
      execSync(`cd "${repoPath}" && git checkout ${targetBranch} && git merge ${branchName}`, { stdio: 'ignore' });
      
      // Push to remote
      try {
        const pushCmd = getGitPushCommand(targetBranch);
        if (pushCmd) {
          execSync(`cd "${repoPath}" && ${pushCmd}`, { stdio: 'ignore' });
        }
      } catch (pushError) {
        console.warn('⚠️ Git push failed:', pushError.message);
      }
      
      await interaction.channel.send(`✅ Branche \`${branchName}\` fusionnée sur \`${targetBranch}\`!`);
      console.log(`✅ Branch ${branchName} merged to ${targetBranch}`);
    } catch (error) {
      await interaction.channel.send(`❌ Erreur merge: ${error.message}`);
      console.error('❌ Merge failed:', error);
    }
    return;
  }

  if (interaction.customId.startsWith('nomerge_')) {
    const branchName = interaction.customId.replace('nomerge_', '');
    try {
      await interaction.deferUpdate();
      await interaction.channel.send(`❌ Fusion de \`${branchName}\` annulée. Branche conservée pour vérification.`);
      console.log(`❌ Branch ${branchName} merge cancelled`);
    } catch (error) {
      console.error('❌ Error handling no-merge:', error);
    }
    return;
  }

  const [namespace, action] = interaction.customId.split(':');
  if (namespace !== 'action-verite') {
    return;
  }

  const game = getActionVeriteGames().get(interaction.message.id);
  if (!game) {
    await interaction.reply({
      content: 'Cette partie est terminée ou inactive.',
      ephemeral: true
    });
    return;
  }

  const lock = getActionVeriteLocks().get(interaction.message.id) ?? Promise.resolve();
  const nextLock = lock.then(async () => {
    if (action === 'termine') {
      if (!game.activeUserId) {
        await interaction.reply({
          content: 'Aucune partie en cours pour le moment.',
          ephemeral: true
        });
        return;
      }

      if (interaction.user.id !== game.activeUserId) {
        await interaction.reply({
          content: `Seul <@${game.activeUserId}> peut terminer la partie en cours.`,
          ephemeral: true
        });
        return;
      }

      game.activeUserId = null;
      game.threadId = null;
      await interaction.update({
        components: [createActionVeriteRow(false)]
      });
      await interaction.channel.send('La partie est terminée. Les boutons sont de nouveau disponibles.');
      return;
    }

    if (game.activeUserId) {
      await interaction.reply({
        content: `Une partie est déjà en cours avec <@${game.activeUserId}>.`,
        ephemeral: true
      });
      return;
    }

    game.activeUserId = interaction.user.id;
    const choiceLabel = action === 'action' ? 'Action' : 'Vérité';
    let threadMessage = 'Le fil de discussion est prêt.';

    try {
      const thread = await interaction.message.startThread({
        name: `Action ou Vérité — ${interaction.user.username}`,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay
      });
      game.threadId = thread.id;
      await thread.send(`${interaction.user} a choisi **${choiceLabel}**. À vous de jouer !`);
      threadMessage = `Thread créé : ${thread.name}`;
    } catch (error) {
      // Ignore thread creation errors and fallback to channel only.
      threadMessage = 'Impossible de créer le thread, la partie se déroule ici.';
    }

    await interaction.update({
      components: [createActionVeriteRow(true)]
    });
    await interaction.channel.send(`${interaction.user} a choisi **${choiceLabel}** ! ${threadMessage}`);
  });

  getActionVeriteLocks().set(interaction.message.id, nextLock.catch(() => {}));
  await nextLock;
});

// === SUPER BRAIN: Event Observers ===

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (newMessage.author.bot) return;
  await observeEvent('claude', 'message_edit', {
    userId: newMessage.author.id,
    oldContent: oldMessage.content?.substring(0, 100),
    newContent: newMessage.content?.substring(0, 100),
    channelId: newMessage.channelId,
    participants: newMessage.author.id
  });
});

client.on('messageDelete', async (message) => {
  if (message.author?.bot) return;
  await observeEvent('claude', 'message_delete', {
    userId: message.author?.id,
    content: message.content?.substring(0, 100),
    channelId: message.channelId,
    participants: message.author?.id
  });
});

client.on('guildMemberAdd', async (member) => {
  await observeEvent('claude', 'member_join', {
    userId: member.id,
    username: member.user.username,
    guildId: member.guild.id,
    participants: member.id
  });
  await learnContextKnowledge('claude', 'server', member.guild.id, `${member.user.username} a rejoint le serveur`);
});

client.on('guildMemberRemove', async (member) => {
  await observeEvent('claude', 'member_leave', {
    userId: member.id,
    username: member.user.username,
    guildId: member.guild.id,
    participants: member.id
  });
  await learnContextKnowledge('claude', 'server', member.guild.id, `${member.user.username} a quitté le serveur`);
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  await observeEvent('claude', 'reaction_add', {
    userId: user.id,
    emoji: reaction.emoji.name,
    messageAuthor: reaction.message.author?.id,
    channelId: reaction.message.channelId,
    participants: `${user.id},${reaction.message.author?.id}`
  });
  
  // Apprend les relations via réactions
  if (reaction.message.author && !reaction.message.author.bot) {
    await updateRelationship('claude', user.id, reaction.message.author.id, 'reaction');
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (newState.member.user.bot) return;
  
  if (!oldState.channelId && newState.channelId) {
    // Joined voice
    await observeEvent('claude', 'voice_join', {
      userId: newState.member.id,
      channelId: newState.channelId,
      participants: newState.member.id
    });
  } else if (oldState.channelId && !newState.channelId) {
    // Left voice
    await observeEvent('claude', 'voice_leave', {
      userId: newState.member.id,
      channelId: oldState.channelId,
      participants: newState.member.id
    });
  }
});

// === FONCTION: Envoyer les erreurs au channel threadChannelIds ===
// Fonction pour logger les erreurs uniquement dans le channel approprié
async function logErrorToChannel(errorMessage) {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) return;

    // Chercher un channel parmi threadChannelIds
    const threadChannels = config.threadChannelIds || [];
    let targetChannel = null;

    for (const channelId of threadChannels) {
      const ch = guild.channels.cache.get(channelId);
      if (ch && ch.type === 0) { // 0 = TextChannel
        targetChannel = ch;
        break;
      }
    }

    if (!targetChannel) {
      // Fallback: chercher un channel général
      targetChannel = guild.channels.cache.find(ch => 
        ch.type === 0 && 
        (ch.name.includes('général') || ch.name.includes('general') || ch.name.includes('error') || ch.name.includes('log'))
      ) || guild.channels.cache.find(ch => ch.type === 0);
    }

    if (targetChannel && targetChannel.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages)) {
      // Formater le message d'erreur
      const embed = {
        color: 0xe74c3c, // Couleur rouge pour les erreurs
        title: '❌ Erreur Détectée',
        description: errorMessage,
        timestamp: new Date().toISOString(),
        footer: { text: 'M-Yra Error Logger' }
      };
      
      await targetChannel.send({ embeds: [embed] });
    }
  } catch (err) {
    // Silencieusement échouer - ne pas créer de boucle infinie
    originalConsoleError('⚠️ Erreur lors du logging d\'erreur:', err.message);
  }
}

// === DÉSACTIVÉ: Fonctionnalité de messages spontanés supprimée ===
// Messages spontanés et introspection périodique supprimés pour garder un ton cohérent
// Voir git history si réactivation future envisagée


await initializeDatabase();

// Initialize general prompt for Claude
await initializeGeneralPrompt();

client.login(config.token);




