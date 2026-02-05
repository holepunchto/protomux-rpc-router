const test = require('brittle')
const b4a = require('b4a')
const { createClient, setUpNetwork, setUpServer } = require('./helper')
const ProtomuxRpcRouter = require('..')

test('valid capability - client connects successfully', async (t) => {
  const router = new ProtomuxRpcRouter({
    namespace: b4a.from('test-namespace'),
    capability: b4a.from('test-capability')
  })

  router.method('echo', (value) => value)

  const { bootstrap } = await setUpNetwork(t)
  const server = await setUpServer(t, bootstrap, router)
  await router.ready()

  t.teardown(() => router.close())

  const rpc = await createClient(t, bootstrap, server.address().publicKey, {
    namespace: b4a.from('test-namespace'),
    capability: b4a.from('test-capability')
  })

  const result = await rpc.request('echo', b4a.from('hello'))
  t.alike(result, b4a.from('hello'))
})

test('invalid capability - client is rejected and capability-error emitted', async (t) => {
  t.plan(1)

  const router = new ProtomuxRpcRouter({
    namespace: b4a.from('test-namespace'),
    capability: b4a.from('test-capability')
  })

  router.method('echo', (value) => value)

  router.on('capability-error', ({ connection }) => {
    t.ok(connection, 'connection is provided in event')
  })

  const { bootstrap } = await setUpNetwork(t)
  const server = await setUpServer(t, bootstrap, router)
  await router.ready()

  t.teardown(() => router.close())

  await createClient(t, bootstrap, server.address().publicKey, {
    namespace: b4a.from('test-namespace'),
    capability: b4a.from('wrong-capability')
  })

  // Wait a bit for the capability check to happen
  await new Promise((resolve) => setTimeout(resolve, 100))
})

test('no capability configured - router accepts any connection (backward compat)', async (t) => {
  const router = new ProtomuxRpcRouter()

  router.method('echo', (value) => value)

  const { bootstrap } = await setUpNetwork(t)
  const server = await setUpServer(t, bootstrap, router)
  await router.ready()

  t.teardown(() => router.close())

  const rpc = await createClient(t, bootstrap, server.address().publicKey)

  const result = await rpc.request('echo', b4a.from('hello'))
  t.alike(result, b4a.from('hello'))
})

test('invalid namespace - client is rejected', async (t) => {
  t.plan(1)

  const router = new ProtomuxRpcRouter({
    namespace: b4a.from('server-namespace'),
    capability: b4a.from('test-capability')
  })

  router.method('echo', (value) => value)

  router.on('capability-error', ({ connection }) => {
    t.ok(connection, 'connection is provided in event')
  })

  const { bootstrap } = await setUpNetwork(t)
  const server = await setUpServer(t, bootstrap, router)
  await router.ready()

  t.teardown(() => router.close())

  await createClient(t, bootstrap, server.address().publicKey, {
    namespace: b4a.from('wrong-namespace'),
    capability: b4a.from('test-capability')
  })

  await new Promise((resolve) => setTimeout(resolve, 100))
})

test('request after invalid capability is rejected', async (t) => {
  const router = new ProtomuxRpcRouter({
    namespace: b4a.from('test-namespace'),
    capability: b4a.from('test-capability')
  })

  router.method('echo', (value) => value)

  const { bootstrap } = await setUpNetwork(t)
  const server = await setUpServer(t, bootstrap, router)
  await router.ready()

  t.teardown(() => router.close())

  const rpc = await createClient(t, bootstrap, server.address().publicKey, {
    namespace: b4a.from('test-namespace'),
    capability: b4a.from('wrong-capability')
  })

  try {
    await rpc.request('echo', b4a.from('hello'))
    t.fail('request should have failed')
  } catch (err) {
    t.ok(err, 'request failed as expected')
  }
})
