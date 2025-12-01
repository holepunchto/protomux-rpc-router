const test = require('brittle')
const b4a = require('b4a')
const { simpleSetup: setUpTestClient } = require('./helper')
const ProtomuxRpcRouter = require('..')
const cenc = require('compact-encoding')

test('encoding middleware decodes request before handler (cenc.string)', async (t) => {
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

  const makeRequest = await setUpTestClient(t, router)
  const res = await makeRequest('echo', 'foo', {
    requestEncoding: cenc.string,
    responseEncoding: cenc.buffer
  })
  t.alike(res, b4a.from('foo'))
})

test('encoding middleware encodes response after handler (cenc.string)', async (t) => {
  const router = new ProtomuxRpcRouter()
  t.teardown(async () => {
    await router.destroy()
  })

  router.method(
    'echo',
    ProtomuxRpcRouter.encoding({ request: cenc.buffer, response: cenc.string }),
    async (req) => {
      console.log('echo', req)
      return b4a.toString(req)
    }
  )

  const makeRequest = await setUpTestClient(t, router)
  const res = await makeRequest('echo', b4a.from('hello'), {
    requestEncoding: cenc.buffer,
    responseEncoding: cenc.string
  })
  t.alike(res, 'hello')
})

test('encoding middleware applies both request and response encoders (string)', async (t) => {
  const router = new ProtomuxRpcRouter()
  t.teardown(async () => {
    await router.destroy()
  })

  router.method(
    'echo',
    ProtomuxRpcRouter.encoding({
      request: cenc.string,
      response: cenc.string
    }),
    async (req) => {
      // echo back request; response encoder should run afterwards
      return req
    }
  )

  const makeRequest = await setUpTestClient(t, router)
  const res = await makeRequest('echo', 'hello', {
    requestEncoding: cenc.string,
    responseEncoding: cenc.string
  })
  t.alike(res, 'hello')
})
