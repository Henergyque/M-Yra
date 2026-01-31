import { Logger } from './logger.js';

const logger = new Logger('CACHE');

/**
 * LRU Cache with TTL for brain data
 * Prevents memory bloat with automatic eviction
 */
export class LRUCache {
  constructor(maxSize = 200, ttlSeconds = 900) {
    this.cache = new Map();
    this.metadata = new Map();
    this.maxSize = maxSize;
    this.ttl = ttlSeconds * 1000;
    this.hits = 0;
    this.misses = 0;
  }

  set(key, value) {
    // LRU eviction if at max capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const lruKey = this.findLRUKey();
      this.cache.delete(lruKey);
      this.metadata.delete(lruKey);
      logger.debug(`LRU eviction: removed ${lruKey}`);
    }

    this.cache.set(key, value);
    this.metadata.set(key, {
      createdAt: Date.now(),
      lastAccess: Date.now(),
      accessCount: 0,
      size: this.estimateSize(value)
    });

    logger.debug(`Cache SET: ${key}`, {
      cacheSize: this.cache.size,
      maxSize: this.maxSize
    });
  }

  get(key) {
    const value = this.cache.get(key);
    
    if (!value) {
      this.misses++;
      logger.debug(`Cache MISS: ${key}`);
      return null;
    }

    const meta = this.metadata.get(key);
    
    // Check TTL
    if (Date.now() - meta.createdAt > this.ttl) {
      this.cache.delete(key);
      this.metadata.delete(key);
      this.misses++;
      logger.debug(`Cache EXPIRED: ${key}`);
      return null;
    }

    // Update metadata
    meta.lastAccess = Date.now();
    meta.accessCount++;
    this.hits++;

    logger.debug(`Cache HIT: ${key}`, {
      accessCount: meta.accessCount,
      hitRate: (this.hits / (this.hits + this.misses) * 100).toFixed(2) + '%'
    });

    return value;
  }

  has(key) {
    const value = this.get(key);
    return value !== null;
  }

  delete(key) {
    this.cache.delete(key);
    this.metadata.delete(key);
    logger.debug(`Cache DELETE: ${key}`);
  }

  clear() {
    this.cache.clear();
    this.metadata.clear();
    logger.info('Cache cleared');
  }

  findLRUKey() {
    let lruKey = null;
    let oldestAccess = Infinity;

    this.metadata.forEach((meta, key) => {
      if (meta.lastAccess < oldestAccess) {
        oldestAccess = meta.lastAccess;
        lruKey = key;
      }
    });

    return lruKey;
  }

  estimateSize(value) {
    if (typeof value === 'string') return value.length;
    if (typeof value === 'object') {
      return JSON.stringify(value).length;
    }
    return 0;
  }

  stats() {
    let totalSize = 0;
    this.metadata.forEach(meta => {
      totalSize += meta.size;
    });

    const hitRate = this.hits + this.misses === 0 
      ? 0 
      : (this.hits / (this.hits + this.misses) * 100).toFixed(2);

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      utilization: ((this.cache.size / this.maxSize) * 100).toFixed(2) + '%',
      totalSizeBytes: totalSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: hitRate + '%'
    };
  }

  prune() {
    const now = Date.now();
    let pruned = 0;

    const keysToDelete = [];
    this.metadata.forEach((meta, key) => {
      if (now - meta.createdAt > this.ttl) {
        keysToDelete.push(key);
      }
    });

    keysToDelete.forEach(key => {
      this.cache.delete(key);
      this.metadata.delete(key);
      pruned++;
    });

    logger.info(`Cache pruned: ${pruned} expired entries removed`, {
      remaining: this.cache.size,
      pruned
    });

    return pruned;
  }
}
