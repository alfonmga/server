const { ApolloServer } = require('apollo-server-koa')

const schema = require('./schema')
const createResolvers = require('./resolvers')

module.exports = ({ config, db, blockChain, server: app }) => {
  const server = new ApolloServer({
    introspection: true,
    typeDefs: schema,
    resolvers: createResolvers({ config, db, blockChain }),
    context: ({ ctx: { state: { user } } }) => ({ user })
  })

  server.applyMiddleware({ app })
}
