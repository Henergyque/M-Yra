import { ChannelType, EmbedBuilder, ThreadAutoArchiveDuration, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { config } from '../config.js';
import { getQuery, runQuery, allQuery } from '../db.js';
import { openai } from '../ai/clients.js';
import { getChannelForFeature } from '../utils/channel-helper.js';
import { sendMaintenanceNotice } from '../utils/maintenance.js';
import { applyGenericGameModerationDecision, isWhitelisted } from '../services/game-moderation.js';

const wordGameLocks = new Map();
const validatedPairs = new Map();

async function validateWordConnection(word1, word2) {
  const cacheKey = `${word1.toLowerCase()}|${word2.toLowerCase()}`;

  if (validatedPairs.has(cacheKey)) {
    return validatedPairs.get(cacheKey);
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-5.2',
      messages: [
        {
          role: 'system',
          content: 'You are a word association validator. Determine if two words are semantically or contextually related. Be lenient and accept creative connections. Answer with YES or NO followed by a brief explanation in French.'
        },
        {
          role: 'user',
          content: `Are the words "${word1}" and "${word2}" meaningfully related?`
        }
      ],
      max_completion_tokens: 150,
      temperature: 0.3
    });

    const content = response.choices[0]?.message?.content || '';
    const normalized = content.trim();
    const isValid = /^(YES|OUI)\b/i.test(normalized);
    const explanation = normalized.replace(/^(YES|OUI|NO|NON)\b[:\s-]*/i, '').trim();

    const result = { isValid, explanation };
    validatedPairs.set(cacheKey, result);

    return result;
  } catch (error) {
    console.error('OpenAI API error:', error);
    return { isValid: false, explanation: 'Erreur de validation (API indisponible)' };
  }
}

async function generateNewWord() {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-5.2',
      messages: [
        {
          role: 'system',
          content: 'Generate a single common French word that is neutral and easy to associate with other words. Respond with ONLY the word, nothing else.'
        },
        {
          role: 'user',
          content: 'Give me one word.'
        }
      ],
      max_completion_tokens: 10,
      temperature: 0.8
    });

    const word = response.choices[0]?.message?.content?.trim() || 'soleil';
    return word.toLowerCase();
  } catch (error) {
    console.error('OpenAI API error:', error);
    const fallbackWords = ['soleil', 'chat', 'mer', 'arbre', 'musique', 'livre', 'fleur', 'étoile', 'montagne', 'rivière'];
    return fallbackWords[Math.floor(Math.random() * fallbackWords.length)];
  }
}

async function getWordGameState(channelId) {
  const row = await getQuery(
    'SELECT current_word, last_user_id, channel_streak FROM word_game_state WHERE channel_id = ?',
    [channelId]
  );

  return {
    currentWord: row?.current_word || null,
    lastUserId: row?.last_user_id || null,
    channelStreak: row?.channel_streak || 0
  };
}

async function setWordGameState(channelId, currentWord, lastUserId, channelStreak) {
  await runQuery(
    `INSERT INTO word_game_state (channel_id, current_word, last_user_id, channel_streak)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       current_word = excluded.current_word,
       last_user_id = excluded.last_user_id,
       channel_streak = excluded.channel_streak`,
    [channelId, currentWord, lastUserId, channelStreak]
  );
}

async function updateWordGameScore(userId, channelId, points, currentStreak) {
  const existing = await getQuery(
    'SELECT total_points, personal_best_streak FROM word_game_scores WHERE user_id = ? AND channel_id = ?',
    [userId, channelId]
  );

  const newTotalPoints = (existing?.total_points || 0) + points;
  const newBestStreak = Math.max(existing?.personal_best_streak || 0, currentStreak);

  await runQuery(
    `INSERT INTO word_game_scores (user_id, channel_id, total_points, personal_best_streak)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET
       total_points = excluded.total_points,
       personal_best_streak = excluded.personal_best_streak`,
    [userId, channelId, newTotalPoints, newBestStreak]
  );
}

function normalizeWord(raw) {
  if (!raw) return '';
  let w = String(raw).toLowerCase().trim();
  // Remove accents/diacritics
  w = w.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Basic French plural normalization
  if (w.endsWith('eaux')) {
    w = w.slice(0, -1 * 'eaux'.length) + 'eau';
  } else if (w.endsWith('aux')) {
    w = w.slice(0, -1 * 'aux'.length) + 'al';
  } else if (w.endsWith('oux')) {
    w = w.slice(0, -1 * 'oux'.length) + 'ou';
  } else if (w.length > 3 && (w.endsWith('s') || w.endsWith('x'))) {
    w = w.slice(0, -1);
  }
  return w;
}

async function isWordUsed(channelId, word) {
  const normalized = normalizeWord(word);
  const row = await getQuery(
    'SELECT 1 FROM word_game_history WHERE channel_id = ? AND word = ?',
    [channelId, normalized]
  );
  return Boolean(row);
}

async function addWordHistory(channelId, word) {
  const normalized = normalizeWord(word);
  await runQuery(
    'INSERT OR IGNORE INTO word_game_history (channel_id, word, created_at) VALUES (?, ?, ?)',
    [channelId, normalized, new Date().toISOString()]
  );
}

async function clearWordHistory(channelId) {
  await runQuery(
    'DELETE FROM word_game_history WHERE channel_id = ?',
    [channelId]
  );
}

async function createWordGameErrorThread(message) {
  if (message.channel.type !== ChannelType.GuildText) {
    return null;
  }

  try {
    const thread = await message.startThread({
      name: 'Discussion - Mot rejeté',
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay
    });
    return thread;
  } catch (error) {
    // Ignore thread creation errors
    return null;
  }
}

function createWordGameGageButtonRow(targetUserId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gage:word-game:${targetUserId}`)
      .setLabel('Gage donné')
      .setStyle(ButtonStyle.Secondary)
  );
}

export async function handleWordGame(message) {
  const wordGameChannelId = await getChannelForFeature('word_game', 'wordGameChannelId', config);
  if (message.channel.id !== wordGameChannelId) {
    return false;
  }

  const maintenanceBlocked = await sendMaintenanceNotice(message);
  if (maintenanceBlocked) {
    return true;
  }

  const userWord = message.content.trim().toLowerCase();

  // Ignore empty messages or commands
  if (!userWord || userWord.startsWith('!')) {
    return false;
  }

  // Only accept single words (allow hyphens for compound words)
  if (!/^[a-zàâäéèêëïîôùûüÿæœç-]+$/i.test(userWord)) {
    return false;
  }

  const lock = wordGameLocks.get(message.channel.id) ?? Promise.resolve();
  const nextLock = lock.then(async () => {
    const { currentWord, lastUserId, channelStreak } = await getWordGameState(message.channel.id);

    // Prevent same user from playing twice in a row
    if (lastUserId === message.author.id) {
      await message.react('❌');
      const sameUserEmbed = new EmbedBuilder()
        .setTitle('🚫 Tour consécutif interdit')
        .setDescription(
          `Tu as déjà joué le mot précédent (**${currentWord}**). ` +
          `Laisse quelqu'un d'autre répondre avant de rejouer.`
        )
        .setColor(0xff6b6b)
        .setFooter({ text: `Mot actuel: ${currentWord || '—'}` });

      await message.channel.send({ content: `${message.author}`, embeds: [sameUserEmbed] });
      return true;
    }

    // Reject reusing an already played word (channel history)
    if (await isWordUsed(message.channel.id, userWord)) {
      await message.react('❌');
      const duplicateEmbed = new EmbedBuilder()
        .setTitle('🔁 Mot déjà utilisé')
        .setDescription(
          `Le mot **${userWord}** (ou une de ses variantes) a déjà été joué dans ce canal.\n` +
          (currentWord
            ? `Essayez un mot différent lié à **${currentWord}**.`
            : 'Le jeu va bientôt démarrer avec un nouveau mot.')
        )
        .setColor(0xff6b6b);
      await message.channel.send({ content: `${message.author}`, embeds: [duplicateEmbed] });
      return true;
    }

    // Initialize game with first word
    if (!currentWord) {
      // Fresh start: clear previous history so old mots are reusing allowed
      await clearWordHistory(message.channel.id);
      await setWordGameState(message.channel.id, userWord, message.author.id, 0);
      await addWordHistory(message.channel.id, userWord);
      await message.react('🎯');

      const startEmbed = new EmbedBuilder()
        .setTitle('🎮 Jeu d\'Association de Mots')
        .setDescription(`Le jeu commence avec le mot : **${userWord}**\n\nProchaine personne, trouvez un mot lié !`)
        .setColor(0x5865f2)
        .setFooter({ text: 'Streak: 0 | Points: +1 par mot valide + bonus streak' });

      await message.channel.send({ embeds: [startEmbed] });
      return true;
    }

    // Validate connection with OpenAI
    const { isValid, explanation } = await validateWordConnection(currentWord, userWord);

    if (!isValid) {
      // Reset streak on error
      await setWordGameState(message.channel.id, null, null, 0);
      await clearWordHistory(message.channel.id);
      await message.react('❌');
      const errorThread = await createWordGameErrorThread(message);

      let moderationText = 'ℹ️ Erreur probable, aucune chance retirée.';
      const whitelisted = await isWhitelisted(message.guild.id, message.author.id);
      if (!whitelisted) {
        const decision = await applyGenericGameModerationDecision({
          guildId: message.guild.id,
          channelId: message.channel.id,
          userId: message.author.id,
          gameType: 'word_game',
          details: {
            currentWord,
            submittedWord: userWord,
            explanation,
            channelStreak
          }
        });
        moderationText = `🧠 Détection sabotage: **${decision.level}** (${Math.round(decision.confidence * 100)}%) — ${decision.reason}`;
        if (decision.consumed > 0) {
          moderationText += `\n⚠️ Chance utilisée: **${decision.chanceState.used}/2**.`;
        }
        if (decision.sanctioned) {
          moderationText += '\n⛔ Sanction jeux activée.';
        }
      } else {
        moderationText = '✅ Membre whitelisté: aucune chance retirée.';
      }

      const errorEmbed = new EmbedBuilder()
        .setTitle('❌ Mot Rejeté')
        .setDescription(
          `**${userWord}** n'est pas suffisamment lié à **${currentWord}**.\n\n` +
          `**Raison :** ${explanation}\n\n` +
          `Le streak de **${channelStreak}** mot${channelStreak > 1 ? 's' : ''} est perdu ! 😢\n` +
          `L'historique des mots est réinitialisé.\nRelance en cours...\n\n${moderationText}`
        )
        .setColor(0xff6b6b)
        .setTimestamp();

      await message.channel.send({ content: `${message.author}`, embeds: [errorEmbed] });

      if (errorThread) {
        await errorThread.send({
          content: `🧷 Thread ouvert pour <@${message.author.id}>. Quand le gage est défini, clique sur le bouton pour lancer la surveillance.`,
          components: [createWordGameGageButtonRow(message.author.id)]
        });
      }

      // Generate new starting word
      const newWord = await generateNewWord();
      await setWordGameState(message.channel.id, newWord, null, 0);
      await addWordHistory(message.channel.id, newWord);

      const restartEmbed = new EmbedBuilder()
        .setTitle('🔄 Nouveau Départ')
        .setDescription(`Le jeu reprend avec le mot : **${newWord}**`)
        .setColor(0xffa500)
        .setFooter({ text: 'À vous de jouer !' });

      await message.channel.send({ embeds: [restartEmbed] });
      return true;
    }

    // Valid word! Update state and score
    const newStreak = channelStreak + 1;
    const basePoints = 1;
    const streakBonus = Math.floor(newStreak / 10);
    const totalPoints = basePoints + streakBonus;

    await setWordGameState(message.channel.id, userWord, message.author.id, newStreak);
    await addWordHistory(message.channel.id, userWord);
    await updateWordGameScore(message.author.id, message.channel.id, totalPoints, newStreak);
    await message.react('✅');

    // Announce milestones only (5, 10, then every 50)
    const shouldAnnounce = newStreak === 5 || newStreak === 10 || newStreak % 50 === 0;
    if (shouldAnnounce) {
      const progressEmbed = new EmbedBuilder()
        .setDescription(
          `🔥 **Streak: ${newStreak}** mot${newStreak > 1 ? 's' : ''} !\n` +
          `${message.author} a gagné **${totalPoints}** point${totalPoints > 1 ? 's' : ''} ` +
          (streakBonus > 0 ? `(+${streakBonus} bonus streak) ` : '') + '!'
        )
        .setColor(0x57f287);

      await message.channel.send({ embeds: [progressEmbed] });
    }

    return true;
  });

  wordGameLocks.set(message.channel.id, nextLock.catch(() => {}));
  return nextLock;
}

export async function handleWordStats(message) {
  const trimmed = message.content.trim();
  if (!trimmed.startsWith('!wordstats')) {
    return false;
  }

  const channelId = message.channel.id;
  const mentionMatch = trimmed.match(/<@!?(\d+)>/);
  const targetUserId = mentionMatch ? mentionMatch[1] : null;

  if (targetUserId) {
    // Show personal stats
    const userStats = await getQuery(
      'SELECT total_points, personal_best_streak FROM word_game_scores WHERE user_id = ? AND channel_id = ?',
      [targetUserId, channelId]
    );

    const gameState = await getWordGameState(channelId);

    const statsEmbed = new EmbedBuilder()
      .setTitle('📊 Statistiques Personnelles - Jeu de Mots')
      .setDescription(`Statistiques de <@${targetUserId}> dans ce canal`)
      .addFields(
        { name: '💯 Points Totaux', value: String(userStats?.total_points || 0), inline: true },
        { name: '🔥 Meilleur Streak', value: String(userStats?.personal_best_streak || 0), inline: true },
        { name: '📈 Streak Actuel', value: String(gameState.channelStreak), inline: true }
      )
      .setColor(0x5865f2)
      .setTimestamp();

    await message.channel.send({ embeds: [statsEmbed] });
    return true;
  }

  // Show leaderboard
  const topPlayers = await allQuery(
    'SELECT user_id, total_points, personal_best_streak FROM word_game_scores WHERE channel_id = ? ORDER BY total_points DESC LIMIT 10',
    [channelId]
  );

  const gameState = await getWordGameState(channelId);

  if (topPlayers.length === 0) {
    await message.channel.send('Aucune statistique disponible pour ce canal.');
    return true;
  }

  const leaderboardText = topPlayers
    .map((player, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
      return `${medal} <@${player.user_id}> — **${player.total_points}** pts (meilleur: ${player.personal_best_streak})`;
    })
    .join('\n');

  const leaderboardEmbed = new EmbedBuilder()
    .setTitle('🏆 Classement - Jeu de Mots')
    .setDescription(leaderboardText)
    .addFields(
      { name: '🎯 Mot Actuel', value: gameState.currentWord || 'Aucun', inline: true },
      { name: '🔥 Streak du Canal', value: String(gameState.channelStreak), inline: true }
    )
    .setColor(0xffd700)
    .setFooter({ text: 'Utilisez !wordstats @utilisateur pour voir les stats personnelles' })
    .setTimestamp();

  await message.channel.send({ embeds: [leaderboardEmbed] });
  return true;
}
