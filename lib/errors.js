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

  /**
   * Aggregate multiple errors into a single AggregateError, flattening nested errors, skip null errors.
   * @param {...Error} errors - The errors to aggregate.
   * @returns {AggregateError} The aggregated error.
   */
  static aggregate(...errors) {
    let combinedErrors = []

    for (const error of errors) {
      if (error instanceof AggregateError) {
        combinedErrors.push(...error.errors)
      } else if (error) {
        combinedErrors.push(error)
      }
    }
    return new AggregateError(combinedErrors)
  }
}

module.exports = ProtomuxRpcRouterError
