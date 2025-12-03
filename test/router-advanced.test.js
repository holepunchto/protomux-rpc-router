const test = require('brittle')
const { createKeyPair, setUpNetwork, setUpServer, simpleSetup } = require('./helper')
const ProtomuxRpcRouter = require('..')
const HyperDHT = require('hyperdht')
const ProtomuxRpcClient = require('protomux-rpc-client')
const cenc = require('compact-encoding')
const b4a = require('b4a')
const Middleware = require('../lib/middleware')

test('middleware can enrich context; logger respects skip flags', async (t) => {
  const router = new ProtomuxRpcRouter()
  const logs = []

  const logger = {
    ...Middleware.NOOP,
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

  const clientDht = new HyperDHT({ bootstrap })
  t.teardown(async () => {
    await clientDht.destroy()
  })
  const userClient = new ProtomuxRpcClient(clientDht, { keyPair: userKeyPair })
  t.teardown(async () => {
    await userClient.close()
  })
  const adminClient = new ProtomuxRpcClient(clientDht, { keyPair: adminKeyPair })
  t.teardown(async () => {
    await adminClient.close()
  })
  const userRole = await userClient.makeRequest(
    server.address().publicKey,
    'inspect-role',
    b4a.from('afas'),
    {
      requestEncoding: cenc.raw,
      responseEncoding: cenc.raw
    }
  )
  t.alike(userRole, b4a.from('user'), 'user can inspect role and get "user"')
  const adminRole = await adminClient.makeRequest(
    server.address().publicKey,
    'inspect-role',
    b4a.from(''),
    {
      requestEncoding: cenc.raw,
      responseEncoding: cenc.raw
    }
  )
  t.alike(adminRole, b4a.from('admin'), 'admin can inspect role and get "admin"')
  await t.exception(
    () =>
      userClient.makeRequest(server.address().publicKey, 'echo-admin', b4a.from('hello'), {
        requestEncoding: cenc.raw,
        responseEncoding: cenc.raw
      }),
    'user cannot echo using echo-admin'
  )
  const userEcho = await userClient.makeRequest(
    server.address().publicKey,
    'echo-user',
    b4a.from('hello'),
    {
      requestEncoding: cenc.raw,
      responseEncoding: cenc.raw
    }
  )
  t.alike(userEcho, b4a.from('hello'), 'user can echo using echo-user')
  const adminEcho = await adminClient.makeRequest(
    server.address().publicKey,
    'echo-admin',
    b4a.from('hello'),
    {
      requestEncoding: cenc.raw,
      responseEncoding: cenc.raw
    }
  )
  t.alike(adminEcho, b4a.from('hello'), 'admin can echo using echo-admin')
  await t.exception(
    () =>
      adminClient.makeRequest(server.address().publicKey, 'echo-user', b4a.from('hello'), {
        requestEncoding: cenc.raw,
        responseEncoding: cenc.raw
      }),
    'admin cannot echo using echo-user'
  )
})
