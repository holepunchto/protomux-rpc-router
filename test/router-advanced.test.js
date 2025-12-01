const test = require('brittle')
const { createKeyPair, setUpNetwork, setUpServer, simpleSetup } = require('./helper')
const ProtomuxRpcRouter = require('..')
const HyperDHT = require('hyperdht')
const ProtomuxRpcClient = require('protomux-rpc-client')
const cenc = require('compact-encoding')
const encoding = require('../lib/encoding')
const b4a = require('b4a')

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
      onrequest: async (ctx, next) => {
        ctx.skipLogging = value
        return next()
      }
    }
  }

  router.method('echo', (value) => value)
  router.method('echo-skip-logging', skipLogging(true), (value) => value)
  router.method('echo-skip-logging-false', skipLogging(false), (value) => value)

  const makeRequest = await simpleSetup(t, router)
  await makeRequest('echo', b4a.from('ok'))

  t.alike(logs, [{ event: 'request', method: 'echo', hadError: false }])

  await makeRequest('echo-skip-logging', b4a.from('ok'))
  t.is(logs.length, 1, 'no new log when calling method with skipLogging flag set')

  await makeRequest('echo-skip-logging-false', b4a.from('ok'))
  t.is(logs.length, 2, 'new log when calling method with skipLogging flag set to false')
  t.alike(logs[1], { event: 'request', method: 'echo-skip-logging-false', hadError: false })
})

test('middleware can enrich context; simple acl', async (t) => {
  const router = new ProtomuxRpcRouter()

  const adminKeyPair = createKeyPair()
  const userKeyPair = createKeyPair()

  const authorization = {
    onrequest: async (ctx, next) => {
      let role = null
      if (b4a.compare(ctx.connection.remotePublicKey, adminKeyPair.publicKey) === 0) {
        role = 'admin'
      } else if (b4a.compare(ctx.connection.remotePublicKey, userKeyPair.publicKey) === 0) {
        role = 'user'
      }
      ctx.role = role
      return next()
    }
  }

  // Add authorization globally so it runs before method-level middlewares
  router.use(authorization)

  // Method-level acl
  function allowRoles(...roles) {
    return {
      onrequest: async (ctx, next) => {
        if (!roles.includes(ctx.role)) {
          throw new Error('forbidden')
        }
        return next()
      }
    }
  }

  router.method(
    'inspect-role',
    encoding({ request: cenc.string, response: cenc.string }),
    (value, ctx) => {
      // handler can access the enriched context (role)
      return ctx.role
    }
  )
  router.method(
    'echo-admin',
    allowRoles('admin'),
    encoding({ request: cenc.string, response: cenc.string }),
    (value) => value
  )
  router.method(
    'echo-user',
    allowRoles('user'),
    encoding({ request: cenc.string, response: cenc.string }),
    (value) => value
  )

  const { bootstrap } = await setUpNetwork(t)
  const server = await setUpServer(t, bootstrap, router)
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
  const userRole = await userClient.makeRequest(server.address().publicKey, 'inspect-role', '', {
    requestEncoding: cenc.string,
    responseEncoding: cenc.string
  })
  t.is(userRole, 'user', 'user can inspect role and get "user"')
  const adminRole = await adminClient.makeRequest(server.address().publicKey, 'inspect-role', '', {
    requestEncoding: cenc.string,
    responseEncoding: cenc.string
  })
  t.is(adminRole, 'admin', 'admin can inspect role and get "admin"')
  await t.exception(
    () =>
      userClient.makeRequest(server.address().publicKey, 'echo-admin', 'hello', {
        requestEncoding: cenc.string,
        responseEncoding: cenc.string
      }),
    'user cannot echo using echo-admin'
  )
  const userEcho = await userClient.makeRequest(server.address().publicKey, 'echo-user', 'hello', {
    requestEncoding: cenc.string,
    responseEncoding: cenc.string
  })
  t.is(userEcho, 'hello', 'user can echo using echo-user')
  const adminEcho = await adminClient.makeRequest(
    server.address().publicKey,
    'echo-admin',
    'hello',
    {
      requestEncoding: cenc.string,
      responseEncoding: cenc.string
    }
  )
  t.is(adminEcho, 'hello', 'admin can echo using echo-admin')
  await t.exception(
    () =>
      adminClient.makeRequest(server.address().publicKey, 'echo-user', 'hello', {
        requestEncoding: cenc.string,
        responseEncoding: cenc.string
      }),
    'admin cannot echo using echo-user'
  )
})
