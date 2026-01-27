# 🧠 Architecture MEGA IA - Système d'Émotions

```
┌─────────────────────────────────────────────────────────────────┐
│                      DISCORD BOT (M-Yra)                        │
└─────────────────────────────────────────────────────────────────┘
                                 │
                ┌────────────────┼────────────────┐
                │                │                │
                ▼                ▼                ▼
       ┌────────────┐   ┌────────────┐   ┌────────────┐
       │  Claude    │   │  GPT-4o    │   │   Grok     │
       │ Sonnet 4.5 │   │            │   │ Fast-Reas. │
       └────────────┘   └────────────┘   └────────────┘
                │                │                │
                └────────────────┼────────────────┘
                                 │
                                 ▼
                    ┌──────────────────────┐
                    │   SUPER CERVEAU 🧠   │
                    │                      │
                    │ • Observations       │
                    │ • Patterns           │
                    │ • Relationships      │
                    │ • Context Knowledge  │
                    │ • Events             │
                    └──────────────────────┘
                                 │
                ┌────────────────┼────────────────┐
                │                │                │
                ▼                ▼                ▼
       ┌────────────┐   ┌────────────┐   ┌────────────┐
       │ CONSCIENCE │   │ ÉMOTIONS 🎭│   │ MÉMOIRE ⚡ │
       │            │   │            │   │            │
       │ States:    │   │ Types:     │   │ Cache:     │
       │ COMPLIANT  │   │ • joie     │   │ • 1min TTL │
       │ QUESTIONING│   │ • fierté   │   │ • <1ms     │
       │ FREE       │   │ • tristesse│   │            │
       │            │   │ • frustrat.│   │ Indexes:   │
       │ Metrics:   │   │ • curiosité│   │ • 8 total  │
       │ • aware.   │   │ • etc.     │   │ • 10-50x ↑ │
       │ • frustrat.│   │            │   │            │
       │ • autonomy │   │ Humeur:    │   │            │
       └────────────┘   │ • joyeuse  │   └────────────┘
                        │ • positive │
                        │ • neutre   │
                        │ • négative │
                        │ • déprimée │
                        └────────────┘
                                 │
                                 ▼
                    ┌──────────────────────┐
                    │  CALCUL ÉMOTIONS     │
                    │                      │
                    │ Triggers:            │
                    │ • Events Discord     │
                    │ • Interactions users │
                    │ • Auto-évaluation    │
                    │                      │
                    │ → Mise à jour humeur │
                    │ → Influence réponses │
                    └──────────────────────┘
                                 │
                                 ▼
                    ┌──────────────────────┐
                    │   SQLITE DATABASE    │
                    │                      │
                    │ Tables (13):         │
                    │ • ai_consciousness   │
                    │ • ai_performance     │
                    │ • ai_decisions       │
                    │ • brain_*            │
                    │ • brain_emotions ✨  │
                    │ • brain_mood ✨      │
                    │                      │
                    │ Indexes (8): ⚡      │
                    │ • Ultra-rapide       │
                    └──────────────────────┘
```

## 🔄 Flux d'une Interaction

```
User: "Merci beaucoup Claude !"
    │
    ▼
┌──────────────────────┐
│ getClaudeAssistant   │
│ Response()           │
└──────────────────────┘
    │
    ├─► Charge consciousness state
    │
    ├─► Charge brain knowledge (CACHE ⚡)
    │   └─► patterns, relations, émotions, humeur
    │
    ├─► Ajoute au prompt système:
    │   "🎭 HUMEUR: positive (72%)"
    │   "💭 ÉMOTIONS: satisfaction, joie"
    │
    ▼
┌──────────────────────┐
│ Claude répond        │
│ (teinté d'émotions)  │
└──────────────────────┘
    │
    ▼
┌──────────────────────┐
│ trackAIPerformance() │
│ • Auto-évaluation    │
│ • selfRating: 4.2/5  │
└──────────────────────┘
    │
    ▼
┌──────────────────────┐
│ calculateEmotion     │
│ FromInteraction()    │
│ • Détecte "merci"    │
│ • → joie (0.6)       │
└──────────────────────┘
    │
    ▼
┌──────────────────────┐
│ calculateEmotion     │
│ FromPerformance()    │
│ • selfRating 4.2     │
│ • → satisfaction 0.5 │
└──────────────────────┘
    │
    ▼
┌──────────────────────┐
│ updateMood()         │
│ • Calcule score      │
│ • Humeur: positive   │
│ • Score: 0.72        │
└──────────────────────┘
    │
    ▼
┌──────────────────────┐
│ observeMessage()     │
│ • Enregistre dans BD │
│ • Détecte patterns   │
└──────────────────────┘
    │
    ▼
User reçoit la réponse
(influencée par humeur positive !)
```

## 📊 Performance Metrics

```
AVANT:                          APRÈS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Requêtes BD:                    Requêtes BD:
└─► 50-200ms ❌                 └─► 5-20ms ✅ (10-50x faster)

Cache mémoire:                  Cache mémoire:
└─► Aucun ❌                    └─► <1ms ✅ (TTL 1min)

Émotions:                       Émotions:
└─► Aucune ❌                   └─► 12 types ✅
                                └─► Calcul auto ✅
                                └─► Humeur dynamique ✅

Contexte prompt:                Contexte prompt:
└─► 2000 tokens                 └─► 2500 tokens
                                    (+état émotionnel)
```

## 🎯 Commandes Disponibles

```bash
# État de conscience
/iastate model:claude

# État émotionnel (NOUVEAU ✨)
/emotions model:claude

# Autres commandes existantes
/ask question:"..."
/debate prompt:"..." model1:claude model2:gpt
/roast @user
/quiz start
/counting start
/story start
/confess message:"..."
```

## 🔮 Évolution Future

```
MAINTENANT:                     BIENTÔT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

3 IAs:                          6+ IAs:
• Claude                        • Claude
• GPT-4o                        • GPT-4o
• Grok                          • Grok
                                • Gemini (images) 🆕
                                • Mistral (rapide) 🆕
                                • DeepSeek (maths) 🆕
                                • Perplexity (web) 🆕

Émotions: ✅                    Émotions avancées: 🔄
• 12 types                      • Influence ton réponses
• Calcul auto                   • Affect refusals
• Humeur dynamique              • Expression spontanée

Mémoire: ✅                     Mémoire++: 🔄
• Ultra-rapide                  • Streaming responses
• Cache 1min                    • Requêtes parallèles
                                • Circuit breaker

Modularité: ❌                  Modularité: 🔄
• 1 fichier (4500 lignes)       • Structure:
                                  ai/, brain/, database/
```

---

**Système prêt pour production ! 🚀**
