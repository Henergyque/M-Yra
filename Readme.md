# M-Yra Discord Bot

Bot Discord en **JavaScript (discord.js)** avec :
- création automatique de fils (threads) par salon
- salon de confession anonyme avec traçabilité interne
- salon de counting (jeu de comptage) persistant

## Installation

```bash
npm install
```

## Configuration

1. Copiez le fichier `config.example.json` en `config.json`.
2. Renseignez les IDs et le token.

```json
{
  "token": "YOUR_BOT_TOKEN",
  "threadChannelIds": ["123456789012345678"],
  "confessionChannelId": "234567890123456789",
  "countingChannelId": "345678901234567890",
  "adminUserIds": ["456789012345678901"]
}
```

## Lancer le bot

```bash
npm start
```

## Persistance

La base SQLite est créée automatiquement dans `data/bot.sqlite`.
Vous pouvez changer l'emplacement avec la variable d'environnement `DATABASE_PATH`.

Exemple :
```bash
DATABASE_PATH=/app/storage/bot.sqlite npm start
```

## Quiz data

Le quiz est chargé depuis `storage/quiz.json`. Vous pouvez copier `storage/quiz.example.json`
et adapter les thèmes/questions.

## Déploiement Railway (option B recommandée)

Pour garder `storage/` dans le repo (quiz) et stocker SQLite ailleurs :

1. **Ajouter un volume** dans le service Railway et le monter sur :
   ```
   /app/storage
   ```
2. **Ajouter une variable** `DATABASE_PATH` :
   ```
   /app/storage/bot.sqlite
   ```
3. **Ajouter une variable** `CONFIG_JSON` avec le contenu complet de votre `config.json`.
4. **Start Command** Railway :
   ```bash
   mkdir -p /app/storage && echo "$CONFIG_JSON" > config.json && npm start
   ```

Le bot utilisera le volume pour SQLite sans masquer `storage/quiz.json`.

## Fonctionnalités

### Threads automatiques
Dans les salons listés dans `threadChannelIds`, chaque nouveau message déclenche un thread attaché au message, avec un nom dérivé du contenu ou de l’auteur.

### Salon de confession
Dans le salon configuré via `confessionChannelId`, tout message est reposté anonymement sous forme d’embed :

- titre : "Confession anonyme"
- numéro automatique (Confession #X)
- couleur personnalisée

L’auteur réel est stocké dans SQLite et n’est pas visible des membres.

### Commande privée pour le gérant
Le gérant (ID dans `adminUserIds`) peut demander l’auteur d’une confession via un **message privé** au bot :

```
!confession <ID>
```

### Salon de counting
Dans `countingChannelId`, les membres doivent écrire `1`, puis `2`, etc. Si une erreur est détectée :
- le bot mentionne l’auteur fautif
- un thread est créé automatiquement à partir du message erroné
- le compteur repart à 1

Le même membre ne peut pas jouer deux fois de suite.

Le compteur est persistant dans SQLite, séparé par salon de counting.

### Quiz
Lancez un quiz avec la commande :

```
!quiz
```

Déroulement :
- le bot propose 4 thèmes via un embed (jeux vidéo, musique, art, culture générale)
- vote par réactions (égalité → aléatoire)
- 10 questions QCM, réponses par réactions, temps limité
- classement final avec points par joueur

Contraintes :
- une seule session active à la fois
- réponses par réactions uniquement

## Soutenir le bot

Si vous voulez soutenir le projet, vous pouvez offrir un café :
https://buymeacoffee.com/henergyque
