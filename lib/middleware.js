const safetyCatch = require('safety-catch')

module.exports = class Middleware {
  static NOOP = {
    onopen: async (ctx) => {},
    onclose: async (ctx) => {},
    onrequest: (ctx, next) => {
      return next()
    }
  }

  static compose(...middlewares) {
    return middlewares.reduce((acc, middleware) => {
      return {
        onopen: async (ctx) => {
          await acc.onopen(ctx)
          try {
            await middleware.onopen(ctx)
          } catch (error) {
            await acc.onclose(ctx).catch(safetyCatch)
            throw error
          }
        },
        onclose: async (ctx) => {
          let caughtError = null
          try {
            await middleware.onclose(ctx)
          } catch (error) {
            caughtError = error
          }
          await acc.onclose(ctx).catch(safetyCatch)
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

  async onopen(ctx) {
    // no-op
  }

  async onclose(ctx) {
    // no-op
  }

  onrequest(ctx, next) {
    return next()
  }
}
