const ProtomuxRpcRouter = require('..')
const HyperDHT = require('hyperdht')
const getTestnet = require('hyperdht/testnet')
const ProtomuxRPC = require('protomux-rpc')
const cenc = require('compact-encoding')
const logger = require('./logger')

/**
 * @returns {ProtomuxRpcRouter}
 */
function setUpRpcRouter() {
  const rpcRouter = new ProtomuxRpcRouter()

  // add a global middleware to log requests
  rpcRouter.use(logger())

  // add a method to echo the request
  rpcRouter.method('echo', async (value) => {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    return value
  })

  rpcRouter.method('error', async (message) => {
    throw new Error(message)
  })

  return rpcRouter
}

async function createClient(dht, serverPublicKey) {
  const stream = dht.connect(serverPublicKey)
  stream.on('error', () => {})

  await stream.opened

  const rpc = new ProtomuxRPC(stream, {
    id: serverPublicKey,
    valueEncoding: null
  })

  return { rpc, stream }
}

async function main() {
  console.log('Running protomux-RPC router example')
  const testnet = await getTestnet()
  const { bootstrap } = testnet

  const serverDht = new HyperDHT({ bootstrap })
  const server = serverDht.createServer()
  const rpcRouter = setUpRpcRouter()
  await rpcRouter.ready()

  server.on('connection', async (connection) => {
    await rpcRouter.handleConnection(connection)
  })

  await server.listen()
  const { publicKey: serverPubKey } = server.address()

  await clientMain(bootstrap, serverPubKey)

  await rpcRouter.close()
  await server.close()
  await serverDht.destroy()
  await testnet.destroy()
}

async function clientMain(bootstrap, serverPubKey) {
  const dht = new HyperDHT({ bootstrap })
  const { rpc, stream } = await createClient(dht, serverPubKey)

  try {
    const res = await rpc.request('echo', 'ok', {
      requestEncoding: cenc.string,
      responseEncoding: cenc.string
    })
    console.log('Server replied with', res)

    await rpc
      .request('error', 'test error', {
        requestEncoding: cenc.string,
        responseEncoding: cenc.string
      })
      .catch((error) => {
        console.log('Error in clientMain', error)
      })
  } catch (error) {
    console.error('Error in clientMain', error)
  } finally {
    rpc.destroy()
    stream.destroy()
    await dht.destroy()
  }
}

main()
