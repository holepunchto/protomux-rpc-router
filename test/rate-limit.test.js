const test = require('brittle')
const b4a = require('b4a')
const { setUpTestClient } = require('./helper')
const ProtomuxRpcRouter = require('..')
const { rateLimitByRemotePublicKey } = require('../lib/rate-limit')

test('rateLimitByRemotePublicKey serializes requests for same client', async (t) => {
  const router = new ProtomuxRpcRouter()
  t.teardown(async () => {
    await router.destroy()
  })

  router.method('echo', rateLimitByRemotePublicKey(2, 500), (req) => req)

  const makeRequest = await setUpTestClient(t, router)

  {
    let successCount = 0
    let errorCount = 0

    // requests first batch of 4
    const requestPromises = new Array(4).fill(0).map(() => {
      return makeRequest('echo', b4a.from('foo'))
        .then(() => {
          successCount++
        })
        .catch(() => {
          errorCount++
        })
    })
    await Promise.all(requestPromises)
    t.is(successCount, 2, 'success count when requests first batch')
    t.is(errorCount, 2, 'error count when requests first batch')
  }

  {
    let successCount = 0
    let errorCount = 0

    // requests second batch of 4 instantly, do not wait for refill
    const requestPromises = new Array(4).fill(0).map(() => {
      return makeRequest('echo', b4a.from('foo'))
        .then(() => {
          successCount++
        })
        .catch(() => {
          errorCount++
        })
    })
    await Promise.all(requestPromises)
    t.is(successCount, 0, 'success count when requests instantly')
    t.is(errorCount, 4, 'error count when requests instantly')
  }

  {
    let successCount = 0
    let errorCount = 0

    // wait for 500ms (1 token refill)
    await new Promise((resolve) => setTimeout(resolve, 500))

    const requestPromises = new Array(4).fill(0).map(() => {
      return makeRequest('echo', b4a.from('foo'))
        .then(() => {
          successCount++
        })
        .catch(() => {
          errorCount++
        })
    })
    await Promise.all(requestPromises)
    t.is(successCount, 1, 'success count when requests after 500ms (1 refill)')
    t.is(errorCount, 3, 'error count when requests after 500ms (1 refill)')
  }
})

test('rateLimitByRemotePublicKey isolates different clients (different public keys)', async (t) => {
  const router = new ProtomuxRpcRouter()
  t.teardown(async () => {
    await router.destroy()
  })

  router.method('echo', rateLimitByRemotePublicKey(2, 500), (req) => req)

  const makeRequest1 = await setUpTestClient(t, router)
  const makeRequest2 = await setUpTestClient(t, router)

  let client1FinishedCount = 0
  let client1ErrorCount = 0
  let client2FinishedCount = 0
  let client2ErrorCount = 0

  const client1RequestPromises = new Array(4).fill(0).map(() => {
    return makeRequest1('echo', b4a.from('x'))
      .then(() => {
        client1FinishedCount++
      })
      .catch(() => {
        client1ErrorCount++
      })
  })
  const client2RequestPromises = new Array(4).fill(0).map(() => {
    return makeRequest2('echo', b4a.from('y'))
      .then(() => {
        client2FinishedCount++
      })
      .catch(() => {
        client2ErrorCount++
      })
  })

  await Promise.all([...client1RequestPromises, ...client2RequestPromises])
  t.is(client1FinishedCount, 2, 'client1 finished count')
  t.is(client1ErrorCount, 2, 'client1 error count')
  t.is(client2FinishedCount, 2, 'client2 finished count')
  t.is(client2ErrorCount, 2, 'client2 error count')
})

test('rateLimitByRemotePublicKey isolates different methods', async (t) => {
  const router = new ProtomuxRpcRouter()
  t.teardown(async () => {
    await router.destroy()
  })

  // same client, two different methods each with their own limiter instance
  router.method('echo', rateLimitByRemotePublicKey(2, 500), (req) => req)
  router.method('ping', rateLimitByRemotePublicKey(1, 500), (req) => req)

  const makeRequest = await setUpTestClient(t, router)

  let echoSuccess = 0
  let echoError = 0
  let pingSuccess = 0
  let pingError = 0

  const echoPromises = new Array(4).fill(0).map(() => {
    return makeRequest('echo', b4a.from('e'))
      .then(() => {
        echoSuccess++
      })
      .catch(() => {
        echoError++
      })
  })
  const pingPromises = new Array(4).fill(0).map(() => {
    return makeRequest('ping', b4a.from('p'))
      .then(() => {
        pingSuccess++
      })
      .catch(() => {
        pingError++
      })
  })

  await Promise.all([...echoPromises, ...pingPromises])

  t.is(echoSuccess, 2, 'echo success count')
  t.is(echoError, 2, 'echo error count')
  t.is(pingSuccess, 1, 'ping success count')
  t.is(pingError, 3, 'ping error count')
})
