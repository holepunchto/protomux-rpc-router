# Protomux RPC Router

Expose Protomux RPC responders on a HyperDHT server with a simple, composable middleware model.

## Overview

This package wraps `protomux-rpc` responders with an onion-style middleware stack. You can attach:

- Global middleware: applied to every RPC method.
- Per-method middleware: applied only to a specific method.

Middleware composes in a nested “onion” where control flows inward to your handler and then unwinds outward, so cross-cutting concerns (logging, rate limiting, timeouts, auth, validation, etc.) can be layered in a predictable order to improve resilience.

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

Errors thrown in inner layers propagate up the same chain; the outer layer's catch/finally will execute and can observe or handle them (e.g., a logger).

## Quick start

See [example/index.js](example/index.js) for a runnable demo.

## API

#### `const router = new ProtomuxRpcRouter([options])`

Create a new router.

`options` include:

- `namespace`: optional namespace for capability.
- `capability`: optional capability key. Enables capability verification.

#### `router.use(middleware)`

Attach global middleware. This will wrap every method in the order provided (onion-style). Returns the router for chaining (`router.use(middleware1).use(middleware2)`).

- `middleware`: object with `onrequest(ctx, next)`, and optional `onopen()`/`onclose()` hooks; applied to every method.

#### `const methodRegistration = router.method(name, options, handler)`

Register an RPC method. Returns a `MethodRegistration` which can be further configured with `.use(...)`.

- `name`: string RPC method name.
- `options.requestEncoding`: a `compact-encoding` encoder used to decode `ctx.value` before invoking the handler.
- `options.responseEncoding`: a `compact-encoding` encoder used to encode the handler result.
- `handler`: function `(request, ctx) => any|Promise<any>` that produces the response.

Note: calls protomux-rpc's [respond](https://github.com/holepunchto/protomux-rpc?tab=readme-ov-file#rpcrespondmethod-options-handler) method under the hood.

#### `router.handleConnection(connection, protomuxRpcId=connection.publicKey)`

Attach responders for all registered methods to an incoming HyperDHT `connection`.

- `connection`: the incoming HyperDHT connection .
- `protomuxRpcId` (optional): `Buffer` responder id; defaults to `connection.publicKey`.

#### `router.ready()`

Call the `onopen` of all middlewares. Call this after registering all methods and middlewares.

#### `router.close()`

Stop accepting new connections and call the `onclose` of all middlewares.

#### `methodRegistration.use(middleware)`

Append additional per-method middleware to an already registered method. Returns the registration for chaining (`methodRegistration.use(middleware1).use(middleware2)`).

- `middleware`: object with `onrequest(ctx, next)`, and optional `onopen()`/`onclose()`.

### Middleware interface

Middlewares are objects with an `onrequest` function and an optional `onopen`/`onclose` hook:

```js
const middleware = {
  // Called for every request that this middleware wraps
  onrequest: async (ctx, next) => {
    // do work before
    const res = await next()
    // do work after
    return res
  },
  // [Optional] hook invoked when the router starts up, for initialisation logic
  onopen: async () => {},
  // [Optional] hook invoked when the router closes, for cleanup logic
  onclose: async () => {}
}
```

- `onrequest(ctx, next) => Promise<any>`:
  - `ctx` includes:
    - `ctx.method`: string RPC method name.
    - `ctx.value`: the raw request object from `protomux-rpc`.
    - `ctx.connection`: the underlying connection.
  - `next()`: calls the next middleware/handler and resolves to the handler’s response (or throws).
- `onopen()`: async open hook to initialize the resource.
- `onclose()`: async close hook to cleanup the resource.

### Events

#### `router.on('capability-error', ({ connection }) => {})`

Emitted when a client fails capability verification. The connection is destroyed after this event.
