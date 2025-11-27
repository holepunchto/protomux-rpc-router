const ProtomuxRPC = require('protomux-rpc')
const encoding = require('./lib/encoding')

/**
 * RPC context passed to middleware.
 * @typedef {Object} RpcContext
 * @property {string} method - RPC method name.
 * @property {any} req - Request object passed by protomux-rpc.
 * @property {any} connection - Underlying connection (HyperDHT ...).
 */

/**
 * The continuation function that dispatches to the next middleware/handler.
 * @callback NextFunction
 * @returns {Promise<any>}
 */

/**
 * A middleware with an onion-style `onrequest` handler and optional lifecycle `destroy`.
 * @typedef {Object} Middleware
 * @property {(ctx: RpcContext, next: NextFunction) => Promise<any>} onrequest - Called for each request.
 * @property {() => void|Promise<void>} [destroy] - Optional cleanup hook.
 */

const defaultMiddleware = {
  onrequest: (ctx, next) => next()
}

/**
 * Compose multiple middlewares into a single middleware preserving onion order.
 * @param {...Middleware} middlewares
 * @returns {Middleware}
 */
function composeMiddlewares(...middlewares) {
  return middlewares.reduce((acc, middleware) => {
    return {
      onrequest: (ctx, next) => {
        if (middleware.onrequest) {
          return acc.onrequest(ctx, () => middleware.onrequest(ctx, next))
        }
        return acc.onrequest(ctx, next)
      },
      destroy: async () => {
        if (middleware.destroy) {
          await middleware.destroy()
        }
        if (acc.destroy) {
          await acc.destroy()
        }
      }
    }
  }, defaultMiddleware)
}

/**
 * Registration object returned by `router.method(...)` for per-method configuration.
 */
class MethodRegistration {
  /**
   * @param {string} method
   * @param {Middleware} middleware
   * @param {(req: any) => any|Promise<any>} handler
   */
  constructor(method, middleware, handler) {
    this.method = method
    this._middleware = middleware
    this._handler = handler
  }

  /**
   * Attach additional middleware to this method (appended to existing chain).
   * @param {...Middleware} middlewares
   * @returns {this}
   */
  use(...middlewares) {
    this._middleware = composeMiddlewares(this._middleware, ...middlewares)
    return this
  }

  /**
   * Run cleanup for this method's middleware.
   * @returns {Promise<void>}
   */
  async destroy() {
    if (this._middleware.destroy) {
      await this._middleware.destroy()
    }
  }
}

/**
 * Router that exposes protomux-rpc responders with a composable middleware model.
 */
class ProtomuxRpcRouter {
  /**
   * Create a new router.
   */
  constructor() {
    this._methodMaps = new Map()
    this._middleware = defaultMiddleware
  }

  /**
   * Attach responders for all registered methods on a new connection.
   * @param {any} connection - HyperDHT connection (duplex stream with `publicKey`).
   * @param {Buffer|string} [publicKey=connection.publicKey] - Optional responder id; defaults to the peer public key.
   * @returns {Promise<void>}
   */
  async handleConnection(connection, publicKey = connection.publicKey) {
    const rpc = new ProtomuxRPC(connection, {
      id: publicKey
    })
    this._methodMaps.forEach((registration) => {
      rpc.respond(registration.method, (req) => {
        const combinedMiddleware = composeMiddlewares(this._middleware, registration._middleware)
        const ctx = {
          method: registration.method,
          req,
          connection
        }
        return combinedMiddleware.onrequest(ctx, () => registration._handler(ctx.req))
      })
    })
  }

  /**
   * Add global middleware applied to every method.
   * @param {...Middleware} middlewares
   * @returns {this}
   */
  use(...middlewares) {
    this._middleware = composeMiddlewares(this._middleware, ...middlewares)
    return this
  }

  /**
   * Register a new RPC method.
   * Usage:
   *   router.method('name', mw1, mw2, handler)
   * @param {string} method - RPC method name.
   * @param {...any} args - Zero or more middlewares followed by the handler function.
   * @returns {MethodRegistration}
   */
  method(method, ...args) {
    // get last argument as handler
    const handler = args[args.length - 1]
    const middlewares = args.slice(0, -1)
    const middlewareChain = composeMiddlewares(...middlewares)
    const registration = new MethodRegistration(method, middlewareChain, handler)
    this._methodMaps.set(method, registration)
    return registration
  }

  /**
   * Destroy the router and run cleanup for all registered middleware.
   * @returns {Promise<void>}
   */
  async destroy() {
    for (const registration of this._methodMaps.values()) {
      await registration.destroy()
    }
    this._methodMaps.clear()
    if (this._middleware.destroy) {
      await this._middleware.destroy()
    }
  }
}

/**
 * Built-in encoding middleware factory.
 * @type {(opts?: { request?: { encode: (v:any)=>any }, response?: { encode: (v:any)=>any } }) => Middleware}
 */
ProtomuxRpcRouter.encoding = encoding

module.exports = ProtomuxRpcRouter
