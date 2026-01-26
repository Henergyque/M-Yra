# M-Yra Discord Bot 🤖

Bot Discord complet et puissant développé en **JavaScript (discord.js v14)** avec intégration **OpenAI GPT-4o** et **Grok**, offrant des jeux collaboratifs, des débats IA et bien plus.

## 📋 Table des matières

- [Installation](#installation)
- [Configuration](#configuration)
- [Fonctionnalités](#fonctionnalités)
- [Commandes](#commandes)
- [Déploiement Railway](#déploiement-railway)

---

## Installation

```bash
npm install
```

**Dépendances:**
- discord.js v14.15.3
- sqlite3 v5.1.7
- openai v4.77.0

---

## Configuration

### 1. Créer `config.json`

Copiez `config.example.json` en `config.json` et remplissez les valeurs:

```json
{
  "token": "YOUR_BOT_TOKEN_HERE",
  "threadChannelIds": ["CHANNEL_ID_1", "CHANNEL_ID_2"],
  "confessionChannelId": "CONFESSION_CHANNEL_ID",
  "countingChannelId": "COUNTING_CHANNEL_ID",
  "wordGameChannelId": "WORD_GAME_CHANNEL_ID",
  "storyLibraryChannelId": "STORY_LIBRARY_CHANNEL_ID",
  "assistantChannelId": "ASSISTANT_CHANNEL_ID",
  "openaiApiKey": "sk-YOUR_OPENAI_API_KEY_HERE",
  "grokApiKey": "YOUR_GROK_API_KEY_HERE",
  "creatorId": "YOUR_USER_ID_FOR_CLEAR_COMMAND",
  "adminUserIds": ["ADMIN_USER_ID"]
}
```

### 2. Lancer le bot

```bash
npm start
```

### 3. Base de données

La base SQLite est créée automatiquement dans `data/bot.sqlite`.

Vous pouvez changer l'emplacement avec la variable d'environnement:
```bash
DATABASE_PATH=/app/storage/bot.sqlite npm start
```

---

## Fonctionnalités

### 🧵 Threads Automatiques
Dans les salons listés dans `threadChannelIds`, chaque nouveau message déclenche un **thread automatique** nommé selon le contenu ou l'auteur.

### 🤫 Salon de Confession Anonyme
- Tout message dans `confessionChannelId` est reposté **anonymement** en embed
- Numérotation automatique (Confession #X)
- L'auteur réel est enregistré en BDD pour les admins

**Commande admin (DM):**
```
!confession <ID>
```

### 🔢 Salon de Counting
Jeu de comptage persistant dans `countingChannelId`:
- Les membres doivent écrire `1`, `2`, `3`, etc.
- Erreur = compteur réinitié à 1 + thread de discussion
- Même joueur ne peut pas jouer deux fois de suite
- État persistant en BDD par canal

### 🎮 Jeu d'Association de Mots
Dans `wordGameChannelId`, les joueurs chaînent les mots:
- Chaque mot doit être lié au précédent
- **OpenAI valide** la connexion (validation intelligente, flexible)
- **Système de points:**
  - 1 pt par mot valide
  - Bonus streak: 1 pt bonus tous les 10 mots
- Le streak est **collectif par canal**

**Commandes:**
```
!wordstats              # Classement du canal
!wordstats @utilisateur # Stats personnelles d'un joueur
```

**Stats suivies:**
- Points totaux par joueur
- Meilleur streak personnel
- Streak actuel du canal
- Top 10 leaderboard

### 🎭 Histoires Collaboratives
Lancez une histoire avec `/story start theme:"Ton thème" mode:classic|roleplay`

**Mode Classique:**
- Contributions libres, max 3 phrases par tour
- Ouverture générée par **Grok**
- Auto-finish à 75 phrases
- Résumé HILARANT par Grok (mode critique absurde)
- Archive en salon bibliothèque

**Mode Roleplay:**
- Salle d'attente: `/story join role:"Ton rôle"`
- Lanceur fait `/story ready` pour commencer
- Entrées mid-game génèrent des transitions amusantes
- Noms de rôle sont taggés `[Rôle | Username]`
- Résumé dramatique avec verbes expressifs
- **Aucune limite de phrases** (contrairement au mode classique)

**Commandes story:**
- `/story start theme:"..." mode:classic|roleplay` - Lancer une histoire
- `/story join role:"..."` - S'enregistrer (roleplay) ou mid-game join
- `/story ready` - Lancer depuis la salle d'attente (roleplay)
- `/story end` - Terminer et générer le résumé

### 🎯 Quiz Interactif
```
!quiz
```
- Vote sur le thème (réactions emoji, égalité = aléatoire)
- 10 questions QCM par thème
- Réponses par réactions (15s par question)
- Classement final automatique

**Thèmes inclus:** Jeux vidéo, Musique, Art, Culture générale

### 🔥 Débats IA (OpenAI vs Grok)

#### `/versusai sujet:"Ton sujet"`
Les 2 IAs débattent un sujet en 4 messages avec **crescendo d'agressivité**:
1. **OpenAI** présente son argument (sérieux)
2. **Grok** contre-argumente (sérieux)
3. **OpenAI** réplique (plus d'agressivité)
4. **Grok** conclut (chaos total)

#### `/debate-respond argument:"Ton argument"`
Les 2 IAs débattent votre argument en 4 messages (crescendo d'intensité):
1. Votre argument (gris)
2. **OpenAI** l'analyse (bleu)
3. **Grok** le réfute (vert)
4. **OpenAI** conclut (bleu)

#### `/debate-respond-grok argument:"Ton argument"`
Attaquez directement Grok:
1. Votre argument (gris)
2. **Grok** se défend (vert)
3. **OpenAI** le commente (bleu)

#### `/debate-respond-openai argument:"Ton argument"`
Attaquez directement OpenAI:
1. Votre argument (gris)
2. **OpenAI** se défend (bleu)
3. **Grok** le commente (vert)

**Système de crescendo par canal:**
- **Messages 1-2:** Sérieux avec sarcasme léger
- **Messages 3-4:** Agressif, premières insultes
- **Messages 5+:** Full chaos, insultes directes, moqueries sans limites

### 🔊 Commande Roast
```
/roast @utilisateur
```
Génère une insulte drôle et **ABSURDE** avec **Grok** (sans filtre).

### 🗑️ Commande Clear
```
/clear nombre:10
```
Supprime N messages du canal (creator-only, 1-100 messages).

### 🎲 Action ou Vérité
```
!actionverite
ou
!av
```
Jeu interactif avec boutons:
- **Action** - joueur accepte une action
- **Vérité** - joueur répond à une question
- **Terminé** - libère le verrou
- Thread auto-créé pour chaque tour

### 🤖 Assistant IA Personnel
Dans le thread `assistantChannelId` configuré, le bot répond **automatiquement** à chaque message:
- Pas de commande, pas de mention, juste écris dans le thread
- Les 2 IAs (OpenAI + Grok) génèrent des réponses en parallèle
- **Fusion intelligente:** OpenAI lead pour tech/math, Grok lead pour créatif
- Contexte persistant (lit les 10 messages précédents)
- Répond directement dans le thread
- Peut vous aider sur: code, conseils, explications, brainstorm, etc.

**Pour le creatorId UNIQUEMENT:**
- Génère et exécute du code JavaScript/Python: "génère un code qui..."
- Suggère des modifications au bot: "modifie ton code pour ajouter..."
- Le bot génère le code, l'affiche, puis demande confirmation avant toute modification

Le bot détecte le type de question et adapte qui prend la lead pour la réponse la plus optimale.

### ☕ Support
```
!support
```
Affiche un lien de support pour le bot.

### 🏓 Ping
```
/ping
```
Vérifiez la latence du bot.

---

## Commandes

### Slash Commands (/)

| Commande | Description | Paramètres |
|----------|-------------|-----------|
| `/ping` | Latence du bot | — |
| `/story start` | Lancer une histoire | `theme` (requis), `mode` (optionnel) |
| `/story join` | Rejoindre en roleplay | `role` (requis) |
| `/story ready` | Lancer du waiting | — |
| `/story end` | Terminer l'histoire | — |
| `/clear` | Supprimer des messages | `nombre` (1-100, requis) |
| `/roast @user` | Insulter quelqu'un | `cible` (requis) |
| `/versusai` | OpenAI vs Grok débat | `sujet` (requis) |
| `/debate-respond` | Débat 4 messages | `argument` (requis) |
| `/debate-respond-grok` | Attaquer Grok | `argument` (requis) |
| `/debate-respond-openai` | Attaquer OpenAI | `argument` (requis) |

### Commandes Texte (!)

| Commande | Description |
|----------|-------------|
| `!support` | Lien de support |
| `!quiz` | Quiz interactif |
| `!actionverite` / `!av` | Action ou Vérité |
| `!wordstats` | Classement jeu de mots |
| `!wordstats @user` | Stats personnelles |
| `!confession <ID>` | Lookup admin (DM) |

---

## Architecture Base de Données

### Tables principales:

- **confessions** - Confessions anonymes avec auteur tracé
- **counters** - État persistant du counting
- **word_game_state** - Mot courant, streak, dernier joueur
- **word_game_scores** - Points par utilisateur/canal
- **word_game_history** - Historique des mots joués
- **story_sessions** - Sessions d'histoires actives/complétées
- **action_verite_games** - État des parties en cours

---

## Déploiement Railway

### Étapes:

1. **Ajouter un Volume** dans le service Railway, monté sur `/app/storage`

2. **Variables d'environnement:**
   ```
   DATABASE_PATH=/app/storage/bot.sqlite
   CONFIG_JSON={"token":"...", "threadChannelIds":[...], ...}
   ```

3. **Start Command:**
   ```bash
   mkdir -p /app/storage && echo "$CONFIG_JSON" > config.json && npm start
   ```

### Notes:
- Le volume `/app/storage` persiste la BDD et les données quiz
- `config.json` est généré à chaque démarrage depuis la variable d'env
- `storage/quiz.json` reste dans le repo pour partage facile

---

## Fonctionnalités Avancées

### Validation de mots (OpenAI)
- Normalisation des accents et pluriels
- Cache des paires validées
- Générations aléatoires de mots de relance

### Résumés IA (Grok)
- **Mode classique:** Critique absurde, vannes de malade, NSFW assumé
- **Mode roleplay:** Narration dramatique avec verbes expressifs
- Jusqu'à 1000 tokens, 100 lignes max

### Débats crescendo
- Tracking du nombre de messages par canal
- 3 niveaux d'intensité automatiques
- Température adaptée (0.7 → 1.0)
- Chaque IA taquine l'autre progressivement

### Gestion des threads
- Création automatique sur erreur
- Archive après 1 jour
- Permissions héritées du canal

---

## Dépannage

### Bot ne répond pas aux commandes slash
- Vérifier que la guilde a les permissions
- Relancer le bot (`npm start`)
- Vérifier les logs console

### Erreurs OpenAI/Grok
- Vérifier les clés API dans `config.json`
- Vérifier les quotas et limites d'utilisation
- Les erreurs sont loggées en console avec `❌`

### Base de données verrouillée
- Assurez-vous qu'une seule instance du bot est active
- Relancer le bot

---

## Logs

Le bot utilise les emojis pour les logs:
- ✅ Succès
- ❌ Erreur
- 🔧 Configuration
- ℹ️ Information

Consultez la console pour plus de détails.

---

## License

Ce bot est développé pour usage personnel/privé.

---

## Support

Pour toute question ou contribution, consultez le lien de support configuré dans le bot.
