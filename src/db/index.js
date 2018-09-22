const EventEmitter = require('eventemitter3')
const { generate: randStr } = require('randomstring')
const { toHex, hexToNumber } = require('web3-utils')

const setupFirestoreDb = require('./firestore')
const { STATUS: ATTENDEE_STATUS } = require('../constants/attendees')
const { NOTIFICATION } = require('../constants/events')
const { SESSION_VALIDITY_SECONDS } = require('../constants/session')
const { VERIFY_EMAIL } = require('../constants/notifications')
const { assertEthereumAddress, assertEmail } = require('../utils/validators')

class Db extends EventEmitter {
  constructor ({ nativeDb, log, blockChain }) {
    super()
    this._nativeDb = nativeDb
    this._log = log
    this._blockChain = blockChain
  }

  async notifyUser (userAddress, type, data) {
    assertEthereumAddress(userAddress)

    const id = randStr(10)

    await this._nativeDb.doc(`notification/${id}`).set({
      user: userAddress,
      type,
      data,
      created: Date.now(),
      lastUpdated: Date.now(),
      seen: false, // if user has seen it
      processed: false, // if system has processed it (e.g. by sending an email to user)
    })

    this.emit(NOTIFICATION, id)
  }

  async updateUserProfile (userAddress, profile) {
    const { email: newEmail, social } = profile

    assertEthereumAddress(userAddress)

    if (newEmail) {
      assertEmail(newEmail)
    }

    const doc = await this._loadUserWhoMustExist(userAddress)

    const { email = {} } = doc.data()

    if (newEmail && email.verified !== newEmail) {
      email.pending = newEmail

      this.notifyUser(userAddress, VERIFY_EMAIL, { email: newEmail })
    }

    await doc.ref.update({
      lastUpdated: Date.now(),
      email,
      social: (social || []).reduce((m, { type, value }) => {
        m[type] = value
        return m
      }, {})
    })

    return this.getUserProfile(userAddress)
  }

  async getUserProfile (userAddress, isOwner = false) {
    const doc = await this._nativeDb.doc(`user/${userAddress}`).get()

    if (!doc.exists) {
      return {}
    }

    const { address, social, created, email } = doc.data()

    return {
      address,
      created,
      social: Object.keys(social || {}).reduce((m, type) => {
        m.push({
          type,
          value: social[type]
        })

        return m
      }, []),
      /* only want owner to see their own email address */
      ...(isOwner ? { email } : {})
    }
  }

  async getLoginChallenge (userAddress) {
    const doc = await this._loadUserWhoMustExist(userAddress)

    const { challenge, created = 0 } = (doc.data().login || {})

    // check login session validity
    if (created < (Date.now() - SESSION_VALIDITY_SECONDS * 1000)) {
      throw new Error(`User login session has expired: ${userAddress}`)
    }

    return challenge
  }

  async createLoginChallenge (userAddress) {
    assertEthereumAddress(userAddress)

    const doc = this._nativeDb.doc(`user/${userAddress}`)

    const newProps = {
      address: userAddress,
      login: {
        challenge: `Hello! please sign this friendly message using your private key to start using KickBack (timestamp: ${Date.now()})`,
        created: Date.now()
      },
      lastUpdated: Date.now()
    }

    if (!(await doc.get()).exists) {
      newProps.created = newProps.lastUpdated

      await doc.set(newProps)
    } else {
      await doc.update(newProps)
    }

    return newProps.login.challenge
  }

  async addPartyFromContract (partyInstance) {
    const { address } = partyInstance

    const doc = await this._getParty(address)

    if (doc.exists) {
      this._log.error(`Party already exists in db: ${address}`)

      return
    }


    this._log.info(`Adding new party at: ${address}`)

    // fetch data from contract
    const [ name, deposit, limitOfParticipants, coolingPeriod, ended ] = await Promise.all([
      partyInstance.name(),
      partyInstance.deposit(),
      partyInstance.limitOfParticipants(),
      partyInstance.coolingPeriod(),
      partyInstance.ended()
    ])

    await doc.set({
      address,
      network: this._blockChain.networkId,
      name,
      deposit: toHex(deposit),
      attendeeLimit: hexToNumber(toHex(limitOfParticipants)),
      attendees: 0,
      coolingPeriod: toHex(coolingPeriod),
      ended,
      created: Date.now(),
      lastUpdated: Date.now()
    })

    this._log.info(`New party added to db: ${doc.id}`)
  }

  async getActiveParties ({ stalestFirst = false, limit = undefined } = {}) {
    let query = this._nativeDb.collection('party')
      .where('ended', '==', false)
      .where('network', '==', this._blockChain.networkId)

    if (stalestFirst) {
      query = query.orderBy('lastUpdated', 'asc')
    } else {
      query = query.orderBy('created', 'desc')
    }

    if (limit) {
      query = query.limit(limit)
    }

    return (await query.get()).docs.map(doc => doc.data())
  }

  async addAttendee (address, attendee) {
    const party = await this._getParty(address)

    if (!party.exists) {
      this._log.error(`Party not found: ${address}`)

      return
    }

    this._log.info(`Adding attendee ${attendee} to party ${address}`)

    const newEntry = {
      address: attendee,
      status: ATTENDEE_STATUS.REGISTERED,
    }

    const attendeeList = await this._getAttendeeList(address)

    if (!attendeeList.exists) {
      await Promise.all([
        attendeeList.set({
          address,
          attendees: [ newEntry ],
          created: Date.now(),
          lastUpdated: Date.now(),
        }),
        party.update({
          attendees: 1,
          lastUpdated: Date.now()
        })
      ])
    } else {
      const list = (await attendeeList.get()).get('attendees')

      if (!list.find(({ address: a }) => a === attendee)) {
        await Promise.all([
          attendeeList.update({
            address,
            attendees: list.concat(newEntry),
            lastUpdated: Date.now(),
          }),
          party.update({
            attendees: list.length + 1,
            lastUpdated: Date.now()
          })
        ])
      }
    }
  }

  async markPartyEnded (address) {
    const doc = await this._getParty(address)

    if (doc.exists) {
      await doc.update({
        ended: true,
        lastUpdated: Date.now()
      })
    }
  }

  async markPartyCancelled (address) {
    const doc = await this._getParty(address)

    if (doc.exists) {
      await doc.update({
        ended: true,
        lastUpdated: Date.now()
      })
    }
  }

  async getKey (key) {
    return (await this._nativeDb.doc(`settings/${this._id(key)}`).get()).get('value')
  }

  async setKey (key, value) {
    return this._nativeDb.doc(`settings/${this._id(key)}`).set({ value })
  }

  async _getParty (address) {
    const ref = this._nativeDb.doc(`party/${this._id(address)}`)

    ref.exists = (await ref.get()).exists

    return ref
  }

  async _getAttendeeList (address) {
    const ref = this._nativeDb.doc(`attendeeList/${this._id(address)}`)

    ref.exists = (await ref.get()).exists

    return ref
  }

  _id (str) {
    return `${str}-${this._blockChain.networkId}`
  }

  async _loadUserWhoMustExist (userAddress) {
    assertEthereumAddress(userAddress)

    const doc = await this._nativeDb.doc(`user/${userAddress}`).get()

    if (!doc.exists) {
      throw new Error(`User not found: ${userAddress}`)
    }

    return doc
  }
}

module.exports = async ({ config, log, blockChain }) => {
  const nativeDb = await setupFirestoreDb({ config, log })

  return new Db({ nativeDb, log, blockChain })
}
