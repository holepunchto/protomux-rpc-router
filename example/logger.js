const b4a = require('b4a')
const Middleware = require('../lib/middleware')

module.exports = function logger() {
  return {
    ...Middleware.NOOP,
    onrequest: async ({ method, connection }, next) => {
      let caughtError = null
      const startTime = Date.now()
      console.log(
        `[method=${method}] [key=${b4a.toString(connection.remotePublicKey, 'base64')}] [ip=${connection.rawStream.remoteHost}] started`
      )
      try {
        return await next()
      } catch (error) {
        caughtError = error
        throw error
      } finally {
        if (caughtError) {
          console.error('CENTRALIZED ERROR LOG', caughtError)
        }
        const endTime = Date.now()
        const duration = endTime - startTime
        console.log(
          `[method=${method}] [key=${b4a.toString(connection.remotePublicKey, 'base64')}] [ip=${connection.rawStream.remoteHost}] completed after ${duration}ms${caughtError ? ` with error: "${caughtError.message}"` : ''}`
        )
      }
    }
  }
}
