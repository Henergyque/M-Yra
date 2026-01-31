import { ChannelType, EmbedBuilder } from 'discord.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const quizDataPath = path.join(__dirname, '..', '..', 'storage', 'quiz.json');
const quizFallbackPath = path.join(__dirname, '..', '..', 'storage', 'quiz.example.json');
const quizDataSource = fs.existsSync(quizDataPath) ? quizDataPath : quizFallbackPath;

if (!fs.existsSync(quizDataSource)) {
  throw new Error('Missing quiz data. Provide storage/quiz.json or storage/quiz.example.json.');
}

const quizThemes = JSON.parse(fs.readFileSync(quizDataSource, 'utf-8')).themes;
const quizThemeEmojis = ['🎮', '🎵', '🎨', '🌍'];
const quizAnswerEmojis = ['🇦', '🇧', '🇨', '🇩'];
const quizQuestionCount = 10;
const quizVoteDurationMs = 20000;
const quizQuestionDurationMs = 15000;

let activeQuiz = null;

function createQuizThemeEmbed() {
  const description = quizThemes
    .map((theme, index) => `${quizThemeEmojis[index]} **${theme.name}**`)
    .join('\n');
  return new EmbedBuilder()
    .setTitle('Quiz - Choisissez le thème')
    .setDescription(description)
    .setColor(0x5dade2)
    .setFooter({ text: 'Réagissez pour voter (égalité → aléatoire).' })
    .setTimestamp();
}

function createQuizQuestionEmbed(themeName, questionIndex, question) {
  const options = question.options
    .map((option, index) => `${quizAnswerEmojis[index]} ${option}`)
    .join('\n');
  return new EmbedBuilder()
    .setTitle(`Quiz - ${themeName}`)
    .setDescription(`**Question ${questionIndex + 1} / ${quizQuestionCount}**\n${question.question}\n\n${options}`)
    .setColor(0x45b39d)
    .setFooter({ text: `Temps limité : ${quizQuestionDurationMs / 1000}s` })
    .setTimestamp();
}

function createQuizLeaderboardEmbed(scores) {
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const lines = sorted.length
    ? sorted.map(([userId, score], index) => `**${index + 1}.** <@${userId}> — ${score} pt(s)`).join('\n')
    : 'Aucun point marqué.';
  return new EmbedBuilder()
    .setTitle('Quiz - Classement final')
    .setDescription(lines)
    .setColor(0xf7dc6f)
    .setTimestamp();
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export async function handleQuizCommand(message) {
  if (!message.guild || message.channel.type !== ChannelType.GuildText) {
    return false;
  }

  if (message.content.trim() !== '!quiz') {
    return false;
  }

  if (activeQuiz) {
    await message.channel.send('Un quiz est déjà en cours. Merci d\'attendre la fin de la session.');
    return true;
  }

  activeQuiz = { channelId: message.channel.id };

  const themeMessage = await message.channel.send({ embeds: [createQuizThemeEmbed()] });
  for (const emoji of quizThemeEmojis) {
    await themeMessage.react(emoji);
  }

  const themeCollector = themeMessage.createReactionCollector({
    time: quizVoteDurationMs
  });

  await new Promise((resolve) => themeCollector.on('end', resolve));

  const themeVotes = quizThemes.map(() => 0);
  for (let index = 0; index < quizThemeEmojis.length; index += 1) {
    const reaction = themeMessage.reactions.cache.get(quizThemeEmojis[index]);
    if (!reaction) {
      continue;
    }
    const users = await reaction.users.fetch();
    themeVotes[index] = users.filter((user) => !user.bot).size;
  }

  const maxVotes = Math.max(...themeVotes);
  const topThemes = themeVotes
    .map((votes, index) => ({ votes, index }))
    .filter(({ votes }) => votes === maxVotes);
  const selectedThemeIndex =
    topThemes[Math.floor(Math.random() * topThemes.length)].index;
  const selectedTheme = quizThemes[selectedThemeIndex];

  await message.channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle('Quiz - Thème sélectionné')
        .setDescription(`${quizThemeEmojis[selectedThemeIndex]} **${selectedTheme.name}**`)
        .setColor(0x5dade2)
        .setTimestamp()
    ]
  });

  const scores = new Map();
  const questions = shuffle(selectedTheme.questions).slice(0, quizQuestionCount);

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const questionMessage = await message.channel.send({
      embeds: [createQuizQuestionEmbed(selectedTheme.name, index, question)]
    });

    const answersToReact = quizAnswerEmojis.slice(0, question.options.length);
    for (const emoji of answersToReact) {
      await questionMessage.react(emoji);
    }

    const questionCollector = questionMessage.createReactionCollector({
      time: quizQuestionDurationMs
    });

    await new Promise((resolve) => questionCollector.on('end', resolve));

    const correctEmoji = quizAnswerEmojis[question.correctIndex];
    const correctReaction = questionMessage.reactions.cache.get(correctEmoji);
    if (correctReaction) {
      const users = await correctReaction.users.fetch();
      for (const user of users.values()) {
        if (user.bot) {
          continue;
        }
        scores.set(user.id, (scores.get(user.id) ?? 0) + 1);
      }
    }
  }

  await message.channel.send({ embeds: [createQuizLeaderboardEmbed(scores)] });
  activeQuiz = null;
  return true;
}

export function getActiveQuiz() {
  return activeQuiz;
}
