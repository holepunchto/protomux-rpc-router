const b4a = require('b4a')
const BucketRateLimiter = require('bucket-rate-limit')

/** @typedef {import('..').RpcContext} RpcContext */
/** @typedef {import('..').NextFunction} NextFunction */

/**
 * Create a per-IP rate limit middleware.
 *
 * Buckets requests by `ctx.connection.rawStream.remoteHost` and applies a token bucket
 * with the provided capacity and per-token refill interval.
 * See the `bucket-rate-limit` package for the exact semantics.
 *
 * @param {number} capacity The bucket capacity (max tokens).
 * @param {number} intervalMs Interval in milliseconds to refill 1 token.
 * @returns {RateLimitMiddleware}
 */
exports.rateLimitByIp = (capacity, intervalMs) => {
  return new RateLimitMiddleware(capacity, intervalMs, (ctx) => {
    return ctx.connection.rawStream.remoteHost
  })
}

/**
 * Create a per-remote-public-key rate limit middleware.
 *
 * Buckets requests by Base64-encoded `ctx.connection.remotePublicKey` and applies a
 * token bucket with the provided capacity and per-token refill interval.
 * See the `bucket-rate-limit` package for the exact semantics.
 *
 * @param {number} capacity The bucket capacity (max tokens).
 * @param {number} intervalMs Interval in milliseconds to refill 1 token.
 * @returns {RateLimitMiddleware}
 */
exports.rateLimitByRemotePublicKey = (capacity, intervalMs) => {
  return new RateLimitMiddleware(capacity, intervalMs, (ctx) => {
    return b4a.toString(ctx.connection.remotePublicKey, 'base64')
  })
}

class RateLimitMiddleware {
  /**
   * @param {number} capacity The bucket capacity (max tokens).
   * @param {number} intervalMs Interval in milliseconds to refill 1 token.
   * @param {(ctx: RpcContext) => string} decideKey Function that maps a request context to a rate-limit key.
   * @see https://www.npmjs.com/package/bucket-rate-limit
   */
  constructor(capacity, intervalMs, decideKey) {
    /** @type {Map<string, BucketRateLimiter>} */
    this._rateLimiterMap = new Map()
    this._capacity = capacity
    this._intervalMs = intervalMs
    this._decideKey = decideKey
  }

  /**
   * Router middleware entrypoint that waits until a token is available
   * for the computed key, then calls the next middleware/handler.
   *
   * @param {RpcContext} ctx
   * @param {NextFunction} next
   * @returns {Promise<unknown>}
   */
  async onrequest(ctx, next) {
    const key = this._decideKey(ctx)
    let rateLimiter = this._rateLimiterMap.get(key)
    if (!rateLimiter) {
      rateLimiter = new BucketRateLimiter(this._capacity, this._intervalMs)
      this._rateLimiterMap.set(key, rateLimiter)
    }
    if (!rateLimiter._tryAcquire()) {
      throw new Error('Rate limit exceeded')
    }
    return next()
  }

  /**
   * Destroy all underlying per-key rate limiters and clear memory.
   */
  destroy() {
    for (const rateLimiter of this._rateLimiterMap.values()) {
      rateLimiter.destroy()
    }
    this._rateLimiterMap.clear()
  }
}
