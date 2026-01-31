import { Logger } from './logger.js';

const logger = new Logger('RATE-LIMITER');

/**
 * Rate limiter for API quotas
 * Tracks usage per model and enforces limits
 */
export class RateLimiter {
  constructor(config = {}) {
    this.config = {
      opusMaxTokensPerDay: config.opusMaxTokensPerDay || 100000,
      opusMaxReqPerMin: config.opusMaxReqPerMin || 60,
      mistralMaxReqPerMin: config.mistralMaxReqPerMin || 100,
      geminiMaxReqPerDay: config.geminiMaxReqPerDay || 1500,
      perplexityMaxReqPerDay: config.perplexityMaxReqPerDay || 1500,
      grokMaxReqPerDay: config.grokMaxReqPerDay || 10000,
      openaiMaxReqPerMin: config.openaiMaxReqPerMin || 60,
      ...config
    };

    this.usage = new Map();
    this.initializeModels();
  }

  initializeModels() {
    const models = ['opus', 'sonnet', 'mistral', 'grok', 'gemini', 'perplexity', 'openai'];
    models.forEach(model => {
      this.usage.set(model, {
        dailyTokens: 0,
        hourlyTokens: 0,
        requestCount: 0,
        minuteRequests: 0,
        hourlyRequests: 0,
        lastReset: Date.now(),
        lastHourReset: Date.now(),
        lastMinReset: Date.now(),
        totalCost: 0,
        requestHistory: [] // Last 100 requests
      });
    });
  }

  canMakeRequest(model, estimatedTokens = 0) {
    const stats = this.usage.get(model);
    if (!stats) return { allowed: false, reason: 'Unknown model' };

    this.resetIfNeeded(model);

    switch (model) {
      case 'opus':
        if (stats.dailyTokens + estimatedTokens > this.config.opusMaxTokensPerDay) {
          return {
            allowed: false,
            reason: 'OPUS_DAILY_QUOTA_EXCEEDED',
            current: stats.dailyTokens,
            limit: this.config.opusMaxTokensPerDay,
            fallback: 'sonnet'
          };
        }
        if (stats.minuteRequests >= this.config.opusMaxReqPerMin) {
          return {
            allowed: false,
            reason: 'OPUS_RATE_LIMIT',
            fallback: 'mistral'
          };
        }
        break;

      case 'mistral':
        if (stats.minuteRequests >= this.config.mistralMaxReqPerMin) {
          return {
            allowed: false,
            reason: 'MISTRAL_RATE_LIMIT',
            fallback: 'sonnet'
          };
        }
        break;

      case 'gemini':
        if (stats.requestCount >= this.config.geminiMaxReqPerDay) {
          return {
            allowed: false,
            reason: 'GEMINI_QUOTA_EXCEEDED',
            fallback: 'sonnet'
          };
        }
        break;

      case 'perplexity':
        if (stats.requestCount >= this.config.perplexityMaxReqPerDay) {
          return {
            allowed: false,
            reason: 'PERPLEXITY_QUOTA_EXCEEDED',
            fallback: 'mistral'
          };
        }
        break;

      case 'grok':
        if (stats.requestCount >= this.config.grokMaxReqPerDay) {
          return {
            allowed: false,
            reason: 'GROK_QUOTA_EXCEEDED',
            fallback: 'opus'
          };
        }
        break;
    }

    return { allowed: true };
  }

  recordUsage(model, tokens = 0, cost = 0) {
    const stats = this.usage.get(model);
    if (!stats) return;

    stats.dailyTokens += tokens;
    stats.hourlyTokens += tokens;
    stats.requestCount++;
    stats.minuteRequests++;
    stats.hourlyRequests++;
    stats.totalCost += cost;

    const request = {
      timestamp: Date.now(),
      tokens,
      cost
    };
    stats.requestHistory.push(request);
    if (stats.requestHistory.length > 100) {
      stats.requestHistory.shift();
    }

    logger.debug(`Rate limit recorded for ${model}`, {
      model,
      tokens,
      dailyTotal: stats.dailyTokens,
      requestCount: stats.requestCount,
      totalCost: stats.totalCost.toFixed(4)
    });
  }

  resetIfNeeded(model) {
    const stats = this.usage.get(model);
    const now = Date.now();

    // Daily reset
    if (now - stats.lastReset > 24 * 60 * 60 * 1000) {
      stats.dailyTokens = 0;
      stats.requestCount = 0;
      stats.lastReset = now;
      logger.info(`Daily quota reset for ${model}`);
    }

    // Hourly reset
    if (now - stats.lastHourReset > 60 * 60 * 1000) {
      stats.hourlyTokens = 0;
      stats.hourlyRequests = 0;
      stats.lastHourReset = now;
    }

    // Minute reset
    if (now - stats.lastMinReset > 60 * 1000) {
      stats.minuteRequests = 0;
      stats.lastMinReset = now;
    }
  }

  getStats(model) {
    const stats = this.usage.get(model);
    if (!stats) return null;

    return {
      model,
      daily: {
        tokens: stats.dailyTokens,
        limit: this.config[`${model}MaxTokensPerDay`] || 'unlimited'
      },
      hourly: {
        tokens: stats.hourlyTokens,
        requests: stats.hourlyRequests
      },
      minute: {
        requests: stats.minuteRequests,
        limit: this.config[`${model}MaxReqPerMin`] || 'unlimited'
      },
      total: {
        requests: stats.requestCount,
        cost: stats.totalCost.toFixed(4)
      }
    };
  }

  getAllStats() {
    const allStats = {};
    this.usage.forEach((_, model) => {
      allStats[model] = this.getStats(model);
    });
    return allStats;
  }

  resetAll() {
    this.initializeModels();
    logger.info('All rate limits reset');
  }
}
