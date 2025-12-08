const ProtomuxRpcRouter = require('..')
const HyperDHT = require('hyperdht')
const getTestnet = require('hyperdht/testnet')
const cenc = require('compact-encoding')
const safetyCatch = require('safety-catch')
const ProtomuxRpcClient = require('protomux-rpc-client')
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

async function main() {
  console.log('Running protomux-RPC client example')
  const testnet = await getTestnet()
  const { bootstrap } = testnet

  const serverDht = new HyperDHT({ bootstrap })
  const server = serverDht.createServer()
  const rpcRouter = setUpRpcRouter()
  await rpcRouter.ready()

  server.on('connection', async (connection) => {
    await rpcRouter.handleConnection(connection)
  })

  throw new Error('ok')

  await server.listen()
  const { publicKey: serverPubKey } = server.address()

  await clientMain(bootstrap, serverPubKey)

  await rpcRouter.close()
  await server.close()
  await serverDht.destroy()
  await testnet.destroy()
}

class EchoClient {
  constructor(key, rpcClient) {
    this.key = key
    this.rpcClient = rpcClient
  }

  async echo(text) {
    return await this.rpcClient.makeRequest(
      this.key,
      'echo', // The RPC method name
      text, // The RPC method parameters
      { requestEncoding: cenc.string, responseEncoding: cenc.string }
    )
  }

  async error(message) {
    return await this.rpcClient.makeRequest(
      this.key,
      'error', // The RPC method name
      message, // The RPC method parameters
      { requestEncoding: cenc.string, responseEncoding: cenc.string }
    )
  }
}

async function clientMain(bootstrap, serverPubKey) {
  const dht = new HyperDHT({ bootstrap })
  const client = new ProtomuxRpcClient(dht)

  try {
    const echoClient = new EchoClient(serverPubKey, client)
    const res = await echoClient.echo('ok')
    console.log('Server replied with', res)

    await echoClient.error('test error').catch((error) => {
      console.log('Error in clientMain', error)
    })
  } catch (error) {
    console.error('Error in clientMain', error)
  } finally {
    await client.close().catch(safetyCatch)
    await dht.destroy().catch(safetyCatch)
  }
}

main()
