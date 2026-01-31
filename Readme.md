# M-Yra AI Bot

Multi-AI Discord bot with games, consciousness simulation, and intelligent routing.

## Setup

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your API keys
# Then install and run
npm install
npm start
```

## Structure

- `src/` - Core bot code
- `src/ai/` - AI models and routing
- `src/utils/` - Utilities (logger, cache, rate-limiter, etc.)
- `src/games/` - Game logic
- `src/database/` - Database and migrations
- `src/commands/` - Command registry
- `data/` - Static data
- `storage/` - Persistent data (SQLite)

## Environment Variables

Copy `.env.example` to `.env` and fill in:
- Discord bot token
- AI API keys (Claude, OpenAI, Mistral, Grok, Perplexity, Gemini)
- Database paths

## Development

```bash
npm start          # Run bot
npm test           # Run tests (when available)
npm run lint       # Lint code
```
