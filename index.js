const ProtomuxRpcRouter = require('./lib/router')
const rateLimit = require('./lib/rate-limit')
const concurrentLimit = require('./lib/concurrent-limit')
const encoding = require('./lib/encoding')

ProtomuxRpcRouter.encoding = encoding
ProtomuxRpcRouter.concurrentLimit = concurrentLimit
ProtomuxRpcRouter.rateLimit = rateLimit

module.exports = ProtomuxRpcRouter
