const ProtomuxRPC = require('protomux-rpc')
const ReadyResource = require('ready-resource')
const Middleware = require('./lib/middleware')
const ProtomuxRpcRouterError = require('./lib/errors')
const cenc = require('compact-encoding')

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
  constructor(method, middleware, options, handler) {
    this.method = method
    this._middleware = middleware
    this._options = options
    this._handler = handler
  }

  /**
   * Attach additional middleware to this method (appended to existing chain).
   * @param {Partial<Middleware>} middleware - The middleware object to attach.
   * @returns {this}
   */
  use(middleware) {
    this._middleware = Middleware.compose(this._middleware, Middleware.wrap(middleware))
    return this
  }

  /**
   * Open hook for method, call into middleware chain
   * @returns {Promise<void>}
   */
  async onopen() {
    await this._middleware.onopen()
  }

  /**
   * Close hook for method, call into middleware chain
   * @returns {Promise<void>}
   */
  async onclose() {
    await this._middleware.onclose()
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
    this.stats = {
      nrRequests: 0,
      nrErrors: 0,
      nrHandlerErrors: 0
    }
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
    if (this.closing) {
      throw ProtomuxRpcRouterError.ROUTER_CLOSED()
    }
    const rpc = new ProtomuxRPC(connection, {
      id: protomuxRpcId,
      valueEncoding: null
    })
    this.methods.forEach((registration) => {
      const combinedMiddleware = Middleware.compose(this._middleware, registration._middleware)

      rpc.respond(registration.method, async (value) => {
        this.stats.nrRequests++
        const ctx = {
          method: registration.method,
          value,
          connection
        }
        try {
          return await combinedMiddleware.onrequest(ctx, async () => {
            try {
              const { requestEncoding, responseEncoding } = registration._options
              const value = cenc.decode(requestEncoding, ctx.value)
              const res = await registration._handler(value, ctx)
              return cenc.encode(responseEncoding, res)
            } catch (error) {
              this.stats.nrHandlerErrors++
              throw error
            }
          })
        } catch (error) {
          this.stats.nrErrors++
          throw error
        }
      })
    })
  }

  /**
   * Add global middleware applied to every method.
   * @param {Partial<Middleware>} middleware - The middleware object to attach.
   * @returns {this}
   */
  use(middleware) {
    this._middleware = Middleware.compose(this._middleware, Middleware.wrap(middleware))
    return this
  }

  /**
   * Register a new RPC method.
   * Usage:
   *   router.method('name', handler)
   * @param {string} method - RPC method name.
   * @param {Object} options - Method options.
   * @param {any} options.requestEncoding - Middleware to apply to the method request encoding.
   * @param {any} options.responseEncoding - Middleware to apply to the method response encoding.
   * @param {(req: any, ctx: RpcContext) => any|Promise<any>} handler - Handler function.
   * @returns {MethodRegistration}
   */
  method(method, options, handler) {
    if (typeof options === 'function') {
      handler = options
      options = {}
    }
    if (!options.requestEncoding) {
      options.requestEncoding = cenc.raw
    }
    if (!options.responseEncoding) {
      options.responseEncoding = cenc.raw
    }
    const registration = new MethodRegistration(method, Middleware.NOOP, options, handler)
    this.methods.set(method, registration)
    return registration
  }

  /**
   * Open hook for router, call into middleware chain
   * @returns {Promise<void>}
   */
  async _open() {
    await this._middleware.onopen()

    for (const registration of this.methods.values()) {
      await registration.onopen()
    }
  }

  /**
   * Close hook for router, call into middleware chain
   * @returns {Promise<void>}
   */
  async _close() {
    let aggregateError = null
    for (const registration of this.methods.values()) {
      try {
        await registration.onclose()
      } catch (error) {
        aggregateError = ProtomuxRpcRouterError.aggregate(aggregateError, error)
      }
    }
    this.methods.clear()
    try {
      await this._middleware.onclose()
    } catch (error) {
      aggregateError = ProtomuxRpcRouterError.aggregate(aggregateError, error)
    }
    if (aggregateError) {
      throw aggregateError
    }
  }

  /**
   * Register metrics with prom-client.
   * @param {typeof import('prom-client')} promClient
   */
  registerMetrics(promClient) {
    const self = this

    new promClient.Gauge({
      name: 'protomux_rpc_router_nr_requests',
      help: 'The number of requests processed by the router',
      collect() {
        this.set(self.stats.nrRequests)
      }
    })

    new promClient.Gauge({
      name: 'protomux_rpc_router_nr_errors',
      help: 'The number of errors processed by the router',
      collect() {
        this.set(self.stats.nrErrors)
      }
    })

    new promClient.Gauge({
      name: 'protomux_rpc_router_nr_handler_errors',
      help: 'The number of handler errors processed by the router',
      collect() {
        this.set(self.stats.nrHandlerErrors)
      }
    })
  }
}

module.exports = ProtomuxRpcRouter
