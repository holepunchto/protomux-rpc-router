const test = require('brittle')
const { simpleSetup } = require('./helper')
const b4a = require('b4a')
const ProtomuxRpcRouter = require('..')

test('composable middlewares run in order (global -> method)', async (t) => {
  const router = new ProtomuxRpcRouter()
  t.teardown(async () => {
    await router.destroy()
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

  router.use(g1, g2)

  router.method('echo', m1, m2, async (req) => {
    executions.push('handler')
    return req
  })

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

  router.method('fail', doNothingMiddleware, async (req) => {
    const error = new Error('boom in handler')
    error.code = 'BOOM_IN_HANDLER'
    throw error
  })

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

  router.method('echo-1', m1, (value) => {
    executions.push('echo-1')
    return b4a.concat([value, b4a.from('------1')])
  })
  router.method('echo-2', m2, (value) => {
    executions.push('echo-2')
    return b4a.concat([value, b4a.from('------2')])
  })

  const makeRequest = await simpleSetup(t, router)

  const res1 = await makeRequest('echo-1', b4a.from('foo'))
  t.alike(res1, b4a.from('foo'))
  t.alike(executions, ['m1:before', 'echo-1', 'm1:after'])
  executions.length = 0 // reset executions
  const res2 = await makeRequest('echo-2', b4a.from('foo'))
  t.alike(res2, b4a.from('foo'))
  t.alike(executions, ['m2:before', 'echo-2', 'm2:after'])
})
