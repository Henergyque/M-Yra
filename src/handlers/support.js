const supportLink = 'https://buymeacoffee.com/henergyque';
const supportMessage = `Si tu veux soutenir le bot, voici un petit café ☕ : ${supportLink}`;

export async function handleSupportCommand(message) {
  if (message.content.trim() !== '!support') {
    return false;
  }

  await message.channel.send(supportMessage);
  return true;
}
