# KickBack backend server

* Ropsten deployment: https://dev.api.kickback.events [![Build Status](https://travis-ci.org/noblocknoparty/server.svg?branch=dev)](https://travis-ci.org/noblocknoparty/server)
* Mainnet deployment: https://live.api.kickback.events [![Build Status](https://travis-ci.org/noblocknoparty/server.svg?branch=master)](https://travis-ci.org/noblocknoparty/server)

This is a GraphAL API server.

Google Firestore is used as the backend storage, with separate storage databases for local, dev (Ropsten) and master (Mainnet).

More info on server is available [in the docs](https://github.com/noblocknoparty/docs/blob/master/BackendServer.md).

## Branches

* `dev` - Default branch, where latest development takes place
* `master` - Production branch

## Running

Pre-requisites:
  * Node 8.11.4
  * Yarn

**Create .env file**

Create a `.env` file in your project root. This gets auto-loaded at startup by
the server and provides a convenient way of setting environment variables.
In our server deployments we auto-create this file.

The server has 3 running modes (can be set using the `APP_MODE` var in `.env` file):

  * `local` (default) - _server connects to local test network_
  * `development` - _server connects to Ropsten network on Infura_
  * `production` - _server connects to Mainnet on Infura_

**Setup Firestore database credentials**

There are 3 databases in Google cloud:

* `blockparty-local` - used for when running the dev server locally and testing
* `blockparty-dev` - used for the server running on the dev site against Ropsten
* `blockparty-live` - used for the server running on the production site against Maininet

The corresponding Google Cloud JSON config files in `.googlecloud/` will be
decrypted using the env vars `CONFIG_ENCRYPTION_KEY` and `CONFIG_ENCRYPTION_IV`. Ensure
they are set in `.env` (you can get them from our password vault).

**Deploy contracts to local test network and create .env file**

Clone our [contracts repo](https://github.com/noblocknoparty/contracts) and follow the instructions to deploy the
contracts to a local test network. The network RPC endpoint should match what's
in `src/config/local.js` in this repo.

Find the deployed address of the `Deployer` contract and enter it the `.env` file:

```
DEPLOYER_CONTRACT_ADDRESS=<...address...>
```

**Run server**

Now you can run the server:

```shell
$ yarn start
```

The GraphQL endpoint is at the `/graphql` URL path. If you load this path in a
browser you will get the [GraphQL playground](https://github.com/prisma/graphql-playground).

**Test contract deployment and interaction**

If you wish to deploy a new Party run:

```shell
scripts/deployPartyLocally.js
```

Alternatively, you can deploy and interact with parties using our [frontend](https://github.com/noblocknoparty/app).

## Deployments

On CI we deploy to Zeit using [now](https://zeit.co/docs/getting-started/five-minute-guide-to-now).

To use the same commands locally you will need to set the `NOW_TOKEN` environment
variable to your access token obtained from https://zeit.co/account/tokens.

We've also got certain [secret environment variables](https://zeit.co/docs/getting-started/secrets) setup for our deployments, namely `CONFIG_ENCRYPTION_KEY` and `CONFIG_ENCRYPTION_IV`.

To deploy and alias the dev server URL in one go:

**Dev server deployment**

```shell
$ yarn deploy:dev
```

To deploy and alias our dev domain all in one go:

```shell
$ yarn release:dev
```

### Production

```shell
$ yarn deploy:production
```
To deploy and alias the production server URL in one go:

```shell
$ yarn release:prod
```

## Testing

Prior to running tests ensure you have a test network running:

```shell
npx ganache-cli --accounts 500
```

Now run:

```shell
yarn test
```
