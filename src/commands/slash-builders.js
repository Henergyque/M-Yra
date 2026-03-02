import { SlashCommandBuilder } from 'discord.js';

export function buildSlashCommands() {
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

  commands.push(
    new SlashCommandBuilder()
      .setName('model')
      .setDescription('🤖 Forcer l\'utilisation d\'un modèle IA spécifique pour la prochaine réponse')
      .addStringOption(opt =>
        opt.setName('choice')
          .setDescription('Modèle à utiliser')
          .addChoices(
            { name: 'Opus (perfection)', value: 'opus' }
          )
          .setRequired(true)
      )
  );

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
                { name: 'Claude Opus (perfection)', value: 'opus' }
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

  commands.push(
    new SlashCommandBuilder()
      .setName('maintenance')
      .setDescription('🛠️ Activer ou désactiver la maintenance des jeux')
      .addStringOption(opt =>
        opt.setName('action')
          .setDescription('Action de maintenance')
          .addChoices(
            { name: 'Activer', value: 'on' },
            { name: 'Désactiver', value: 'off' },
            { name: 'Statut', value: 'status' }
          )
          .setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName('message')
          .setDescription('Message provisoire (optionnel, utilisé avec action=on)')
          .setRequired(false)
          .setMaxLength(500)
      )
  );

  commands.push(
    new SlashCommandBuilder()
      .setName('diagnostic')
      .setDescription('📊 Voir l\'état technique du bot (creator only)')
  );

  commands.push(
    new SlashCommandBuilder()
      .setName('memory-reset')
      .setDescription('🧨 Réinitialiser la mémoire du bot (creator only)')
      .addStringOption(opt =>
        opt.setName('mode')
          .setDescription('Portée du reset')
          .addChoices(
            { name: 'Complet (garde counting + word game + classements)', value: 'full_keep_games' }
          )
          .setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName('confirm')
          .setDescription('Tape RESET pour confirmer')
          .setRequired(true)
      )
  );

  commands.push(
    new SlashCommandBuilder()
      .setName('parler')
      .setDescription('🕶️ Envoyer un message via M-Yra (creator only)')
      .addStringOption(opt =>
        opt.setName('message')
          .setDescription('Message à envoyer')
          .setRequired(true)
          .setMaxLength(1900)
      )
      .addChannelOption(opt =>
        opt.setName('channel')
          .setDescription('Salon cible (optionnel)')
          .setRequired(false)
      )
  );

  commands.push(
    new SlashCommandBuilder()
      .setName('automod-simple')
      .setDescription('🛡️ Gérer une règle AutoMod simple (creator only)')
      .addStringOption(opt =>
        opt.setName('action')
          .setDescription('Action à exécuter')
          .addChoices(
            { name: 'Activer/Mettre à jour', value: 'setup' },
            { name: 'Désactiver', value: 'off' },
            { name: 'Statut', value: 'status' }
          )
          .setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName('mot')
          .setDescription('Mot-clé à bloquer (requis pour setup)')
          .setRequired(false)
          .setMaxLength(60)
      )
  );

  commands.push(
    new SlashCommandBuilder()
      .setName('jeu-moderation')
      .setDescription('🎮 Gérer sanctions jeux, whitelist et gages (owner)')
      .addSubcommand(sub =>
        sub.setName('sanction-status')
          .setDescription('Voir le statut sanction d\'un membre')
          .addUserOption(opt =>
            opt.setName('user')
              .setDescription('Membre cible')
              .setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub.setName('sanction-lift')
          .setDescription('Lever une sanction jeux')
          .addUserOption(opt =>
            opt.setName('user')
              .setDescription('Membre cible')
              .setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub.setName('whitelist-add')
          .setDescription('Ajouter un membre en whitelist')
          .addUserOption(opt =>
            opt.setName('user')
              .setDescription('Membre cible')
              .setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub.setName('whitelist-remove')
          .setDescription('Retirer un membre de la whitelist')
          .addUserOption(opt =>
            opt.setName('user')
              .setDescription('Membre cible')
              .setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub.setName('whitelist-status')
          .setDescription('Voir si un membre est en whitelist')
          .addUserOption(opt =>
            opt.setName('user')
              .setDescription('Membre cible')
              .setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub.setName('whitelist-list')
          .setDescription('Lister la whitelist')
      )
      .addSubcommand(sub =>
        sub.setName('gage-complete')
          .setDescription('Marquer un gage accompli et purger son suivi')
          .addUserOption(opt =>
            opt.setName('user')
              .setDescription('Membre cible')
              .setRequired(true)
          )
      )
  );

  return commands;
}
