# Protomux RPC Router

Expose Protomux RPC responders on a HyperDHT server with a simple, composable middleware model.

## Overview

This package wraps `protomux-rpc` responders with an onion-style middleware stack. You can attach:

- Global middleware: applied to every RPC method.
- Per-method middleware: applied only to a specific method.

Middleware compose in a nested “onion” where control flows inward to your handler and then unwinds outward, so cross-cutting concerns (logging, rate limiting, timeouts, auth, validation, etc.) can be layered in a predictable order to improve resilience.

High level:

```
request
  -> [global middleware 1]
    -> [global middleware 2]
      -> [method middleware 1]
        -> [method middleware 2]
          -> handler
        <- [method middleware 2]
      <- [method middleware 1]
    <- [global middleware 2]
  <- [global middleware 1]
response
```

Errors thrown by inner layers bubble back out through the same chain, allowing outer layers (e.g. logger) to observe and act.

## Quick start

See `example/index.js` for a runnable demo. The short version:

```js
const ProtomuxRpcRouter = require('protomux-rpc-router')
const { encoding, rateLimit } = ProtomuxRpcRouter

async function main() {
  const testnet = await getTestnet()
  const { bootstrap } = testnet

  const dht = new HyperDHT({ bootstrap })
  const dhtServer = dht.createServer()

  const router = new ProtomuxRpcRouter()

  router
    // Global logger & error-handling
    .use(logger())
    // Global rate limit
    .use(rateLimit.byIp(10, 100))

  // Define a method + per-method middleware
  // add a method to echo the request
  router.method(
    'echo',
    // rate limit per method
    rateLimit.byIp(5, 100),
    // place encoding after rate limit for efficiency
    encoding({ request: cenc.string, response: cenc.string }),
    async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return req
    }
  )

  dhtServer.on('connection', (connection) => router.handleConnection(connection))
  await dhtServer.listen()
  console.log('RPC server listening', dhtServer.address())
}
```

## API

#### `const router = new ProtomuxRpcRouter()`

Create a new router

#### `router.use(...middlewares)`

Attach one or more global middlewares. These will wrap every method in the order provided (onion-style). Returns the router for chaining.

#### `router.method(name, ...middlewares, handler)`

Register an RPC method. You can pass zero or more per-method middlewares followed by the handler. Returns a `MethodRegistration` which can be further configured with `.use(...)`.

#### `router.handleConnection(connection, [publicKey])`

Attach responders for all registered methods to an incoming HyperDHT `connection`. If `publicKey` is omitted, the peer's `connection.publicKey` is used as the responder id.

#### `router.destroy()`

Destroy the router: runs `destroy()` on all registered method middlewares (in reverse order) and then on global middlewares (also in reverse order).

#### `MethodRegistration.use(...middlewares)`

Append additional per-method middlewares to an already registered method. Returns the registration for chaining.

#### `MethodRegistration.destroy()`

Run cleanup for this method’s middleware chain only. This should never be called by user, but by `router.destroy()` only.

### Middleware interface

Middlewares are plain objects with an `onrequest` function and an optional `destroy` hook:

```js
const middleware = {
  // Called for every request that this middleware wraps
  onrequest: async (ctx, next) => {
    // do work before
    const res = await next()
    // do work after
    return res
  },
  // Optional cleanup when router/registration is destroyed
  destroy: async () => {}
}
```

- `onrequest(ctx, next) => Promise<any>`:
  - `ctx` includes:
    - `ctx.method`: string RPC method name.
    - `ctx.value`: the raw request object from `protomux-rpc`.
    - `ctx.connection`: the underlying connection.
  - `next()`: calls the next middleware/handler and resolves to the handler’s response (or throws).
- `destroy()`: optional async cleanup called when the router is destroyed. Destruction order is reverse of registration.

## Built-in middleware

- `encoding`

Encoding middleware to transform request/response payloads using `compact-encoding`-style codecs:

```js
const { encoding } = ProtomuxRpcRouter

router.method(
  'echo',
  encoding({
    request: cenc.string,
    response: cenc.string
  }),
  async (req) => req
)
```

- `rateLimit`

Token-bucket rate limiting per peer. Two variants:

- `rateLimit.byIp(capacity, intervalMs)`: key by remote IP.
- `rateLimit.byPublicKey(capacity, intervalMs)`: key by remote public key.

- `capacity`: maximum burst size (bucket size).
- `intervalMs`: refill interval for 1 token. Tokens refill over time up to `capacity`.

If the bucket is empty, the middleware throws with error code `RATE_LIMIT_EXCEEDED`.
Place this before `encoding` for efficiency.

```js
const { rateLimit } = ProtomuxRpcRouter

router.method(
  'echo',
  rateLimit.byIp(50, 100), // burst 50, ~10 tokens/sec (100ms refill), by IP
  async (req) => req
)
```

- `concurrentLimit`

Limit the number of in-flight requests per peer. Two variants:

- `concurrentLimit.byIp(capacity)`: key by remote IP.
- `concurrentLimit.byPublicKey(capacity)`: key by remote public key.

If the number of active requests for the key reaches `capacity`, the middleware throws with error code `CONCURRENT_LIMIT_EXCEEDED`. The slot is released when the handler completes.

```js
const { concurrentLimit } = ProtomuxRpcRouter

router.method(
  'echo',
  concurrentLimit.byIp(10), // allow maximum 10 concurrent requests per IP
  async (req) => req
)
```

## License

Apache-2.0
