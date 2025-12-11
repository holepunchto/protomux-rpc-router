const safetyCatch = require('safety-catch')
const ProtomuxRpcRouterError = require('./errors')

module.exports = class Middleware {
  static NOOP = {
    onopen: async () => {},
    onclose: async () => {},
    onrequest: (ctx, next) => {
      return next()
    },
    registerMetrics: (promClient) => {}
  }

  /**
   * Wrap a middleware object with optional hooks into a new middleware.
   * @param {Partial<Middleware>} middleware - The middleware object to wrap.
   * @param {Middleware['onopen']} [middleware.onopen] - Optional onopen function.
   * @param {Middleware['onclose']} [middleware.onclose] - Optional onclose function.
   * @param {Middleware['onrequest']} [middleware.onrequest] - Optional onrequest function.
   * @param {Middleware['registerMetrics']} [middleware.registerMetrics] - Optional registerMetrics function.
   * @returns {Middleware} The wrapped middleware.
   */
  static wrap(middleware) {
    return {
      onopen: middleware.onopen?.bind(middleware) ?? Middleware.NOOP.onopen,
      onclose: middleware.onclose?.bind(middleware) ?? Middleware.NOOP.onclose,
      onrequest: middleware.onrequest?.bind(middleware) ?? Middleware.NOOP.onrequest,
      registerMetrics:
        middleware.registerMetrics?.bind(middleware) ?? Middleware.NOOP.registerMetrics
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
          let aggregateError = null
          try {
            await middleware.onclose()
          } catch (error) {
            aggregateError = ProtomuxRpcRouterError.aggregate(aggregateError, error)
          }
          try {
            await acc.onclose()
          } catch (error) {
            aggregateError = ProtomuxRpcRouterError.aggregate(aggregateError, error)
          }
          if (aggregateError) {
            throw aggregateError
          }
        },
        onrequest: (ctx, next) => {
          return acc.onrequest(ctx, () => middleware.onrequest(ctx, next))
        },
        registerMetrics: (promClient) => {
          acc.registerMetrics(promClient)
          middleware.registerMetrics(promClient)
        }
      }
    }, Middleware.NOOP)
  }

  // this function is called by the router to register metrics with prom-client, it is NOT PART OF THE PUBLIC API and may be changed at any time
  registerMetrics(promClient) {
    // no-op
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
