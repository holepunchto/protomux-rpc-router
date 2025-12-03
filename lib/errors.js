class ProtomuxRpcRouterError extends Error {
  constructor(msg, code, fn = ProtomuxRpcRouterError) {
    super(`${code}: ${msg}`)
    this.code = code

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, fn)
    }
  }

  get name() {
    return 'ProtomuxRpcRouterError'
  }

  static ROUTER_NOT_READY() {
    return new ProtomuxRpcRouterError(
      'The router is not ready',
      'ROUTER_NOT_READY',
      ProtomuxRpcRouterError.ROUTER_NOT_READY
    )
  }

  static ROUTER_CLOSED() {
    return new ProtomuxRpcRouterError(
      'The router is closed',
      'ROUTER_CLOSED',
      ProtomuxRpcRouterError.ROUTER_CLOSED
    )
  }
}

module.exports = ProtomuxRpcRouterError
