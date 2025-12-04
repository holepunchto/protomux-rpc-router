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
const { encoding, rateLimit } = require('protomux-rpc-router-middlewares')

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

Create a new router.

#### `router.use(middleware)`

Attach global middleware. These will wrap every method in the order provided (onion-style). Returns the router for chaining.

- `middleware`: object with `onrequest(ctx, next)`, and optional `onopen(ctx)`/`onclose(ctx)` hooks; applied to every method.

#### `router.method(name, handler)`

Register an RPC method. Returns a `MethodRegistration` which can be further configured with `.use(...)`.

- `name`: string RPC method name.
- `handler`: function `(request, ctx) => any|Promise<any>` that produces the response.

#### `router.handleConnection(connection, [protomuxRpcId])`

Attach responders for all registered methods to an incoming HyperDHT `connection`. If `protomuxRpcId` is omitted, the peer's `connection.publicKey` is used as the responder id.

- `connection`: the incoming HyperDHT connection (duplex stream with `publicKey`).
- `protomuxRpcId` (optional): `Buffer` or string responder id; defaults to `connection.publicKey`.

#### `router.ready()`

See `ready-resource`. Call into hook `onopen` of middleware chain.

#### `router.close()`

See `ready-resource`. Call into hook `onclose` of middleware chain.

#### `MethodRegistration.use(middleware)`

Append additional per-method middleware to an already registered method. Returns the registration for chaining.

- `middleware`: object with `onrequest(ctx, next)`, and optional `onopen(ctx)`/`onclose(ctx)`; appended to this method’s chain.

### Middleware interface

Middlewares are objects with an `onrequest` function and `onopen`/`onclose` hook:

```js
const middleware = {
  // Called for every request that this middleware wraps
  onrequest: async (ctx, next) => {
    // do work before
    const res = await next()
    // do work after
    return res
  },
  // Hook invoked when the router begins opening
  onopen: async () => {},
  // Hook invoked when the router begins closing
  onclose: async () => {}
}
```

- `onrequest(ctx, next) => Promise<any>`:
  - `ctx` includes:
    - `ctx.method`: string RPC method name.
    - `ctx.value`: the raw request object from `protomux-rpc`.
    - `ctx.connection`: the underlying connection.
  - `next()`: calls the next middleware/handler and resolves to the handler’s response (or throws).
- `onopen()`: async open hook to initialize resource.
- `onclose()`: async close hook to cleanup resource.

## License

Apache-2.0
