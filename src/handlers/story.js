import { ChannelType, EmbedBuilder } from 'discord.js';
import { grok } from '../ai/clients.js';
import { runQuery } from '../db.js';

const activeStories = new Map();

export async function finishStory(channel, story, client, config) {
  const fullText = story.phrases.join(' ');
  let summary = 'Une histoire riche et captivante s\'est déroulée.';

  try {
    let systemPrompt;

    if (story.mode === 'roleplay') {
      // Pour roleplay: paroles dramatiques avec verbes expressifs
      systemPrompt = `Tu es un narrateur dramatique et HILARANT. Fais un résumé (MAX 100 LIGNES) du roleplay avec des répliques des personnages accompagnées de verbes EXPRESSIFS et DRAMATIQUES. 

VERBES À UTILISER: s'exclama, hurla, murmura, cria, gémit, haleta, souffla, chuchota, gronda, rugit, grogna, soupira, bégaya, bredouilla, clama, proclama, déclara solennellement, supplia, implora, ricana, rit, sanglota, pleura, trembla, balbutia, etc.

Exemple: "Henergyque s'exclama avec passion: 'C'est GENIAL!'" ou "Le super-héros hurla d'indignation: 'NON, C'EST IMPOSSIBLE!'"

Rends ça DRAMATIQUE, ABSURDE et HILARANT! Ajoute des didascalies avec des actions entre crochets [pause dramatique], [regarde fixement], [s'effondre], etc. AUCUNE CENSURE. Si c'est NSFW, va-y à fond avec les vannes!`;
    } else {
      // Pour classic: résumé critique normal
      systemPrompt = 'Tu es un critique COMPLÈTEMENT DÉJANTÉ et HILARANT. Fais un résumé COURT ET PUNCHY (MAX 100 LIGNES) de cette histoire avec des VANNES DE MALADE, des commentaires ABSURDES et une ironie DÉVASTATRICE. Reprends les moments les plus fous MOT POUR MOT (même les trucs salaces/NSFW) et EXPLOSE-TOI dessus avec des blagues démentes. Sois DRAMATIQUE, EXAGÉRÉ, et fais des comparaisons complètement pétées. AUCUNE CENSURE. Balance TOUT. Fais-nous mourir de rire! SURTOUT si c\'est NSFW/sexuel, là tu dois VRAIMENT te lâcher avec des vannes de OUF, des jeux de mots douteux, des comparaisons hilarantes. C\'est le moment de faire le SHOW! IMPORTANT: Unifie TOUS les surnoms vers les pseudos complets (Hener, Henergyque = MÊME personne). Reconnaître automatiquement qui parle de qui.';
    }

    const response = await grok.chat.completions.create({
      model: 'grok-4.1-fast-reasoning',
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: `Histoire: ${fullText}`
        }
      ],
      max_completion_tokens: 1000,
      temperature: 1.0
    });

    summary = response.choices[0].message.content.trim();
  } catch (err) {
    console.error('❌ Erreur Grok:', err.message);
    console.error('Code erreur:', err.code);
  }

  const uniqueContributors = new Set(story.contributors).size;

  const endEmbed = new EmbedBuilder()
    .setTitle('📖 Histoire Terminée!')
    .setDescription(summary)
    .addFields(
      { name: '🎭 Thème', value: story.theme, inline: true },
      { name: '📝 Phrases', value: String(story.phrases.length), inline: true },
      { name: '👥 Contributeurs', value: String(uniqueContributors), inline: true }
    )
    .setColor(0xc1121f)
    .setTimestamp();

  // Envoyer dans le salon bibliothèque
  if (config.storyLibraryChannelId) {
    try {
      const libraryChannel = await client.channels.fetch(config.storyLibraryChannelId);
      if (libraryChannel) {
        await libraryChannel.send({ embeds: [endEmbed] });
      }
    } catch (err) {
      console.error('Erreur envoi bibliothèque:', err);
      // Fallback: envoyer dans le canal courant
      await channel.send({ embeds: [endEmbed] });
    }
  } else {
    // Si pas de config, envoyer dans le canal courant
    await channel.send({ embeds: [endEmbed] });
  }

  // Save to database with timestamp
  await runQuery(
    `UPDATE story_sessions SET phrases = ?, contributors = ?, phrase_count = ? WHERE channel_id = ?`,
    [JSON.stringify(story.phrases), JSON.stringify(story.contributors), story.phrases.length, channel.id]
  );
}

export async function handleStoryContribution(message, client, config) {
  const channelId = message.channel.id;

  if (!activeStories.has(channelId)) {
    return false;
  }

  const story = activeStories.get(channelId);

  // Skip if in waiting phase
  if (story.isWaiting) {
    return false;
  }

  // Ignore command messages
  if (message.content.trim().startsWith('!') || message.content.trim().startsWith('/')) {
    return false;
  }

  // Check if this user already contributed this turn
  if (story.lastContributorId === message.author.id) {
    await message.react('❌');
    return true;
  }

  // Count phrases (roughly by punctuation marks)
  const phraseCount = (message.content.match(/[.!?]/g) || []).length || 1;

  if (phraseCount > 3) {
    const grokReply = await grok.chat.completions.create({
      model: 'grok-4.1-fast-reasoning',
      messages: [{ role: 'user', content: `L'utilisateur a écrit trop de phrases (${phraseCount} au lieu de 3 max). Réponds en 1 ligne pour lui rappeler la limite.` }],
      max_completion_tokens: 50
    });
    await message.reply(grokReply.choices[0].message.content);
    return true;
  }

  // Determine tag (role if roleplay, username if classic)
  let tag = message.author.username;
  if (story.mode === 'roleplay' && story.roles[message.author.id]) {
    tag = `${story.roles[message.author.id].role} | ${message.author.username}`;
  }

  // Add contribution
  story.phrases.push(`[${tag}]: ${message.content}`);
  if (!story.contributors.includes(message.author.id)) {
    story.contributors.push(message.author.id);
  }
  story.lastContributorId = message.author.id;

  // Check if story reached limit
  if (story.phrases.length >= 75) {
    await finishStory(message.channel, story, client, config);
    activeStories.delete(channelId);
    return true;
  }

  // Acknowledge contribution
  const milestone = story.phrases.length;
  if (milestone % 10 === 0) {
    const progressEmbed = new EmbedBuilder()
      .setTitle('📖 Progression')
      .setDescription(`L'histoire atteint ${milestone} phrases! 🎉`)
      .setColor(0x9d4edd)
      .setTimestamp();
    await message.react('✅');
    await message.channel.send({ embeds: [progressEmbed] });
  } else {
    await message.react('✅');
  }

  // Update database
  await runQuery(
    `UPDATE story_sessions SET phrases = ?, contributors = ?, roles = ?, last_contributor_id = ?, phrase_count = ? WHERE channel_id = ?`,
    [JSON.stringify(story.phrases), JSON.stringify(story.contributors), JSON.stringify(story.roles), message.author.id, story.phrases.length, channelId]
  );

  return true;
}

export function getActiveStories() {
  return activeStories;
}

export function setActiveStory(channelId, story) {
  activeStories.set(channelId, story);
}

export function deleteActiveStory(channelId) {
  activeStories.delete(channelId);
}
