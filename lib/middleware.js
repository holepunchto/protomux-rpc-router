const safetyCatch = require('safety-catch')

module.exports = class Middleware {
  static NOOP = {
    open: async (ctx) => {},
    close: async (ctx) => {},
    onrequest: (ctx, next) => {
      return next()
    }
  }

  static compose(...middlewares) {
    return middlewares.reduce((acc, middleware) => {
      return {
        open: async (ctx) => {
          await acc.open(ctx)
          try {
            await middleware.open(ctx)
          } catch (error) {
            await acc.close(ctx).catch(safetyCatch)
            throw error
          }
        },
        close: async (ctx) => {
          let caughtError = null
          try {
            await middleware.close(ctx)
          } catch (error) {
            caughtError = error
          }
          await acc.close(ctx).catch(safetyCatch)
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

  async open(ctx) {
    // no-op
  }

  async close(ctx) {
    // no-op
  }

  onrequest(ctx, next) {
    return next()
  }
}
