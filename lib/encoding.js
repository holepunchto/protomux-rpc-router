/**
 * @typedef {import('..').Middleware} Middleware
 */

/**
 * Create a middleware that encodes request/response payloads using the provided encoders.
 *
 * The encoders follow the `compact-encoding` interface: `{ encode: (value:any) => any }`.
 *
 * @param {{ request?: any, response?: any }} [options]
 * @returns {Middleware}
 */
module.exports = function ({ request: requestEncoding, response: responseEncoding } = {}) {
  return {
    onrequest: async (ctx, next) => {
      if (requestEncoding) {
        ctx.req.value = requestEncoding.encode(ctx.req.value)
      }
      const res = await next()
      if (responseEncoding) {
        return responseEncoding.encode(res)
      } else {
        return res
      }
    }
  }
}
