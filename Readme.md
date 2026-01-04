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

Le compteur est persistant dans SQLite.
