import { Logger } from './logger.js';

const logger = new Logger('ERROR-HANDLER');

/**
 * Circuit Breaker Pattern for API resilience
 * Prevents cascading failures when APIs are down
 */
export class CircuitBreaker {
  constructor(modelName, thresholdFailures = 3, resetTimeoutMs = 60000) {
    this.modelName = modelName;
    this.failureCount = 0;
    this.threshold = thresholdFailures;
    this.resetTimeout = resetTimeoutMs;
    this.state = 'CLOSED'; // CLOSED | OPEN | HALF_OPEN
    this.lastFailureTime = null;
    this.stateChangedAt = Date.now();
  }

  async execute(fn, fallbackFn = null) {
    if (this.state === 'OPEN') {
      const timeSinceOpen = Date.now() - this.stateChangedAt;
      if (timeSinceOpen > this.resetTimeout) {
        this.state = 'HALF_OPEN';
        logger.info(`Circuit HALF_OPEN for ${this.modelName} - trying again`, {
          model: this.modelName,
          timeSinceOpen
        });
      } else {
        logger.warn(`Circuit OPEN for ${this.modelName} - using fallback`, {
          model: this.modelName,
          timeUntilRetry: this.resetTimeout - timeSinceOpen
        });
        return fallbackFn ? await fallbackFn() : null;
      }
    }

    try {
      const result = await fn();
      
      // Success - reset state
      if (this.state !== 'CLOSED') {
        logger.info(`Circuit CLOSED for ${this.modelName} - recovered`, {
          model: this.modelName,
          previousState: this.state
        });
      }
      
      this.failureCount = 0;
      this.state = 'CLOSED';
      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = Date.now();

      logger.error(`${this.modelName} failed (${this.failureCount}/${this.threshold})`, {
        model: this.modelName,
        error: error.message,
        code: error.code,
        status: error.status
      });

      if (this.failureCount >= this.threshold) {
        this.state = 'OPEN';
        this.stateChangedAt = Date.now();
        logger.critical(`Circuit OPENED for ${this.modelName}`, {
          model: this.modelName,
          failureCount: this.failureCount
        });
      }

      // Try fallback
      if (fallbackFn) {
        logger.info(`Using fallback for ${this.modelName}`);
        return await fallbackFn();
      }

      throw error;
    }
  }

  reset() {
    this.failureCount = 0;
    this.state = 'CLOSED';
    logger.info(`Circuit manually reset for ${this.modelName}`);
  }

  getState() {
    return {
      model: this.modelName,
      state: this.state,
      failures: this.failureCount,
      threshold: this.threshold,
      lastFailure: this.lastFailureTime
    };
  }
}

/**
 * Retry logic with exponential backoff
 */
export async function retryWithBackoff(
  fn,
  maxAttempts = 3,
  baseDelayMs = 1000,
  modelName = 'UNKNOWN'
) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) {
        logger.info(`${modelName} succeeded on attempt ${attempt}/${maxAttempts}`);
      }
      return result;
    } catch (error) {
      lastError = error;
      
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        logger.warn(`${modelName} attempt ${attempt} failed, retrying in ${delay}ms`, {
          model: modelName,
          attempt,
          delay,
          error: error.message
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  logger.error(`${modelName} failed after ${maxAttempts} attempts`, {
    model: modelName,
    attempts: maxAttempts,
    error: lastError.message
  });
  
  throw lastError;
}

/**
 * Handle API errors with context
 */
export function handleAPIError(error, context = {}) {
  const errorInfo = {
    message: error.message,
    code: error.code,
    status: error.status,
    timestamp: new Date().toISOString(),
    ...context
  };

  // Categorize error
  if (error.status === 429) {
    errorInfo.type = 'RATE_LIMIT';
    logger.warn('Rate limited', errorInfo);
  } else if (error.status === 401 || error.status === 403) {
    errorInfo.type = 'AUTH_ERROR';
    logger.error('Authentication failed', errorInfo);
  } else if (error.status >= 500) {
    errorInfo.type = 'SERVER_ERROR';
    logger.error('API server error', errorInfo);
  } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') {
    errorInfo.type = 'CONNECTION_ERROR';
    logger.error('Connection error', errorInfo);
  } else {
    errorInfo.type = 'UNKNOWN_ERROR';
    logger.error('API error', errorInfo);
  }

  return errorInfo;
}

/**
 * Timeout wrapper for async functions
 */
export async function withTimeout(promise, timeoutMs, modelName = 'UNKNOWN') {
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => {
      const error = new Error(`${modelName} request timed out after ${timeoutMs}ms`);
      error.code = 'TIMEOUT';
      reject(error);
    }, timeoutMs)
  );

  return Promise.race([promise, timeoutPromise]);
}
