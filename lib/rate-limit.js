const b4a = require('b4a')

/** @typedef {import('..').RpcContext} RpcContext */
/** @typedef {import('..').NextFunction} NextFunction */

/**
 * Create a per-IP rate limit middleware.
 *
 * @param {number} capacity The bucket capacity (max tokens).
 * @param {number} intervalMs Interval in milliseconds to refill 1 token.
 * @returns {RateLimitMiddleware}
 */
exports.byIp = (capacity, intervalMs) => {
  return new RateLimitMiddleware(capacity, intervalMs, (ctx) => {
    return ctx.connection.rawStream.remoteHost
  })
}

/**
 * Create a per-remote-public-key rate limit middleware.
 *
 * @param {number} capacity The bucket capacity (max tokens).
 * @param {number} intervalMs Interval in milliseconds to refill 1 token.
 * @returns {RateLimitMiddleware}
 */
exports.byPublicKey = (capacity, intervalMs) => {
  return new RateLimitMiddleware(capacity, intervalMs, (ctx) => {
    return b4a.toString(ctx.connection.remotePublicKey, 'base64')
  })
}

class RateLimitMiddleware {
  /**
   * @param {number} capacity The bucket capacity (max tokens).
   * @param {number} intervalMs Interval in milliseconds to refill 1 token.
   * @param {(ctx: RpcContext) => string} decideKey Function that maps a request context to a rate-limit key.
   */
  constructor(capacity, intervalMs, decideKey) {
    /** @type {Map<any, number>} */
    this._tokenMap = new Map()
    this.capacity = capacity
    this.intervalMs = intervalMs
    this._decideKey = decideKey
    this.destroyed = false
    this._timer = setInterval(() => {
      this._refill()
    }, this.intervalMs)
  }

  _refill() {
    this._tokenMap.forEach((tokens, key) => {
      tokens++
      if (tokens >= this.capacity) {
        // tokens is full, delete the key, this help to avoid memory leak
        this._tokenMap.delete(key)
      } else {
        this._tokenMap.set(key, tokens)
      }
    })
  }

  _tryAcquire(key) {
    let tokens = this._tokenMap.get(key)
    if (tokens === undefined) {
      tokens = this.capacity
    }
    if (tokens > 0) {
      tokens--
      this._tokenMap.set(key, tokens)
      return true
    } else {
      return false
    }
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
    if (this.destroyed) {
      throw RateLimitMiddlewareError.DESTROYED()
    }
    const key = this._decideKey(ctx)
    if (!this._tryAcquire(key)) {
      throw RateLimitMiddlewareError.RATE_LIMIT_EXCEEDED()
    }
    return next()
  }

  /**
   * Destroy all underlying per-key rate limiters and clear memory.
   */
  destroy() {
    if (this.destroyed) {
      throw RateLimitMiddlewareError.DESTROYED()
    }
    this.destroyed = true
    this._tokenMap.clear()
    clearInterval(this._timer)
  }
}

class RateLimitMiddlewareError extends Error {
  constructor(msg, code, fn = RateLimitMiddlewareError) {
    super(`${code}: ${msg}`)
    this.code = code

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, fn)
    }
  }

  get name() {
    return 'RateLimitMiddlewareError'
  }

  static DESTROYED() {
    return new RateLimitMiddlewareError(
      'The rate limit middleware is destroyed',
      'RATE_LIMIT_MIDDLEWARE_DESTROYED',
      RateLimitMiddlewareError.DESTROYED
    )
  }

  static RATE_LIMIT_EXCEEDED() {
    return new RateLimitMiddlewareError(
      'The rate limit is exceeded',
      'RATE_LIMIT_EXCEEDED',
      RateLimitMiddlewareError.RATE_LIMIT_EXCEEDED
    )
  }
}
