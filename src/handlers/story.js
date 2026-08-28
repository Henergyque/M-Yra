import { EmbedBuilder } from 'discord.js';
import { claude } from '../ai/clients.js';
import { runQuery, allQuery } from '../db.js';
import { getChannelForFeature } from '../utils/channel-helper.js';
import { retryWithBackoff, withTimeout } from '../utils/error-handler.js';

const activeStories = new Map();

// Tout le jeu d'histoire collaborative tourne sur Claude Opus 4.8, avec le même
// schéma d'appel que l'assistant (voir executeClaudeRequest dans response-builder).
const STORY_MODEL = 'claude-opus-4-8';

// Mêmes marges que l'assistant: 30s pour un appel court, 120s pour le résumé
// final qui doit relire toute l'histoire avant de rédiger.
const STORY_TIMEOUT_MS = 30000;
const SUMMARY_TIMEOUT_MS = 120000;

// Garde-fous de sortie: Discord coupe la description d'un embed à 4096
// caractères, on garde de la marge pour le marqueur de troncature.
const MAX_SUMMARY_CHARS = 3800;
const MAX_SUMMARY_LINES = 45;

export const MAX_STORY_PHRASES = 75;

// Consignes de fidélité communes aux deux modes: le résumé doit coller
// exactement à ce que les joueurs ont écrit, c'est la contrainte prioritaire.
const FIDELITY_RULES = `RÈGLES DE FIDÉLITÉ (PRIORITAIRES SUR TOUT LE RESTE):
- Tu résumes UNIQUEMENT ce que les joueurs ont écrit. N'invente AUCUN événement, personnage, lieu, objet ni dialogue qui ne figure pas dans la transcription.
- Respecte l'ordre chronologique des contributions numérotées.
- Chaque contribution est préfixée par son auteur entre crochets: [Pseudo] ou [Rôle | Pseudo]. Attribue chaque action et chaque réplique à la bonne personne, jamais à une autre.
- Unifie les surnoms d'une même personne (ex: "Hener" et "Henergyque" = la même personne).
- Si une contribution est absurde, hors-sujet ou contredit la précédente, garde-la telle quelle et moque-toi en. Ne la "corrige" pas, ne la lisse pas, ne la supprime pas.
- Si l'histoire est courte ou incompréhensible, fais un résumé court. Ne rallonge jamais en inventant.

LONGUEUR: adapte-toi à la matière (environ 1 ligne pour 2 ou 3 contributions). Maximum absolu: 40 lignes et 3500 caractères.

FORMAT: réponds directement avec le résumé final, sans préambule, sans titre, sans expliquer ta démarche. N'inclus aucune balise XML interne ou système dans ta réponse.`;

const ROLEPLAY_SUMMARY_PROMPT = `Tu es un narrateur dramatique et HILARANT. Fais le résumé d'un roleplay sous forme de répliques des personnages accompagnées de verbes EXPRESSIFS et DRAMATIQUES.

VERBES À UTILISER: s'exclama, hurla, murmura, cria, gémit, haleta, souffla, chuchota, gronda, rugit, grogna, soupira, bégaya, bredouilla, clama, proclama, déclara solennellement, supplia, implora, ricana, rit, sanglota, pleura, trembla, balbutia, etc.

Exemple: "Henergyque s'exclama avec passion: 'C'est GENIAL!'" ou "Le super-héros hurla d'indignation: 'NON, C'EST IMPOSSIBLE!'"

Rends ça DRAMATIQUE, ABSURDE et HILARANT! Ajoute des didascalies avec des actions entre crochets [pause dramatique], [regarde fixement], [s'effondre], etc. AUCUNE CENSURE. Si c'est NSFW, va-y à fond avec les vannes!

${FIDELITY_RULES}`;

const CLASSIC_SUMMARY_PROMPT = `Tu es un critique COMPLÈTEMENT DÉJANTÉ et HILARANT. Fais un résumé PUNCHY de cette histoire avec des VANNES DE MALADE, des commentaires ABSURDES et une ironie DÉVASTATRICE. Reprends les moments les plus fous MOT POUR MOT (même les trucs salaces/NSFW) et EXPLOSE-TOI dessus avec des blagues démentes. Sois DRAMATIQUE, EXAGÉRÉ, et fais des comparaisons complètement pétées. AUCUNE CENSURE. Balance TOUT. Fais-nous mourir de rire! SURTOUT si c'est NSFW/sexuel, là tu dois VRAIMENT te lâcher avec des vannes de OUF, des jeux de mots douteux, des comparaisons hilarantes. C'est le moment de faire le SHOW!

${FIDELITY_RULES}`;

const GAME_MASTER_PROMPT = "Tu es le maître du jeu d'une histoire collaborative sur Discord. Réponds en français, en UNE seule phrase courte, directement. Pas de préambule, pas de raisonnement visible, pas de balises.";

// Concatène uniquement les blocs texte d'une réponse Claude.
function extractClaudeText(content) {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text || '')
    .join('')
    .trim();
}

/**
 * Appel Claude pour le jeu d'histoire, calqué sur executeClaudeRequest:
 * même modèle, pas de `temperature` (Opus 4.8 la rejette avec un 400),
 * même paire withTimeout + retryWithBackoff.
 * Ne throw jamais: en cas d'échec API on retombe sur `fallback`.
 */
export async function storyNarration({ system, prompt, fallback = '', maxTokens = 400, timeoutMs = STORY_TIMEOUT_MS }) {
  const params = {
    model: STORY_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }]
  };

  try {
    return await retryWithBackoff(
      async () => {
        const response = await withTimeout(
          claude.messages.create(params),
          timeoutMs,
          'story'
        );

        return extractClaudeText(response.content) || fallback;
      },
      3,
      1000,
      'story'
    );
  } catch (err) {
    console.error('❌ Erreur Claude (story):', err.message);
    return fallback;
  }
}

// Réponse d'une ligne du maître du jeu (messages d'erreur, rappels de règles).
export async function storyLine(prompt, fallback) {
  return storyNarration({
    system: GAME_MASTER_PROMPT,
    prompt,
    fallback,
    maxTokens: 300
  });
}

// Garde-fou de sortie: jamais d'embed vide, jamais de pavé de 1000 lignes.
function clampSummary(text) {
  let guarded = (text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!guarded) return '';

  let truncated = false;

  const lines = guarded.split('\n');
  if (lines.length > MAX_SUMMARY_LINES) {
    guarded = lines.slice(0, MAX_SUMMARY_LINES).join('\n').trim();
    truncated = true;
  }

  if (guarded.length > MAX_SUMMARY_CHARS) {
    truncated = true;
    const cut = guarded.slice(0, MAX_SUMMARY_CHARS);
    // On coupe sur une fin de phrase pour ne pas laisser un mot à moitié.
    const boundary = Math.max(
      cut.lastIndexOf('\n'),
      cut.lastIndexOf('. '),
      cut.lastIndexOf('! '),
      cut.lastIndexOf('? ')
    );
    guarded = (boundary > MAX_SUMMARY_CHARS * 0.5 ? cut.slice(0, boundary + 1) : cut).trim();
  }

  if (truncated) {
    guarded += '\n\n*(résumé écourté — histoire complète en pièce jointe)*';
  }

  return guarded;
}

// Transcription numérotée: bien plus fidèle qu'un join(' ') qui écrase les tours.
function buildTranscript(story) {
  return (story.phrases || [])
    .map((phrase, index) => `${index + 1}. ${phrase}`)
    .join('\n');
}

function safeJson(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export async function finishStory(channel, story, client, config) {
  const transcript = buildTranscript(story);
  let summary = 'Une histoire riche et captivante s\'est déroulée.';

  if (transcript) {
    const rosterLine = Object.values(story.roles || {})
      .map(r => `${r.role} (${r.username})`)
      .join(', ');

    const userPrompt = [
      `Thème: ${story.theme}`,
      `Mode: ${story.mode === 'roleplay' ? 'roleplay' : 'classique'}`,
      rosterLine ? `Personnages: ${rosterLine}` : null,
      '',
      'Transcription complète des contributions, dans l\'ordre:',
      transcript
    ].filter(line => line !== null).join('\n');

    const generated = await storyNarration({
      system: story.mode === 'roleplay' ? ROLEPLAY_SUMMARY_PROMPT : CLASSIC_SUMMARY_PROMPT,
      prompt: userPrompt,
      fallback: '',
      maxTokens: 16000,
      timeoutMs: SUMMARY_TIMEOUT_MS
    });

    const guarded = clampSummary(generated);
    if (guarded) {
      summary = guarded;
    }
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

  // L'intégralité de l'histoire part en pièce jointe: rien n'est perdu même
  // quand le résumé est écourté par le garde-fou.
  const payload = { embeds: [endEmbed] };
  if (transcript) {
    payload.files = [{
      attachment: Buffer.from(`Thème: ${story.theme}\n\n${transcript}\n`, 'utf8'),
      name: 'histoire-complete.txt'
    }];
  }

  // Envoyer dans le salon bibliothèque
  const storyLibraryChannelId = await getChannelForFeature('story_library', 'storyLibraryChannelId', config);

  if (storyLibraryChannelId) {
    try {
      const libraryChannel = await client.channels.fetch(storyLibraryChannelId);
      if (libraryChannel) {
        await libraryChannel.send(payload);
      }
    } catch (err) {
      console.error('Erreur envoi bibliothèque:', err);
      // Fallback: envoyer dans le canal courant
      await channel.send(payload);
    }
  } else {
    // Si pas de config, envoyer dans le canal courant
    await channel.send(payload);
  }

  // Save to database with timestamp, et marquer la session comme terminée pour
  // qu'elle ne soit pas ressuscitée au prochain démarrage.
  await runQuery(
    `UPDATE story_sessions SET phrases = ?, contributors = ?, phrase_count = ?, finished_at = ? WHERE channel_id = ?`,
    [
      JSON.stringify(story.phrases),
      JSON.stringify(story.contributors),
      story.phrases.length,
      new Date().toISOString(),
      channel.id
    ]
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

  // Compte les phrases. La ponctuation répétée ("!!!", "...") ou décimale
  // ("3.5") ne doit pas compter pour plusieurs phrases.
  const phraseCount = (message.content.match(/[.!?]+(?=\s|$)/g) || []).length || 1;

  if (phraseCount > 3) {
    const reminder = await storyLine(
      `Un joueur a écrit ${phraseCount} phrases alors que la limite est de 3 par tour. Rappelle-lui la limite.`,
      `⚠️ ${phraseCount} phrases d'un coup, la limite est de 3 par tour!`
    );
    await message.reply(reminder);
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
  if (story.phrases.length >= MAX_STORY_PHRASES) {
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

/**
 * Recharge en mémoire les histoires non terminées après un redémarrage.
 * Sans ça une partie en cours était perdue à chaque redéploiement.
 */
export async function restoreActiveStories(client) {
  let restored = 0;

  try {
    const rows = await allQuery('SELECT * FROM story_sessions WHERE finished_at IS NULL');

    for (const row of rows) {
      // Le salon peut avoir été supprimé entre deux démarrages.
      const channel = await client.channels.fetch(row.channel_id).catch(() => null);
      if (!channel) continue;

      activeStories.set(row.channel_id, {
        theme: row.theme,
        mode: row.mode || 'classic',
        phrases: safeJson(row.phrases, []),
        contributors: safeJson(row.contributors, []),
        roles: safeJson(row.roles, {}),
        waitingRoster: safeJson(row.waiting_roster, {}),
        lastContributorId: row.last_contributor_id || null,
        startedAt: row.started_at,
        isWaiting: row.is_waiting ? 1 : 0
      });
      restored++;
    }
  } catch (err) {
    console.error('❌ Erreur restauration des histoires:', err.message);
  }

  return restored;
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
