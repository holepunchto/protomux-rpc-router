const test = require('brittle')
const b4a = require('b4a')
const { setUpTestClient } = require('./helper')
const ProtomuxRpcRouter = require('..')
const cenc = require('compact-encoding')

test.solo('encoding middleware decodes request before handler (cenc.string)', async (t) => {
  const router = new ProtomuxRpcRouter()
  t.teardown(async () => {
    await router.destroy()
  })

  router.method(
    'echo',
    ProtomuxRpcRouter.encoding({ request: cenc.string, response: cenc.buffer }),
    async (value) => {
      // handler should see a decoded string; return Buffer
      return b4a.from(value)
    }
  )

  const makeRequest = await setUpTestClient(t, router, {
    requestEncoding: cenc.string,
    responseEncoding: cenc.buffer
  })
  const res = await makeRequest('echo', 'foo')
  t.alike(res, b4a.from('foo'))
})

test('encoding middleware encodes response after handler (cenc.string)', async (t) => {
  const router = new ProtomuxRpcRouter()
  t.teardown(async () => {
    await router.destroy()
  })

  router.method('hello', ProtomuxRpcRouter.encoding({ response: cenc.string }), async () => {
    return 'ok'
  })

  const makeRequest = await setUpTestClient(t, router)
  const res = await makeRequest('hello', b4a.from('x'))
  t.alike(res, cenc.encode(cenc.string, 'ok'))
})

test('encoding middleware applies both request and response encoders (string)', async (t) => {
  const router = new ProtomuxRpcRouter()
  t.teardown(async () => {
    await router.destroy()
  })

  router.method(
    'roundtrip',
    ProtomuxRpcRouter.encoding({
      request: cenc.string,
      response: cenc.string
    }),
    async (req) => {
      // echo back request; response encoder should run afterwards
      return req
    }
  )

  const makeRequest = await setUpTestClient(t, router, {
    requestEncoding: cenc.string,
    responseEncoding: cenc.buffer
  })
  const res = await makeRequest('roundtrip', 'v')
  t.alike(res, cenc.encode(cenc.string, 'v'))
})
