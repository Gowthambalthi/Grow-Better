/**
 * common/mf-engine/concurrencyManager.js
 *
 * Centralized concurrency/rate-limit manager for multi-AMC data collection.
 * Provides: controlled parallel execution, retry with backoff, timeout handling.
 */

'use strict';

class ConcurrencyManager {
  constructor(config = {}) {
    this.globalConcurrency = config.globalConcurrency || 30;
    this.perAmcConcurrency = config.perAmcConcurrency || 5;
    this.requestTimeout = config.requestTimeout || 20000;
    this.maxRetries = config.maxRetries || 3;
    this.retryBaseDelay = config.retryBaseDelay || 2000;
    this.batchDelay = config.batchDelay || 500; // delay between batches

    // Global semaphore
    this._globalSlots = this.globalConcurrency;
    this._globalQueue = [];

    // Per-AMC semaphores
    this._amcSlots = new Map();

    // Stats
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      retriedRequests: 0,
      timedOutRequests: 0,
    };
  }

  /**
   * Get or create per-AMC semaphore
   */
  _getAmcSemaphore(amcId) {
    if (!this._amcSlots.has(amcId)) {
      this._amcSlots.set(amcId, { slots: this.perAmcConcurrency, queue: [] });
    }
    return this._amcSlots.get(amcId);
  }

  /**
   * Acquire global slot
   */
  _acquireGlobal() {
    return new Promise(resolve => {
      if (this._globalSlots > 0) {
        this._globalSlots--;
        resolve();
      } else {
        this._globalQueue.push(resolve);
      }
    });
  }

  _releaseGlobal() {
    if (this._globalQueue.length > 0) {
      const next = this._globalQueue.shift();
      next();
    } else {
      this._globalSlots++;
    }
  }

  /**
   * Acquire AMC-specific slot
   */
  _acquireAmc(amcId) {
    const sem = this._getAmcSemaphore(amcId);
    return new Promise(resolve => {
      if (sem.slots > 0) {
        sem.slots--;
        resolve();
      } else {
        sem.queue.push(resolve);
      }
    });
  }

  _releaseAmc(amcId) {
    const sem = this._getAmcSemaphore(amcId);
    if (sem.queue.length > 0) {
      const next = sem.queue.shift();
      next();
    } else {
      sem.slots++;
    }
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * Execute a task with concurrency control, retry, and timeout
   * @param {string} amcId - AMC identifier for per-AMC rate limiting
   * @param {Function} task - Async function to execute
   * @param {object} opts - { retries, timeout, label }
   * @returns {Promise<{success: boolean, data?: any, error?: string, attempts: number}>}
   */
  async execute(amcId, task, opts = {}) {
    const maxRetries = opts.retries || this.maxRetries;
    const timeout = opts.timeout || this.requestTimeout;
    const label = opts.label || 'task';

    // Acquire both global and AMC slots
    await this._acquireGlobal();
    await this._acquireAmc(amcId);

    try {
      this.stats.totalRequests++;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const result = await this._withTimeout(task(), timeout);
          this.stats.successfulRequests++;
          return { success: true, data: result, attempts: attempt };
        } catch (err) {
          const isLast = attempt === maxRetries;
          const isRetryable = this._isRetryable(err);

          if (isLast || !isRetryable) {
            this.stats.failedRequests++;
            return { success: false, error: err.message, attempts: attempt };
          }

          this.stats.retriedRequests++;
          const delay = this.retryBaseDelay * Math.pow(2, attempt - 1) + Math.random() * 500;
          console.log(`  [${amcId}] ⟳ ${label} attempt ${attempt} failed (${err.message}), retry in ${(delay/1000).toFixed(1)}s...`);
          await this.sleep(delay);
        }
      }
    } finally {
      this._releaseAmc(amcId);
      this._releaseGlobal();
    }
  }

  /**
   * Execute multiple tasks in parallel with controlled concurrency
   * @param {string} amcId
   * @param {Array<{key: string, task: Function, label?: string}>} tasks
   * @param {object} opts
   * @returns {Promise<Map<string, {success: boolean, data?: any, error?: string}>>}
   */
  async executeBatch(amcId, tasks, opts = {}) {
    const results = new Map();
    const promises = tasks.map(({ key, task, label }) =>
      this.execute(amcId, task, { ...opts, label: label || key })
        .then(result => { results.set(key, result); })
        .catch(err => { results.set(key, { success: false, error: err.message, attempts: 1 }); })
    );
    await Promise.all(promises);
    return results;
  }

  /**
   * Process items with controlled concurrency (worker pool pattern)
   * @param {Array} items
   * @param {Function} processor - async (item, index) => result
   * @param {number} concurrency - max concurrent
   * @returns {Promise<Array>}
   */
  async processPool(items, processor, concurrency) {
    const results = [];
    let index = 0;

    async function worker() {
      while (index < items.length) {
        const i = index++;
        results[i] = await processor(items[i], i);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, items.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return results;
  }

  /**
   * Wrap a promise with a timeout
   */
  _withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stats.timedOutRequests++;
        reject(new Error(`Timeout after ${ms}ms`));
      }, ms);

      promise
        .then(val => { clearTimeout(timer); resolve(val); })
        .catch(err => { clearTimeout(timer); reject(err); });
    });
  }

  /**
   * Check if an error is retryable
   */
  _isRetryable(err) {
    const msg = (err.message || '').toLowerCase();
    // Timeout
    if (msg.includes('timeout')) return true;
    // Rate limiting
    if (msg.includes('429') || msg.includes('too many requests')) return true;
    // Temporary server errors
    if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) return true;
    // Connection errors
    if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('enotfound')) return true;
    // Network errors
    if (msg.includes('network') || msg.includes('econnaborted')) return true;
    return false;
  }

  /**
   * Get current stats
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Reset stats
   */
  resetStats() {
    Object.keys(this.stats).forEach(k => { this.stats[k] = 0; });
  }
}

module.exports = ConcurrencyManager;
