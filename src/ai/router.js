import { Logger } from '../utils/logger.js';
import { mistral } from './clients.js';

const logger = new Logger('AI-ROUTER');

/**
 * Intelligent AI Model Router
 * Routes requests to optimal model based on semantic intent detection
 * NO KEYWORD TRIGGERS - Pure natural language understanding
 */
export class AIRouter {
  constructor(config = {}) {
    this.config = config;
    this.routingMetrics = new Map();
    this.intentCache = new Map(); // Cache intent detection for performance
    this.initializeMetrics();
  }

  initializeMetrics() {
    const models = ['opus', 'sonnet', 'mistral', 'grok', 'gemini', 'perplexity', 'openai'];
    models.forEach(model => {
      this.routingMetrics.set(model, {
        routedCount: 0,
        avgResponseTime: 0,
        successCount: 0,
        failureCount: 0
      });
    });
  }

  /**
   * Detect user intent using semantic analysis
   * Returns: { intent, confidence, reasoning }
   */
  async detectIntent(message, context = {}) {
    // Check cache first (for repeated similar messages)
    const cacheKey = `${message.substring(0, 50)}_${context.hasAttachments}_${context.messageLength}`;
    if (this.intentCache.has(cacheKey)) {
      return this.intentCache.get(cacheKey);
    }

    try {
      // Build context description
      const contextDesc = [
        context.hasAttachments ? 'Message has image/file attachments' : '',
        context.messageLength > 500 ? 'Long message (detailed)' : '',
        context.messageLength < 30 ? 'Very short message' : '',
        context.mentions?.length > 0 ? 'Mentions other users' : '',
        context.urgency === 'critical' ? 'Marked as urgent' : ''
      ].filter(Boolean).join('. ');

      const prompt = `Analyze this Discord message and detect the user's intent. Respond ONLY with JSON format:
{
  "intent": "one of: research, image_analysis, humor, debate, story, quiz, word_game, counting, action_game, code_help, quick_chat, general",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}

Message: "${message}"
${contextDesc ? `Context: ${contextDesc}` : ''}

Consider:
- Attachments suggest image_analysis
- Questions about facts/news suggest research
- Creative/narrative style suggests story
- Highly expressive language suggests humor or general
- Sarcasm/jokes suggest humor
- Argumentative tone suggests debate
- Technical/code mentions suggest code_help
- Very short casual messages suggest quick_chat

Respond with JSON only, no other text.`;

      const response = await mistral.chat.complete({
        model: 'mistral-small-latest', // Fast model for intent detection
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1, // Low temp for consistent detection
        max_tokens: 150
      });

      const content = response.choices[0].message.content.trim();
      
      // Extract JSON (handle markdown code blocks)
      let jsonStr = content;
      if (content.includes('```')) {
        jsonStr = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)?.[1] || content;
      }
      
      const result = JSON.parse(jsonStr);
      
      // Cache result
      if (this.intentCache.size > 100) {
        // Clear oldest entries
        const firstKey = this.intentCache.keys().next().value;
        this.intentCache.delete(firstKey);
      }
      this.intentCache.set(cacheKey, result);
      
      logger.debug('Intent detected', result);
      return result;

    } catch (error) {
      logger.error('Intent detection failed, using fallback heuristics', error);
      return this.fallbackIntentDetection(message, context);
    }
  }

  /**
   * Fallback intent detection using simple heuristics
   * Used when AI-based detection fails
   */
  fallbackIntentDetection(message, context) {
    const msg = message.toLowerCase();
    
    // Hard constraints (always reliable)
    if (context.hasAttachments) {
      return { intent: 'image_analysis', confidence: 0.95, reasoning: 'Has attachments' };
    }
    
    if (context.messageLength > 1000) {
      return { intent: 'general', confidence: 0.7, reasoning: 'Very long message' };
    }
    
    if (context.messageLength < 20) {
      return { intent: 'quick_chat', confidence: 0.8, reasoning: 'Very short message' };
    }
    
    // Check for question marks (suggests research or help)
    if (msg.includes('?') && !msg.includes('qui es-tu') && !msg.includes('comment tu')) {
      return { intent: 'research', confidence: 0.6, reasoning: 'Question format' };
    }
    
    // Default to general
    return { intent: 'general', confidence: 0.5, reasoning: 'No specific pattern detected' };
  }

  /**
   * Route message to optimal AI model based on detected intent
   */
  async route(message, context = {}) {
    // Pre-routing checks based on explicit context flags
    if (context.type) {
      // Games and special features explicitly marked
      return this.routeByExplicitType(context.type);
    }

    // Detect intent semantically
    const { intent, confidence, reasoning } = await this.detectIntent(message, context);
    
    logger.info(`Routing decision: ${intent} (confidence: ${confidence})`, { reasoning });

    // Route based on intent
    switch (intent) {
      case 'research':
        return {
          model: 'perplexity',
          urgency: 'high',
          reason: `RESEARCH (${reasoning})`,
          fallback: ['gemini', 'sonnet']
        };

      case 'image_analysis':
        return {
          model: 'gemini',
          urgency: 'high',
          reason: `IMAGE_ANALYSIS (${reasoning})`,
          fallback: ['sonnet', 'mistral']
        };

      case 'humor':
        return {
          model: 'grok',
          urgency: 'high',
          reason: `HUMOR (${reasoning})`,
          fallback: ['sonnet', 'opus']
        };

      case 'debate':
        return {
          model: 'opus',
          urgency: 'normal',
          reason: `DEBATE (${reasoning})`,
          secondary: 'openai',
          fallback: ['sonnet']
        };

      case 'story':
        return {
          model: 'sonnet',
          urgency: 'normal',
          reason: `STORY (${reasoning})`,
          fallback: ['opus']
        };

      case 'quiz':
        return {
          model: 'gemini',
          urgency: 'normal',
          reason: `QUIZ (${reasoning})`,
          fallback: ['sonnet', 'mistral']
        };

      case 'code_help':
        return {
          model: 'mistral',
          urgency: 'critical',
          reason: `CODE_HELP (${reasoning})`,
          fallback: ['sonnet', 'opus']
        };

      case 'quick_chat':
        return {
          model: 'opus',
          urgency: 'high',
          reason: `QUICK_CHAT (${reasoning})`,
          fallback: ['mistral', 'gemini']
        };

      case 'general':
      default:
        // High confidence general chat -> Opus
        // Low confidence -> Sonnet (safer, balanced)
        return {
          model: confidence > 0.7 ? 'opus' : 'sonnet',
          urgency: 'normal',
          reason: `GENERAL (${reasoning})`,
          fallback: ['sonnet', 'mistral', 'gemini']
        };
    }
  }

  /**
   * Route based on explicit type (for games and features)
   */
  routeByExplicitType(type) {
    const routes = {
      'word-game': { model: 'opus', urgency: 'high', reason: 'WORD_GAME', fallback: ['mistral', 'gemini'] },
      'counting': { model: 'mistral', urgency: 'normal', reason: 'COUNTING', fallback: ['sonnet'] },
      'quiz': { model: 'gemini', urgency: 'normal', reason: 'QUIZ', fallback: ['sonnet', 'mistral'] },
      'story': { model: 'sonnet', urgency: 'normal', reason: 'STORY', fallback: ['opus'] },
      'actionverite': { model: 'grok', urgency: 'normal', reason: 'ACTION_VERITE', fallback: ['sonnet', 'opus'] },
      'roast': { model: 'grok', urgency: 'high', reason: 'ROAST', fallback: ['sonnet'] },
      'debate': { model: 'opus', urgency: 'normal', reason: 'DEBATE', secondary: 'openai', fallback: ['sonnet'] }
    };

    return routes[type] || {
      model: 'opus',
      urgency: 'normal',
      reason: 'DEFAULT',
      fallback: ['sonnet', 'mistral']
    };
  }

  /**
   * Record routing decision outcome
   */
  recordRoute(model, responseTime, success = true) {
    const metrics = this.routingMetrics.get(model);
    if (!metrics) return;

    metrics.routedCount++;
    metrics.avgResponseTime = 
      (metrics.avgResponseTime * (metrics.routedCount - 1) + responseTime) / metrics.routedCount;

    if (success) {
      metrics.successCount++;
    } else {
      metrics.failureCount++;
    }

    logger.debug(`Route recorded for ${model}`, {
      model,
      responseTime,
      avgTime: metrics.avgResponseTime.toFixed(2),
      success,
      successRate: ((metrics.successCount / metrics.routedCount) * 100).toFixed(1) + '%'
    });
  }

  /**
   * Get routing statistics
   */
  getStats() {
    const stats = {};
    this.routingMetrics.forEach((metrics, model) => {
      stats[model] = {
        ...metrics,
        successRate: metrics.routedCount === 0 
          ? 0 
          : ((metrics.successCount / metrics.routedCount) * 100).toFixed(1) + '%',
        avgResponseTime: metrics.avgResponseTime.toFixed(2) + 'ms'
      };
    });
    return stats;
  }

  /**
   * Clear intent cache (useful for testing/debugging)
   */
  clearCache() {
    this.intentCache.clear();
    logger.debug('Intent cache cleared');
  }
}

// Global router instance
export const aiRouter = new AIRouter();

/**
 * Helper: Route message and get model + fallback chain
 */
export async function routeRequest(message, context = {}) {
  return await aiRouter.route(message, context);
}

/**
 * Helper: Get all available models in priority order
 */
export function getModelPriority() {
  return [
    { name: 'opus', tier: 'premium', speed: 'slow', cost: 'high', strengths: ['depth'] },
    { name: 'sonnet', tier: 'balanced', speed: 'medium', cost: 'medium', strengths: ['general', 'creative', 'quick'] },
    { name: 'mistral', tier: 'utility', speed: 'fast', cost: 'low', strengths: ['code', 'speed', 'validation'] },
    { name: 'grok', tier: 'specialty', speed: 'medium', cost: 'medium', strengths: ['humor', 'sarcasm', 'roasting'] },
    { name: 'gemini', tier: 'balanced', speed: 'medium', cost: 'free', strengths: ['images', 'knowledge', 'quiz'] },
    { name: 'perplexity', tier: 'specialty', speed: 'slow', cost: 'free', strengths: ['research', 'news', 'sources'] },
    { name: 'openai', tier: 'balanced', speed: 'medium', cost: 'medium', strengths: ['debate', 'counter-arguments'] }
  ];
}
