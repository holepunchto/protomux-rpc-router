const safetyCatch = require('safety-catch')

module.exports = class Middleware {
  static NOOP = {
    onopen: async () => {},
    onclose: async () => {},
    onrequest: (ctx, next) => {
      return next()
    }
  }

  /**
   * Wrap a middleware object with optional hooks into a new middleware.
   * @param {Partial<Middleware>} middleware - The middleware object to wrap.
   * @param {Middleware['onopen']} [middleware.onopen] - Optional onopen function.
   * @param {Middleware['onclose']} [middleware.onclose] - Optional onclose function.
   * @param {Middleware['onrequest']} [middleware.onrequest] - Optional onrequest function.
   * @returns {Middleware} The wrapped middleware.
   */
  static wrap(middleware) {
    return {
      onopen: middleware.onopen?.bind(middleware) ?? Middleware.NOOP.onopen,
      onclose: middleware.onclose?.bind(middleware) ?? Middleware.NOOP.onclose,
      onrequest: middleware.onrequest?.bind(middleware) ?? Middleware.NOOP.onrequest
    }
  }

  /**
   * Compose multiple middleware objects into a single middleware object.
   * @param {Middleware[]} middlewares - The middleware objects to compose.
   * @returns {Middleware} The composed middleware.
   */
  static compose(...middlewares) {
    return middlewares.reduce((acc, middleware) => {
      return {
        onopen: async () => {
          await acc.onopen()
          try {
            await middleware.onopen()
          } catch (error) {
            await acc.onclose().catch(safetyCatch)
            throw error
          }
        },
        onclose: async () => {
          let caughtError = null
          try {
            await middleware.onclose()
          } catch (error) {
            caughtError = error
          }
          await acc.onclose().catch(safetyCatch)
          if (caughtError) {
            throw caughtError
          }
        },
        onrequest: (ctx, next) => {
          return acc.onrequest(ctx, () => middleware.onrequest(ctx, next))
        }
      }
    }, Middleware.NOOP)
  }

  async onopen() {
    // no-op
  }

  async onclose() {
    // no-op
  }

  onrequest(ctx, next) {
    return next()
  }
}
