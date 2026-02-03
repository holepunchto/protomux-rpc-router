const test = require('brittle')
const { simpleSetup } = require('./helper')
const b4a = require('b4a')
const cenc = require('compact-encoding')
const safetyCatch = require('safety-catch')
const promClient = require('prom-client')
const { isBare } = require('which-runtime')
const ProtomuxRpcRouter = require('..')

test('composable middlewares run in order (global -> method)', async (t) => {
  const router = new ProtomuxRpcRouter()
  t.teardown(async () => {
    await router.close()
  })
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

  router.use(g1).use(g2)

  router
    .method('echo', async (req) => {
      executions.push('handler')
      return req
    })
    .use(m1)
    .use(m2)

  const makeRequest = await simpleSetup(t, router)
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
  t.teardown(async () => {
    await router.close()
  })

  const throwingMiddleware = {
    onrequest: async () => {
      const error = new Error('boom in middleware')
      error.code = 'BOOM_IN_MIDDLEWARE'
      throw error
    }
  }

  router
    .method('echo', () => {
      t.fail('handler should not be called')
    })
    .use(throwingMiddleware)

  const makeRequest = await simpleSetup(t, router)

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

  router
    .method('fail', async () => {
      const error = new Error('boom in handler')
      error.code = 'BOOM_IN_HANDLER'
      throw error
    })
    .use(doNothingMiddleware)

  const makeRequest = await simpleSetup(t, router)

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

test('middleware open/close runs in correct order', async (t) => {
  const router = new ProtomuxRpcRouter()
  const openings = []
  const closings = []

  const g1 = {
    onopen: async () => openings.push('g1'),
    onclose: async () => closings.push('g1')
  }
  const g2 = {
    onopen: async () => openings.push('g2'),
    onclose: async () => closings.push('g2')
  }
  const m1 = {
    onopen: async () => openings.push('m1'),
    onclose: async () => closings.push('m1')
  }
  const m2 = {
    onopen: async () => openings.push('m2'),
    onclose: async () => closings.push('m2')
  }

  router.use(g1).use(g2)
  router
    .method('echo', () => {})
    .use(m1)
    .use(m2)

  await router.ready()

  // Open should run in registration order:
  // global middlewares first (g1 -> g2), then method-level (m1 -> m2)
  t.alike(openings, ['g1', 'g2', 'm1', 'm2'])

  await router.close()

  // Expect method-level middlewares destroyed first (reverse of registration),
  // then global middlewares (also reverse of registration).
  t.alike(closings, ['m2', 'm1', 'g2', 'g1'])
})

test('middleware open error stops open flow, then closes middleware which were already opened', async (t) => {
  const router = new ProtomuxRpcRouter()
  const openings = []
  const closings = []
  const plannedError = new Error('boom in open')

  const m1 = {
    onopen: async () => openings.push('m1'),
    onclose: async () => closings.push('m1')
  }
  const m2 = {
    onopen: () => {
      throw plannedError
    },
    onclose: async () => closings.push('m2')
  }
  const m3 = {
    onopen: async () => openings.push('m3'),
    onclose: async () => closings.push('m3')
  }

  router.use(m1).use(m2).use(m3)

  try {
    await router.ready()
    t.fail('ready should have thrown')
  } catch (error) {
    t.is(error, plannedError, 'should throw the planned error')
  }

  // Opens should have run up to the failing middleware only.
  t.alike(openings, ['m1'], 'should open up to the failing middleware only')
  t.alike(closings, ['m1'], 'should close the already opened middleware')
})

test('middleware close error does not block closing chain, and throws the aggregate error', async (t) => {
  const router = new ProtomuxRpcRouter()
  const closings = []
  const plannedError1 = new Error('boom 1')
  const plannedError2 = new Error('boom 2')

  const m1 = {
    onclose: async () => {
      closings.push('m1')
    }
  }
  const m2 = {
    onclose: async () => {
      closings.push('m2')
      throw plannedError1
    }
  }
  const m3 = {
    onclose: async () => closings.push('m3')
  }
  const m4 = {
    onclose: async () => {
      closings.push('m4')
      throw plannedError2
    }
  }

  router.use(m1).use(m2).use(m3).use(m4)

  await router.ready()

  try {
    await router.close()
    t.fail('close should have thrown')
  } catch (err) {
    // The first error encountered during closing should be rethrown
    t.ok(err instanceof AggregateError)
    t.is(err.errors.length, 2)
    t.is(err.errors[0], plannedError2)
    t.is(err.errors[1], plannedError1)
  }

  // All close handlers should have been invoked despite errors, in reverse order.
  t.alike(closings, ['m4', 'm3', 'm2', 'm1'])
})

test('method-level middleware isolation', async (t) => {
  const router = new ProtomuxRpcRouter()

  const executions = []

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

  router
    .method('echo-1', (value) => {
      executions.push('echo-1')
      return b4a.concat([value, b4a.from(':1')])
    })
    .use(m1)

  router
    .method('echo-2', (value) => {
      executions.push('echo-2')
      return b4a.concat([value, b4a.from(':2')])
    })
    .use(m2)

  const makeRequest = await simpleSetup(t, router)

  const res1 = await makeRequest('echo-1', b4a.from('foo'))
  t.alike(res1, b4a.from('foo:1'))
  t.alike(executions, ['m1:before', 'echo-1', 'm1:after'])
  executions.length = 0 // reset executions
  const res2 = await makeRequest('echo-2', b4a.from('foo'))
  t.alike(res2, b4a.from('foo:2'))
  t.alike(executions, ['m2:before', 'echo-2', 'm2:after'])
})

test('method supports custom request/response encodings', async (t) => {
  const router = new ProtomuxRpcRouter()
  t.teardown(async () => {
    await router.close()
  })

  router.method(
    'greet',
    { requestEncoding: cenc.string, responseEncoding: cenc.string },
    (name) => `hi ${name}`
  )

  router.method('sum', { requestEncoding: cenc.json, responseEncoding: cenc.json }, ({ a, b }) => ({
    sum: a + b
  }))

  const makeRequest = await simpleSetup(t, router)

  const greetRes = await makeRequest('greet', 'world', {
    requestEncoding: cenc.string,
    responseEncoding: cenc.string
  })
  t.is(greetRes, 'hi world')

  const sumRes = await makeRequest(
    'sum',
    { a: 2, b: 3 },
    { requestEncoding: cenc.json, responseEncoding: cenc.json }
  )
  t.alike(sumRes, { sum: 5 })
})

test('stats counts total requests and errors', async (t) => {
  promClient.register.clear()

  const router = new ProtomuxRpcRouter()
  t.teardown(async () => {
    await router.close()
  })

  router.use({
    onrequest: async (ctx, next) => {
      if (b4a.toString(ctx.value) === 'boom-in-middleware') {
        throw new Error('boom-in-middleware')
      }
      return next()
    }
  })

  router.method('echo', (value) => {
    if (b4a.toString(value) === 'boom-in-handler') {
      throw new Error('boom-in-handler')
    }
    return value
  })

  router.registerMetrics(promClient)

  const makeRequest = await simpleSetup(t, router)

  // 4 successful, 2 failing
  await makeRequest('echo', b4a.from('hello')).catch(safetyCatch)
  await makeRequest('echo', b4a.from('hello again')).catch(safetyCatch)
  await makeRequest('echo', b4a.from('boom-in-middleware')).catch(safetyCatch)
  await makeRequest('echo', b4a.from('boom-in-handler')).catch(safetyCatch)

  function getSumMetricValue(metrics, metricName) {
    const metric = metrics.find((m) => m.name === metricName)
    if (!metric) return 0
    return metric.values.reduce((sum, v) => sum + v.value, 0)
  }

  const metrics = await promClient.register.getMetricsAsJSON()
  const totalRequests = getSumMetricValue(metrics, 'protomux_rpc_router_nr_requests')
  t.is(totalRequests, 4, 'total requests counter')
  const totalErrors = getSumMetricValue(metrics, 'protomux_rpc_router_nr_errors')
  t.is(totalErrors, 2, 'total errors counter')
  const totalHandlerErrors = getSumMetricValue(metrics, 'protomux_rpc_router_nr_handler_errors')
  t.is(totalHandlerErrors, 1, 'total handler errors counter')
})

test('client receives DECODE_ERROR when server cannot decode request', async (t) => {
  const router = new ProtomuxRpcRouter()
  t.teardown(async () => {
    await router.close()
  })

  // Server expects a string, client will send raw Buffer to force a decode failure.
  router.method(
    'expect-string',
    { requestEncoding: cenc.string, responseEncoding: cenc.raw },
    (name) => b4a.from(name)
  )

  const makeRequest = await simpleSetup(t, router)

  try {
    await makeRequest('expect-string', b4a.from('hello'), {
      requestEncoding: cenc.raw,
      responseEncoding: cenc.raw
    })
    t.fail('request should have thrown')
  } catch (err) {
    t.is(err.name, 'RPCError')
    t.is(err.code, 'REQUEST_ERROR')
    t.ok(err.cause.name, 'ProtomuxRpcError')
    t.ok(err.cause.code, 'DECODE_ERROR')
  }
})

test('client receives ENCODE_ERROR when server cannot encode response', async (t) => {
  if (isBare) {
    t.pass('cenc.string does not throw but crash in bare runtime')
    return
  }
  const router = new ProtomuxRpcRouter()
  t.teardown(async () => {
    await router.close()
  })

  // Server will return a Buffer while responseEncoding expects a string, forcing encode failure.
  router.method(
    'string-response',
    { requestEncoding: cenc.raw, responseEncoding: cenc.string },
    () => b4a.from('not-a-string')
  )

  const makeRequest = await simpleSetup(t, router)

  try {
    await makeRequest('string-response', b4a.from('ok'), {
      requestEncoding: cenc.raw,
      responseEncoding: cenc.string
    })
    t.fail('request should have thrown')
  } catch (err) {
    t.is(err.name, 'RPCError')
    t.is(err.code, 'REQUEST_ERROR')
    t.ok(err.cause.name, 'ProtomuxRpcError')
    t.ok(err.cause.code, 'ENCODE_ERROR')
  }
})

test('registerMetrics propagates to middleware chain', async (t) => {
  if (isBare) {
    t.pass('registerMetrics are not supported in bare runtime')
    return
  }
  promClient.register.clear()

  const router = new ProtomuxRpcRouter()
  t.teardown(async () => {
    await router.close()
  })

  const calls = []

  const g1 = {
    registerMetrics(pc) {
      t.is(pc, promClient)
      calls.push('g1')
    }
  }
  const g2 = {
    registerMetrics(pc) {
      t.is(pc, promClient)
      calls.push('g2')
    }
  }
  const m1 = {
    registerMetrics(pc) {
      t.is(pc, promClient)
      calls.push('m1')
    }
  }
  const m2 = {
    registerMetrics(pc) {
      t.is(pc, promClient)
      calls.push('m2')
    }
  }

  router.use(g1)
  router.use(g2)
  router
    .method('echo', (v) => v)
    .use(m1)
    .use(m2)

  router.registerMetrics(promClient)

  // Ensure both global and method-level middlewares received the registerMetrics call.
  t.alike(calls, ['g1', 'g2', 'm1', 'm2'])
})

test('requestId is included in the context', async (t) => {
  const router = new ProtomuxRpcRouter()
  t.teardown(async () => {
    await router.close()
  })

  router.method('echo', (v) => {
    const boom = new Error('boom')
    boom.code = 'BOOM'
    throw boom
  })

  const makeRequest = await simpleSetup(t, router)

  try {
    await makeRequest('echo', b4a.from('hello'))
    t.fail('request should have thrown')
  } catch (err) {
    t.is(err.code, 'REQUEST_ERROR')
    t.ok(err.cause.code, 'BOOM')
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    t.ok(
      uuidRegex.test(err.cause.context),
      'requestId is included in the context and is a valid UUID'
    )
  }
})
