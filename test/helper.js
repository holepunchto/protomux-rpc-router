const getTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const ProtomuxRPC = require('protomux-rpc')
const HyperswarmCapability = require('hyperswarm-capability')
const Handshake = require('../lib/handshake')
const cenc = require('compact-encoding')
const b4a = require('b4a')
const sodium = require('sodium-universal')

exports.setUpNetwork = async (t) => {
  const testnet = await getTestnet()
  t.teardown(async () => {
    await testnet.destroy()
  })
  return { bootstrap: testnet.bootstrap }
}

exports.setUpServer = async (t, bootstrap, router) => {
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
  return server
}

exports.createClient = async (t, bootstrap, serverPublicKey, options = {}) => {
  const { namespace, capability, keyPair } = options

  const clientDht = new HyperDHT({ bootstrap, keyPair })
  t.teardown(() => clientDht.destroy())

  const stream = clientDht.connect(serverPublicKey)
  stream.on('error', () => {})

  await stream.opened

  const rpcOptions = {
    id: serverPublicKey,
    valueEncoding: null
  }

  if (capability) {
    const cap = new HyperswarmCapability(namespace)
    rpcOptions.handshakeEncoding = Handshake
    rpcOptions.handshake = { capability: cap.generate(stream, capability) }
  }

  const rpc = new ProtomuxRPC(stream, rpcOptions)

  t.teardown(() => {
    rpc.destroy()
    stream.destroy()
  })

  return rpc
}

exports.simpleSetup = async (t, router) => {
  const { bootstrap } = await exports.setUpNetwork(t)
  const server = await exports.setUpServer(t, bootstrap, router)
  await router.ready()

  const rpc = await exports.createClient(t, bootstrap, server.address().publicKey)

  return (
    method,
    params,
    requestOpts = { requestEncoding: cenc.raw, responseEncoding: cenc.raw }
  ) => {
    return rpc.request(method, params, requestOpts)
  }
}

// borrow from hyperdht/lib/crypto.js
exports.createKeyPair = (seed) => {
  const publicKey = b4a.alloc(32)
  const secretKey = b4a.alloc(64)
  if (seed) sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
  else sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}
