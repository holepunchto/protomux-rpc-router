const test = require('brittle')
const getTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const ProtomuxRpcClient = require('protomux-rpc-client')
const cenc = require('compact-encoding')
const b4a = require('b4a')
const ProtomuxRpcRouter = require('..')

async function setUpTestClient(
  t,
  router,
  requestOpts = { requestEncoding: cenc.buffer, responseEncoding: cenc.buffer }
) {
  const testnet = await getTestnet()
  t.teardown(async () => {
    await testnet.destroy()
  })
  const { bootstrap } = testnet

  const serverDht = new HyperDHT({ bootstrap })
  t.teardown(async () => {
    await serverDht.destroy()
  })
  const server = serverDht.createServer()
  server.on('connection', async (connection) => {
    await router.handleConnection(connection)
  })
  await server.listen()
  t.teardown(async () => {
    await server.close()
  })

  const clientDht = new HyperDHT({ bootstrap })
  t.teardown(async () => {
    await clientDht.destroy()
  })
  const client = new ProtomuxRpcClient(clientDht)
  t.teardown(async () => {
    await client.close()
  })
  return (method, params) => {
    return client.makeRequest(server.address().publicKey, method, params, requestOpts)
  }
}

test('composable middlewares run in order (global -> method)', async (t) => {
  const router = new ProtomuxRpcRouter()
  const executions = []

  const g1 = {
    onrequest: async (ctx, next) => {
      executions.push('g1:before')
      const res = await next()
      executions.push('g1:after')
      return res
    }
  }

  const g2 = {
    onrequest: async (ctx, next) => {
      executions.push('g2:before')
      const res = await next()
      executions.push('g2:after')
      return res
    }
  }

  const m1 = {
    onrequest: async (ctx, next) => {
      executions.push('m1:before')
      const res = await next()
      executions.push('m1:after')
      return res
    }
  }
  const m2 = {
    onrequest: async (ctx, next) => {
      executions.push('m2:before')
      const res = await next()
      executions.push('m2:after')
      return res
    }
  }

  router.use(g1, g2)

  router.method('echo', m1, m2, async (req) => {
    executions.push('handler')
    return req
  })

  const makeRequest = await setUpTestClient(t, router)
  const res = await makeRequest('echo', b4a.from('foo'))

  t.alike(res, b4a.from('foo'))
  t.alike(executions, [
    'g1:before',
    'g2:before',
    'm1:before',
    'm2:before',
    'handler',
    'm2:after',
    'm1:after',
    'g2:after',
    'g1:after'
  ])
})

test('client receives error when middleware throws', async (t) => {
  const router = new ProtomuxRpcRouter()

  const throwingMiddleware = {
    onrequest: async (ctx, next) => {
      const error = new Error('boom in middleware')
      error.code = 'BOOM_IN_MIDDLEWARE'
      throw error
    }
  }

  router.method('echo', throwingMiddleware, async (req) => {
    return req
  })

  const makeRequest = await setUpTestClient(t, router)

  try {
    await makeRequest('echo', b4a.from('foo'))
    t.fail('request should have thrown')
  } catch (err) {
    t.is(err.name, 'RPCError')
    t.is(err.code, 'REQUEST_ERROR')
    t.ok(err.cause)
    t.is(err.cause.code, 'BOOM_IN_MIDDLEWARE')
    t.is(err.cause.message, 'boom in middleware')
  }
})

test('client receives error when handler throws', async (t) => {
  const router = new ProtomuxRpcRouter()

  const doNothingMiddleware = {
    onrequest: async (ctx, next) => {
      return next()
    }
  }

  router.method('fail', doNothingMiddleware, async (req) => {
    const error = new Error('boom in handler')
    error.code = 'BOOM_IN_HANDLER'
    throw error
  })

  const makeRequest = await setUpTestClient(t, router)

  try {
    await makeRequest('fail', b4a.from('bar'))
    t.fail('request should have thrown')
  } catch (err) {
    t.is(err.name, 'RPCError')
    t.is(err.code, 'REQUEST_ERROR')
    t.ok(err.cause)
    t.is(err.cause.code, 'BOOM_IN_HANDLER')
    t.is(err.cause.message, 'boom in handler')
  }
})

test('middleware try/catch/finally logs on success/failure', async (t) => {
  const router = new ProtomuxRpcRouter()
  const logs = []
  let globalRequestId = 0

  const loggingMiddleware = {
    onrequest: async (ctx, next) => {
      const requestId = globalRequestId++
      let caughtError = null
      try {
        const res = await next()
        return res
      } catch (err) {
        caughtError = err
        throw err
      } finally {
        if (caughtError) {
          logs.push({
            event: 'error',
            message: caughtError.message,
            code: caughtError.code,
            method: ctx.method,
            requestId
          })
        }
        logs.push({ event: 'end', method: ctx.method, hadError: !!caughtError, requestId })
      }
    }
  }

  router.method('echo', loggingMiddleware, async (req) => {
    return req
  })
  router.method('fail', loggingMiddleware, async (req) => {
    const error = new Error('boom in handler')
    error.code = 'BOOM_FOR_LOGGING'
    throw error
  })

  const makeRequest = await setUpTestClient(t, router)
  {
    const res = await makeRequest('echo', b4a.from('ok'))
    t.alike(res, b4a.from('ok'))
    t.alike(logs[0], { event: 'end', method: 'echo', hadError: false, requestId: 0 })
  }

  await t.exception(async () => {
    await makeRequest('fail', b4a.from('x'))
  })
  {
    t.alike(logs[1], {
      event: 'error',
      message: 'boom in handler',
      code: 'BOOM_FOR_LOGGING',
      method: 'fail',
      requestId: 1
    })
    t.alike(logs[2], { event: 'end', method: 'fail', hadError: true, requestId: 1 })
  }
})

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
          logs.push({ event: 'end', method: ctx.method, hadError: !!caughtError })
        }
      }
    }
  }

  // Add logger globally so it runs before method-level middlewares
  router.use(logger)

  // Method-level skip so it executes after the logger
  const skipLogger = {
    onrequest: async (ctx, next) => {
      ctx.skipLogging = true
      return next()
    }
  }

  router.method('echo', skipLogger, async (req) => {
    return req
  })

  const makeRequest = await setUpTestClient(t, router)
  const res = await makeRequest('echo', b4a.from('ok'))

  t.alike(res, b4a.from('ok'))
  t.alike(logs, [])
})

test('middleware destroy runs in reverse; method middlewares before global', async (t) => {
  const router = new ProtomuxRpcRouter()
  const destructions = []

  const g1 = { destroy: async () => destructions.push('g1') }
  const g2 = { destroy: async () => destructions.push('g2') }
  const m1 = { destroy: async () => destructions.push('m1') }
  const m2 = { destroy: async () => destructions.push('m2') }

  router.use(g1, g2)
  router.method('echo', m1, m2, async (req) => req)

  await router.destroy()

  // Expect method-level middlewares destroyed first (reverse of registration),
  // then global middlewares (also reverse of registration).
  t.alike(destructions, ['m2', 'm1', 'g2', 'g1'])
})
