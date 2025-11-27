const getTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const ProtomuxRpcClient = require('protomux-rpc-client')
const cenc = require('compact-encoding')

exports.setUpTestClient = async (
  t,
  router,
  requestOpts = { requestEncoding: cenc.buffer, responseEncoding: cenc.buffer }
) => {
  const testnet = await getTestnet()
  t.teardown(async () => {
    await testnet.destroy()
  })
  const { bootstrap } = testnet

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

  const clientDht = new HyperDHT({ bootstrap })
  t.teardown(async () => {
    await clientDht.destroy()
  })
  const client = new ProtomuxRpcClient(clientDht)
  t.teardown(async () => {
    await client.close()
  })
  return (method, params) => {
    return client.makeRequest(server.address().publicKey, method, params, requestOpts)
  }
}
