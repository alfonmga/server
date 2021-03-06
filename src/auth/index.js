const jwt = require('koa-jwt')
const { addressesMatch } = require('@noblocknoparty/shared')

module.exports = ({ log, db, server, blockChain }) => {
  server.use(jwt({
    // our security comes from signing with user's private key, not arbitrary secrets here!
    secret: 'kickback',
    // don't reject a request just because auth failed!
    passthrough: true,
    // options for HS256
    algorithm: 'HS256'
  }))

  server.use(async (ctx, next) => {
    // if we successfully decoded a JWT
    if (ctx.state.user) {
      try {
        const { address, sig } = ctx.state.user

        const challenge = await db.getLoginChallenge(address)

        const signerKey = blockChain.web3.eth.accounts.recover(challenge, sig)

        if (!addressesMatch(signerKey, address)) {
          throw new Error(`Signer key mismatch: ${address}`)
        }

        // lowercase the address
        ctx.state.user.address = ctx.state.user.address.toLowerCase()
      } catch (err) {
        log.debug(err)
        // user isn't authenticated :/
        ctx.state.user = ''
      }
    }

    await next()
  })
}
