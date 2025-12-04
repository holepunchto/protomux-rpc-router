const ProtomuxRPC = require('protomux-rpc')
const ReadyResource = require('ready-resource')
const Middleware = require('./lib/middleware')
const ProtomuxRpcRouterError = require('./lib/errors')

/**
 * RPC context passed to middleware.
 * @typedef {Object} RpcContext
 * @property {string} method - RPC method name.
 * @property {any} value - Request object passed by protomux-rpc.
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
   * @param {Middleware} middleware
   * @returns {this}
   */
  use(middleware) {
    this._middleware = Middleware.compose(this._middleware, middleware)
    return this
  }

  /**
   * Open hook for method, call into middleware chain
   * @returns {Promise<void>}
   */
  async onopen(ctx) {
    await this._middleware.onopen(ctx)
  }

  /**
   * Close hook for method, call into middleware chain
   * @returns {Promise<void>}
   */
  async onclose(ctx) {
    await this._middleware.onclose(ctx)
  }
}

/**
 * Router that exposes protomux-rpc responders with a composable middleware model.
 */
class ProtomuxRpcRouter extends ReadyResource {
  static Middleware = Middleware

  /**
   * Create a new router.
   */
  constructor() {
    super()
    this.methods = new Map()
    this._middleware = Middleware.NOOP
  }

  /**
   * Attach responders for all registered methods on a new connection.
   * @param {any} connection - HyperDHT connection (duplex stream with `publicKey`).
   * @param {Buffer|string} [protomuxRpcId=connection.publicKey] - Optional responder id; defaults to the peer public key.
   * @returns {Promise<void>}
   */
  async handleConnection(connection, protomuxRpcId = connection.publicKey) {
    if (!this.opened) {
      throw ProtomuxRpcRouterError.ROUTER_NOT_READY()
    }
    if (this.closed) {
      throw ProtomuxRpcRouterError.ROUTER_CLOSED()
    }
    const rpc = new ProtomuxRPC(connection, {
      id: protomuxRpcId,
      valueEncoding: null
    })
    this.methods.forEach((registration) => {
      rpc.respond(registration.method, async (value) => {
        const combinedMiddleware = Middleware.compose(this._middleware, registration._middleware)
        const ctx = {
          method: registration.method,
          value,
          connection
        }
        const res = await combinedMiddleware.onrequest(ctx, () => {
          return registration._handler(ctx.value, ctx)
        })
        return res
      })
    })
  }

  /**
   * Add global middleware applied to every method.
   * @param {Middleware} middleware
   * @returns {this}
   */
  use(middleware) {
    this._middleware = Middleware.compose(this._middleware, middleware)
    return this
  }

  /**
   * Register a new RPC method.
   * Usage:
   *   router.method('name', handler)
   * @param {string} method - RPC method name.
   * @param {any} handler - Handler function.
   * @returns {MethodRegistration}
   */
  method(method, handler) {
    const registration = new MethodRegistration(method, Middleware.NOOP, handler)
    this.methods.set(method, registration)
    return registration
  }

  /**
   * Open hook for router, call into middleware chain
   * @returns {Promise<void>}
   */
  async _open() {
    await this._middleware.onopen({ router: this })

    for (const registration of this.methods.values()) {
      await registration.onopen({ router: this, method: registration.method })
    }
  }

  /**
   * Close hook for router, call into middleware chain
   * @returns {Promise<void>}
   */
  async _close() {
    for (const registration of this.methods.values()) {
      await registration.onclose({ router: this, method: registration.method })
    }
    this.methods.clear()
    await this._middleware.onclose({ router: this })
  }
}

module.exports = ProtomuxRpcRouter
