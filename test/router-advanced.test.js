const test = require('brittle')
const { createKeyPair, setUpNetwork, setUpServer, simpleSetup, createClient } = require('./helper')
const ProtomuxRpcRouter = require('..')
const b4a = require('b4a')
const Middleware = require('../lib/middleware')

test('middleware can enrich context; logger respects skip flags', async (t) => {
  const router = new ProtomuxRpcRouter()
  const logs = []

  const logger = {
    onrequest: async (ctx, next) => {
      let caughtError = null
      try {
        return await next()
      } catch (err) {
        caughtError = err
        throw err
      } finally {
        // Respect skip flag set by method-level middleware (executes after logger)
        if (!ctx.skipLogging) {
          logs.push({ event: 'request', method: ctx.method, hadError: !!caughtError })
        }
      }
    }
  }

  // Add logger globally so it runs before method-level middlewares
  router.use(logger)

  // Method-level skip so it executes after the logger
  function skipLogging(value) {
    return {
      ...Middleware.NOOP,
      onrequest: async (ctx, next) => {
        ctx.skipLogging = value
        return next()
      }
    }
  }

  router.method('echo', (value) => value)
  router.method('echo-skip-logging', (value) => value).use(skipLogging(true))
  router.method('echo-skip-logging-false', (value) => value).use(skipLogging(false))

  const makeRequest = await simpleSetup(t, router)

  const res1 = await makeRequest('echo', b4a.from('ok'))
  t.alike(res1, b4a.from('ok'))
  t.alike(logs, [{ event: 'request', method: 'echo', hadError: false }])

  const res2 = await makeRequest('echo-skip-logging', b4a.from('ok'))
  t.alike(res2, b4a.from('ok'))
  t.is(logs.length, 1, 'no new log when calling method with skipLogging flag set')

  const res3 = await makeRequest('echo-skip-logging-false', b4a.from('ok'))
  t.alike(res3, b4a.from('ok'))
  t.is(logs.length, 2, 'new log when calling method with skipLogging flag set to false')
  t.alike(logs[1], { event: 'request', method: 'echo-skip-logging-false', hadError: false })
})

test('middleware can enrich context; simple acl', async (t) => {
  const router = new ProtomuxRpcRouter()

  const adminKeyPair = createKeyPair()
  const userKeyPair = createKeyPair()

  const authorization = {
    ...Middleware.NOOP,
    onrequest: async (ctx, next) => {
      let role = null
      if (b4a.compare(ctx.connection.remotePublicKey, adminKeyPair.publicKey) === 0) {
        role = 'admin'
      } else if (b4a.compare(ctx.connection.remotePublicKey, userKeyPair.publicKey) === 0) {
        role = 'user'
      }
      ctx.role = role
      return await next()
    }
  }

  // Add authorization globally so it runs before method-level middlewares
  router.use(authorization)

  // Method-level acl
  function allowRoles(...roles) {
    return {
      ...Middleware.NOOP,
      onrequest: async (ctx, next) => {
        if (!roles.includes(ctx.role)) {
          throw new Error('forbidden')
        }
        return await next()
      }
    }
  }

  router.method('inspect-role', (value, ctx) => {
    // handler can access the enriched context (role)
    return b4a.from(ctx.role)
  })
  router.method('echo-admin', (value) => value).use(allowRoles('admin'))
  router.method('echo-user', (value) => value).use(allowRoles('user'))

  const { bootstrap } = await setUpNetwork(t)
  const server = await setUpServer(t, bootstrap, router)
  await router.ready()

  const userRpc = await createClient(t, bootstrap, server.address().publicKey, {
    keyPair: userKeyPair
  })
  const adminRpc = await createClient(t, bootstrap, server.address().publicKey, {
    keyPair: adminKeyPair
  })

  const userRole = await userRpc.request('inspect-role', b4a.from('afas'))
  t.alike(userRole, b4a.from('user'), 'user can inspect role and get "user"')

  const adminRole = await adminRpc.request('inspect-role', b4a.from(''))
  t.alike(adminRole, b4a.from('admin'), 'admin can inspect role and get "admin"')

  await t.exception(
    () => userRpc.request('echo-admin', b4a.from('hello')),
    'user cannot echo using echo-admin'
  )

  const userEcho = await userRpc.request('echo-user', b4a.from('hello'))
  t.alike(userEcho, b4a.from('hello'), 'user can echo using echo-user')

  const adminEcho = await adminRpc.request('echo-admin', b4a.from('hello'))
  t.alike(adminEcho, b4a.from('hello'), 'admin can echo using echo-admin')

  await t.exception(
    () => adminRpc.request('echo-user', b4a.from('hello')),
    'admin cannot echo using echo-user'
  )
})
