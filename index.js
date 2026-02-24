const ProtomuxRPC = require('protomux-rpc')
const ReadyResource = require('ready-resource')
const crypto = require('crypto')
const HyperswarmCapability = require('hyperswarm-capability')
const Middleware = require('./lib/middleware')
const ProtomuxRpcRouterError = require('./lib/errors')
const cenc = require('compact-encoding')
const ProtomuxRpcError = require('protomux-rpc/errors')

const Handshake = HyperswarmCapability.Encoding

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
   * @param {import('compact-encoding').Encoder} requestEncoding
   * @param {import('compact-encoding').Encoder} responseEncoding
   * @param {(req: any) => any|Promise<any>} handler
   */
  constructor(method, middleware, requestEncoding, responseEncoding, handler) {
    this.method = method
    this.middleware = middleware
    this.requestEncoding = requestEncoding
    this.responseEncoding = responseEncoding
    this.handler = handler
  }

  /**
   * Attach additional middleware to this method (appended to existing chain).
   * @param {Partial<Middleware>} middleware - The middleware object to attach.
   * @returns {this}
   */
  use(middleware) {
    this.middleware = Middleware.compose(this.middleware, Middleware.wrap(middleware))
    return this
  }
}

/**
 * Router that exposes protomux-rpc responders with a composable middleware model.
 */
class ProtomuxRpcRouter extends ReadyResource {
  static Middleware = Middleware

  /**
   * Create a new router.
   * @param {Object} [options]
   * @param {Buffer} [options.namespace] - Optional namespace for capability.
   * @param {Buffer} [options.capability] - Optional capability key. Enables capability verification.
   */
  constructor({ namespace = null, capability = null } = {}) {
    super()

    this._cap = capability ? new HyperswarmCapability(namespace) : null
    this._capability = capability

    /** @type {Map<string, MethodRegistration>} */
    this.methods = new Map()
    /** @type {Middleware} */
    this.middleware = Middleware.NOOP
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
      valueEncoding: null,
      handshakeEncoding: this._capability ? Handshake : null,
      handshake: this._capability
        ? { capability: this._cap.generate(connection, this._capability) }
        : null
    })

    if (this._capability) {
      rpc.on('open', (handshake) => {
        if (
          !handshake?.capability ||
          !this._cap.verify(connection, this._capability, handshake.capability)
        ) {
          rpc.destroy(new Error('Remote sent invalid capability'))
          this.emit('capability-error', { connection })
        }
      })
    }

    this.methods.forEach((registration) => {
      const combinedMiddleware = Middleware.compose(this.middleware, registration.middleware)

      rpc.respond(registration.method, async (value) => {
        const requestId = crypto.randomUUID()
        this.stats.nrRequests++
        const ctx = {
          requestId,
          method: registration.method,
          value,
          connection
        }
        try {
          return await combinedMiddleware.onrequest(ctx, async () => {
            try {
              let req
              try {
                req = cenc.decode(registration.requestEncoding, ctx.value)
              } catch (error) {
                throw ProtomuxRpcError.DECODE_ERROR('Could not decode request', error)
              }
              const res = await registration.handler(req, ctx)

              try {
                return cenc.encode(registration.responseEncoding, res)
              } catch (error) {
                throw ProtomuxRpcError.ENCODE_ERROR('Could not encode response', error)
              }
            } catch (error) {
              this.stats.nrHandlerErrors++
              throw error
            }
          })
        } catch (error) {
          this.stats.nrErrors++
          error.context = requestId
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
    this.middleware = Middleware.compose(this.middleware, Middleware.wrap(middleware))
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
    const { requestEncoding = cenc.raw, responseEncoding = cenc.raw } = options

    const registration = new MethodRegistration(
      method,
      Middleware.NOOP,
      requestEncoding,
      responseEncoding,
      handler
    )
    this.methods.set(method, registration)
    return registration
  }

  /**
   * Open hook for router, call into middleware chain
   * @returns {Promise<void>}
   */
  async _open() {
    await this.middleware.onopen()

    for (const registration of this.methods.values()) {
      await registration.middleware.onopen()
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
        await registration.middleware.onclose()
      } catch (error) {
        aggregateError = ProtomuxRpcRouterError.aggregate(aggregateError, error)
      }
    }
    this.methods.clear()
    try {
      await this.middleware.onclose()
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

    this.middleware.registerMetrics(promClient)

    for (const registration of this.methods.values()) {
      registration.middleware.registerMetrics(promClient)
    }
  }
}

module.exports = ProtomuxRpcRouter
