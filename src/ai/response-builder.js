import { Logger } from '../utils/logger.js';
import { CircuitBreaker, retryWithBackoff, withTimeout, handleAPIError } from '../utils/error-handler.js';
import { RateLimiter } from '../utils/rate-limiter.js';
import { openai, grok, claude, geminiModel, mistral } from './clients.js';

const logger = new Logger('AI-RESPONSE-BUILDER');

// Concatène uniquement les blocs texte d'une réponse Claude (ignore les blocs
// server_tool_use / web_search_tool_result générés par la recherche web).
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
 * Unified AI Response Builder
 * Abstracts differences between 6 AI models into single interface
 */
export class AIResponseBuilder {
  constructor(config = {}) {
    this.config = config;
    this.circuitBreakers = new Map();
    this.rateLimiter = new RateLimiter(config.rateLimits);
    this.initializeBreakers();
  }

  initializeBreakers() {
    const models = ['opus', 'sonnet', 'mistral', 'grok', 'gemini', 'openai'];
    models.forEach(model => {
      this.circuitBreakers.set(model, new CircuitBreaker(model, 3, 60000));
    });
  }

  /**
   * Main: Get response from optimal model with fallback chain
   */
  async getResponse(message, options = {}) {
    const {
      model = 'opus',
      fallback = ['sonnet', 'mistral'],
      system = '',
      urgency = 'normal',
      context = {},
      maxTokens = 500,
      temperature = 0.7,
      enableWebSearch = false,
      onWebSearch = null
    } = options;

    const startTime = Date.now();

    try {
      // Check rate limits
      const { allowed, reason, fallbackTo } = this.rateLimiter.canMakeRequest(model, maxTokens);
      if (!allowed) {
        logger.warn(`Rate limit exceeded for ${model}`, { reason });
        if (fallbackTo) {
          return this.getResponse(message, { ...options, model: fallbackTo });
        }
      }

      // Get response with appropriate model
      logger.info(`Requesting ${model}`, { urgency, context });
      const response = await this.executeModelRequest(model, message, {
        system,
        maxTokens,
        temperature,
        urgency,
        enableWebSearch,
        onWebSearch
      });

      const responseTime = Date.now() - startTime;
      
      // Record metrics
      this.rateLimiter.recordUsage(model, response.tokens || 0, response.cost || 0);
      this.circuitBreakers.get(model).recordRoute?.(model, responseTime, true);

      logger.info(`${model} response complete`, {
        model,
        responseTime,
        tokens: response.tokens
      });

      return {
        content: response.content,
        model,
        tokens: response.tokens,
        cost: response.cost,
        usedWebSearch: Boolean(response.usedWebSearch),
        responseTime
      };

    } catch (error) {
      const responseTime = Date.now() - startTime;
      logger.error(`${model} failed`, { error: error.message, responseTime });

      this.circuitBreakers.get(model).recordRoute?.(model, responseTime, false);

      // Try fallback chain
      if (fallback && fallback.length > 0) {
        logger.info(`Trying fallback models: ${fallback.join(', ')}`);
        
        for (const fallbackModel of fallback) {
          try {
            return this.getResponse(message, {
              ...options,
              model: fallbackModel,
              fallback: fallback.filter(f => f !== fallbackModel)
            });
          } catch (fallbackError) {
            logger.warn(`Fallback ${fallbackModel} also failed`, { error: fallbackError.message });
          }
        }
      }

      // All models failed
      throw error;
    }
  }

  /**
   * Execute request specific to each model
   */
  async executeModelRequest(model, message, options) {
    const { system, maxTokens, temperature, urgency, enableWebSearch, onWebSearch } = options;

    // Apply timeout based on urgency. La recherche web prend du temps (aller
    // chercher + lire les sources + rédiger): on laisse une large marge (120s)
    // pour qu'elle ait le temps de chercher sans que la requête coupe avant la fin.
    const baseTimeout = urgency === 'critical' ? 10000 : 30000;
    const timeout = enableWebSearch ? Math.max(baseTimeout, 120000) : baseTimeout;

    const breaker = this.circuitBreakers.get(model);

    switch (model) {
      case 'opus':
      case 'sonnet':
        return this.executeClaudeRequest(model, message, { system, maxTokens, temperature, enableWebSearch, onWebSearch }, breaker, timeout);

      case 'mistral':
        return this.executeMistralRequest(message, { system, maxTokens, temperature }, breaker, timeout);

      case 'grok':
        return this.executeGrokRequest(message, { system, maxTokens, temperature }, breaker, timeout);

      case 'gemini':
        return this.executeGeminiRequest(message, { system, maxTokens, temperature }, breaker, timeout);

      case 'openai':
        return this.executeOpenAIRequest(message, { system, maxTokens, temperature }, breaker, timeout);

      default:
        throw new Error(`Unknown model: ${model}`);
    }
  }

  // ==================== CLAUDE ====================
  async executeClaudeRequest(model, message, options, breaker, timeout) {
    const { system, maxTokens, temperature, enableWebSearch, onWebSearch } = options;
    const claudeModel = model === 'opus' ? 'claude-opus-4-8' : 'claude-sonnet-4-5-20250929';
    // Opus 4.8 rejette temperature (400). On ne l'envoie que pour les modèles qui l'acceptent.
    const isOpus48 = claudeModel === 'claude-opus-4-8';
    // Recherche web native de Claude (Opus 4.8 uniquement).
    const useSearch = Boolean(enableWebSearch) && isOpus48;

    const baseParams = {
      model: claudeModel,
      max_tokens: maxTokens,
      ...(isOpus48 ? {} : { temperature }),
      system: system || 'Tu es un assistant IA utile et bienveillant.',
      messages: [
        { role: 'user', content: message }
      ]
    };

    return breaker.execute(
      async () => {
        return retryWithBackoff(
          async () => {
            // 1) Tentative avec recherche web (si activée). En cas d'indispo, on
            //    retombe proprement sur une réponse sans outil plutôt que d'échouer.
            if (useSearch) {
              try {
                return await this.runClaudeWithSearch(baseParams, onWebSearch, timeout, model);
              } catch (searchError) {
                logger.warn(`Recherche web indisponible, réponse sans recherche: ${searchError.message}`);
              }
            }

            // 2) Appel simple sans outil.
            const response = await withTimeout(
              claude.messages.create(baseParams),
              timeout,
              model
            );

            return {
              content: extractClaudeText(response.content),
              tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
              cost: this.calculateClaudeCost(response.usage?.input_tokens, response.usage?.output_tokens, model),
              usedWebSearch: false
            };
          },
          3,
          1000,
          model
        );
      },
      async () => {
        logger.warn(`${model} circuit open, would try fallback`);
        return null;
      }
    );
  }

  // Appel Claude avec l'outil web_search natif. On stream pour détecter le
  // moment exact où Claude lance une recherche (déclenche l'indicateur
  // "recherche en cours"), puis on récupère la réponse finale.
  async runClaudeWithSearch(baseParams, onWebSearch, timeout, model) {
    const params = {
      ...baseParams,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]
    };

    let searchNotified = false;
    const stream = claude.messages.stream(params);
    stream.on('streamEvent', (event) => {
      if (
        !searchNotified &&
        event?.type === 'content_block_start' &&
        event.content_block?.type === 'server_tool_use' &&
        event.content_block?.name === 'web_search'
      ) {
        searchNotified = true;
        try {
          onWebSearch?.();
        } catch {
          // L'indicateur est best-effort, on n'interrompt jamais la réponse.
        }
      }
    });

    let finalMsg = await withTimeout(stream.finalMessage(), timeout, model);

    // Reprise si le serveur met le tour en pause (boucle d'outils longue).
    let guard = 0;
    let history = [{ role: 'user', content: baseParams.messages[0].content }];
    while (finalMsg?.stop_reason === 'pause_turn' && guard < 2) {
      guard += 1;
      history = [...history, { role: 'assistant', content: finalMsg.content }];
      finalMsg = await withTimeout(
        claude.messages.create({ ...params, messages: history }),
        timeout,
        model
      );
    }

    const usedWebSearch = searchNotified || (Array.isArray(finalMsg?.content) && finalMsg.content.some(
      block => (block.type === 'server_tool_use' && block.name === 'web_search') || block.type === 'web_search_tool_result'
    ));

    return {
      content: extractClaudeText(finalMsg?.content),
      tokens: (finalMsg?.usage?.input_tokens || 0) + (finalMsg?.usage?.output_tokens || 0),
      cost: this.calculateClaudeCost(finalMsg?.usage?.input_tokens, finalMsg?.usage?.output_tokens, model),
      usedWebSearch
    };
  }

  calculateClaudeCost(inputTokens, outputTokens, model) {
    // Tarifs Anthropic: Opus 4.8 = $5/$25 par million, Sonnet = $3/$15 par million
    const pricing = {
      'opus': { input: 0.000005, output: 0.000025 },
      'sonnet': { input: 0.000003, output: 0.000015 }
    };
    const prices = pricing[model] || pricing.sonnet;
    return (inputTokens * prices.input) + (outputTokens * prices.output);
  }

  // ==================== MISTRAL ====================
  async executeMistralRequest(message, options, breaker, timeout) {
    const { system, maxTokens, temperature } = options;

    return breaker.execute(
      async () => {
        return retryWithBackoff(
          async () => {
            const response = await withTimeout(
              mistral.chat.complete({
                model: 'mistral-large-latest',
                temperature,
                max_tokens: maxTokens,
                messages: [
                  { role: 'user', content: message }
                ]
              }),
              timeout,
              'mistral'
            );

            return {
              content: response.choices[0]?.message?.content || '',
              tokens: response.usage?.total_tokens || 0,
              cost: (response.usage?.total_tokens || 0) * 0.000001 // ~$1 per 1M tokens
            };
          },
          3,
          1000,
          'mistral'
        );
      }
    );
  }

  // ==================== GROK ====================
  async executeGrokRequest(message, options, breaker, timeout) {
    const { system, maxTokens, temperature } = options;

    return breaker.execute(
      async () => {
        return retryWithBackoff(
          async () => {
            const response = await withTimeout(
              grok.chat.completions.create({
                model: 'grok-4-1-fast-reasoning',
                temperature,
                max_tokens: maxTokens,
                messages: [
                  { role: 'user', content: message }
                ]
              }),
              timeout,
              'grok'
            );

            return {
              content: response.choices[0]?.message?.content || '',
              tokens: response.usage?.total_tokens || 0,
              cost: (response.usage?.total_tokens || 0) * 0.000005 // Estimated
            };
          },
          3,
          1000,
          'grok'
        );
      }
    );
  }

  // ==================== GEMINI ====================
  async executeGeminiRequest(message, options, breaker, timeout) {
    const { system, maxTokens, temperature } = options;

    return breaker.execute(
      async () => {
        return retryWithBackoff(
          async () => {
            const response = await withTimeout(
              geminiModel.generateContent({
                contents: [{
                  parts: [{ text: message }]
                }],
                generationConfig: {
                  maxOutputTokens: maxTokens,
                  temperature
                }
              }),
              timeout,
              'gemini'
            );

            const text = response.response?.text() || '';
            return {
              content: text,
              tokens: 0, // Gemini doesn't expose token count in free tier
              cost: 0 // Free tier
            };
          },
          3,
          1000,
          'gemini'
        );
      }
    );
  }

  // ==================== OPENAI ====================
  async executeOpenAIRequest(message, options, breaker, timeout) {
    const { system, maxTokens, temperature } = options;

    return breaker.execute(
      async () => {
        return retryWithBackoff(
          async () => {
            const response = await withTimeout(
              openai.chat.completions.create({
                model: 'gpt-5.2',
                temperature,
                max_tokens: maxTokens,
                system: system || 'Tu es un assistant IA utile.',
                messages: [
                  { role: 'user', content: message }
                ]
              }),
              timeout,
              'openai'
            );

            return {
              content: response.choices[0]?.message?.content || '',
              tokens: (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0),
              cost: this.calculateOpenAICost(response.usage?.prompt_tokens, response.usage?.completion_tokens)
            };
          },
          3,
          1000,
          'openai'
        );
      }
    );
  }

  calculateOpenAICost(inputTokens, outputTokens) {
    // GPT-4o pricing (2025)
    return (inputTokens * 0.00000500) + (outputTokens * 0.00001500);
  }

  /**
   * Get stats about all models
   */
  getStats() {
    return {
      rateLimits: this.rateLimiter.getAllStats(),
      circuitBreakers: Array.from(this.circuitBreakers.entries()).map(([model, breaker]) => ({
        model,
        ...breaker.getState()
      }))
    };
  }
}

// Global instance
export const aiResponseBuilder = new AIResponseBuilder();
