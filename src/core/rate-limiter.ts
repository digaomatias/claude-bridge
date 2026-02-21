/**
 * Rate Limiter
 *
 * Sliding window rate limiter for hook endpoints and Telegram messages.
 */

export class RateLimiter {
  private maxRequests: number;
  private windowMs: number;
  private requests = new Map<string, number[]>();

  constructor(opts: { maxRequests: number; windowMs: number }) {
    this.maxRequests = opts.maxRequests;
    this.windowMs = opts.windowMs;
  }

  /**
   * Check if a request from the given key is allowed.
   * Records the timestamp if allowed.
   * Returns true if allowed, false if rate limited.
   */
  check(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.requests.get(key);
    if (!timestamps) {
      timestamps = [];
      this.requests.set(key, timestamps);
    }

    // Remove expired timestamps
    const validIndex = timestamps.findIndex(t => t > cutoff);
    if (validIndex > 0) {
      timestamps.splice(0, validIndex);
    } else if (validIndex === -1) {
      timestamps.length = 0;
    }

    if (timestamps.length >= this.maxRequests) {
      return false;
    }

    timestamps.push(now);
    return true;
  }

  /**
   * Get remaining quota for a key.
   */
  remaining(key: string): number {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = this.requests.get(key);
    if (!timestamps) return this.maxRequests;

    const valid = timestamps.filter(t => t > cutoff).length;
    return Math.max(0, this.maxRequests - valid);
  }

  /**
   * Prune expired entries across all keys.
   */
  cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    for (const [key, timestamps] of this.requests) {
      const valid = timestamps.filter(t => t > cutoff);
      if (valid.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, valid);
      }
    }
  }
}
