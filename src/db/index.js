const safeGet = require('lodash.get')
const EventEmitter = require('eventemitter3')
const uuid = require('uuid')
const { toBN, toHex, hexToNumber } = require('web3-utils')
const {
  assertRealName,
  assertUsername,
  assertEmailAddress,
  assertEthereumAddress,
  hasAcceptedLegalAgreements,
  stringsMatchIgnoreCase,
  updateParticipantListFromMaps,
  addressesMatch,
  PARTICIPANT_STATUS
} = require('@noblocknoparty/shared')

const setupFirestoreDb = require('./firestore')
const { NOTIFICATION } = require('../constants/events')
const { SESSION_VALIDITY_SECONDS } = require('../constants/session')
const { VERIFY_EMAIL } = require('../constants/notifications')
const { removeUndefinedValuesFromObject } = require('../utils/validators')

class Db extends EventEmitter {
  constructor({ nativeDb, log, blockChain }) {
    super()
    this._nativeDb = nativeDb
    this._log = log
    this._blockChain = blockChain
  }

  async notifyUser(userAddress, type, data) {
    assertEthereumAddress(userAddress)

    const id = uuid()

    const doc = await this._get(`notification/${id}`)

    await doc.set({
      user: userAddress.toLowerCase(),
      type,
      data,
      email_sent: false, // if system has processed it by sending an email to user
      seen: false
    })

    this.emit(NOTIFICATION, id)

    return id
  }

  async loginUser(userAddress) {
    assertEthereumAddress(userAddress)

    const doc = await this._getUser(userAddress, { mustExist: true })

    this._log.info(`Updating login timestamp for user ${userAddress} ...`)

    await doc.update({
      lastLogin: Date.now()
    })

    return this.getUserProfile(userAddress, true)
  }

  async updateUserProfile(userAddress, profile) {
    const { realName, username, email: newEmail, social, legal } = profile

    assertEthereumAddress(userAddress)

    if (newEmail) {
      assertEmailAddress(newEmail)
    }

    if (username) {
      assertUsername(username)
    }

    if (realName) {
      assertRealName(realName)
    }

    const doc = await this._getUser(userAddress, { mustExist: true })

    const {
      username: existingUsername,
      realName: existingRealName,
      email = {}
    } = doc.data

    // cannot change username
    if (existingUsername) {
      if (username && username !== existingUsername) {
        throw new Error(
          `Cannot change username once set for user ${userAddress}`
        )
      }
    } else {
      // eslint-disable-next-line no-lonely-if
      if (!username) {
        // need username
        throw new Error(`Username must be provided for user ${userAddress}`)
      } else if (await this._isUsernameTaken(username)) {
        throw new Error(
          `Username ${username} already taken, cannot use for user ${userAddress}`
        )
      }
    }

    // need real name
    const finalRealName = realName || existingRealName
    if (!finalRealName) {
      throw new Error(`Real name must be provided for user ${userAddress}`)
    }

    if (newEmail && !stringsMatchIgnoreCase(email.verified, newEmail)) {
      email.pending = newEmail

      this.notifyUser(userAddress, VERIFY_EMAIL, { email: newEmail })
    }

    // legal agreements are a must have
    if (
      !hasAcceptedLegalAgreements(doc.data.legal) &&
      !hasAcceptedLegalAgreements(legal)
    ) {
      throw new Error('Legal agreements must be accepted')
    }

    this._log.info(`Updating profile for user ${userAddress} ...`)

    await doc.update({
      email,
      legal: legal || doc.data.legal,
      realName: finalRealName,
      username: (username || existingUsername).toLowerCase(),
      social: (social || []).reduce((m, { type, value }) => {
        m[type] = value
        return m
      }, {})
    })

    return this.getUserProfile(userAddress, true)
  }

  async getUserProfile(userAddress, canViewPrivateFields = false) {
    const doc = await this._getUser(userAddress)

    if (!doc.exists) {
      return {}
    }

    const {
      address,
      social,
      legal,
      created,
      lastLogin,
      email,
      realName,
      username
    } = doc.data

    return {
      address,
      username,
      created,
      lastLogin,
      social: Object.keys(social || {}).reduce((m, type) => {
        m.push({
          type,
          value: social[type]
        })

        return m
      }, []),
      ...(canViewPrivateFields ? { email, legal, realName } : {})
    }
  }

  async getLoginChallenge(userAddress) {
    const doc = await this._getUser(userAddress, { mustExist: true })

    const { challenge, created = 0 } = doc.data.login || {}

    // check login session validity
    if (created < Date.now() - SESSION_VALIDITY_SECONDS * 1000) {
      throw new Error(`User login session has expired: ${userAddress}`)
    }

    return challenge
  }

  async createLoginChallenge(userAddress) {
    assertEthereumAddress(userAddress)

    const newProps = {
      address: userAddress.toLowerCase(),
      login: {
        challenge: `Hello! please sign this friendly message using your private key to start using KickBack (timestamp: ${Date.now()})`,
        created: Date.now()
      }
    }

    const doc = await this._getUser(userAddress)

    if (!doc.exists) {
      await doc.set(newProps)
    } else {
      await doc.update(newProps)
    }

    return newProps.login.challenge
  }

  async getParty(address) {
    const doc = await this._getParty(address)

    return doc.exists ? doc.data : null
  }

  async createPendingParty(owner, data) {
    const id = uuid()

    if (!data.name) {
      throw new Error('Pending party name must be set!')
    }

    const doc = await this._getPendingParty(id)

    const meta = this._extractPartyMeta(data)

    this._log.info(`Creating pending party ${id} for owner: ${owner} ...`)

    await doc.set({
      ...meta,
      owner: owner.toLowerCase()
    })

    return id
  }

  async updatePartyMeta(address, data) {
    const doc = await this._getParty(address)

    if (!doc.exists) {
      this._log.warn(`Party not found: ${address}`)

      return
    }

    const meta = this._extractPartyMeta(data)

    this._log.info(`Party ${address} meta update: ${meta}`)

    await doc.update(meta)
  }

  async addPartyFromContract(partyInstance) {
    const { address } = partyInstance

    const doc = await this._getParty(address)

    if (doc.exists) {
      this._log.warn(`Party ${address} already exists in db`)

      return
    }

    this._log.info(`Inserting new party from contract: ${address} ...`)

    // fetch data from contract
    const [
      owner,
      admins,
      name,
      deposit,
      limitOfParticipants,
      coolingPeriod
    ] = await Promise.all([
      partyInstance.owner(),
      partyInstance.getAdmins(),
      partyInstance.name(),
      partyInstance.deposit(),
      partyInstance.limitOfParticipants(),
      partyInstance.coolingPeriod()
    ])

    // fetch pending party
    // name in contract should match id of pending party doc! - this is how we
    // ensure only parties we approve of can show up on our website, despite
    // people calling our deployer contract directly!
    const pendingParty = await this._getPendingParty(name)

    if (!pendingParty.exists) {
      this._log.warn(
        `Party ${address} does not have a matching pending party entry.`
      )

      return
    }

    const meta = this._extractPartyMeta(pendingParty.data)

    await doc.set({
      ...meta,
      address: address.toLowerCase(),
      network: this._blockChain.networkId,
      deposit: toHex(deposit),
      participantLimit: hexToNumber(toHex(limitOfParticipants)),
      coolingPeriod: toHex(coolingPeriod),
      ended: false,
      cancelled: false,
      owner: owner.toLowerCase(),
      admins: admins.map(a => a.toLowerCase()),
      created: Date.now()
    })

    // delete pending party
    await pendingParty.delete()
  }

  async updatePartyFromContract(partyInstance) {
    const { address } = partyInstance

    const doc = await this._getParty(address)

    if (!doc.exists) {
      this._log.warn(`Party ${address} does not exist in db`)

      return
    }

    this._log.info(`Update party from contract: ${address} ...`)

    /*
    NOTE: we deliberately do not load cancelled and ended vars as setting these
    impacts other logic (such as updating participant status). This method here
    is simply for updating meta details of the party
     */

    // fetch data from contract
    const [
      owner,
      admins,
      deposit,
      limitOfParticipants,
      coolingPeriod
    ] = await Promise.all([
      partyInstance.owner(),
      partyInstance.getAdmins(),
      partyInstance.deposit(),
      partyInstance.limitOfParticipants(),
      partyInstance.coolingPeriod()
    ])

    await doc.update({
      deposit: toHex(deposit),
      participantLimit: hexToNumber(toHex(limitOfParticipants)),
      coolingPeriod: toHex(coolingPeriod),
      owner: owner.toLowerCase(),
      admins: admins.map(a => a.toLowerCase())
    })
  }

  async getParties({
    stalestFirst = false,
    limit = undefined,
    onlyActive = false
  } = {}) {
    let query = this._nativeDb
      .collection('party')
      .where('network', '==', this._blockChain.networkId)

    if (onlyActive) {
      query = query.where('ended', '==', false)
    }

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

  async getParticipants(partyAddress) {
    const list = await this._getParticipantList(partyAddress)

    return list.exists ? list.data.participants : []
  }

  async finalize(partyAddress, maps) {
    partyAddress = partyAddress.toLowerCase()

    const party = await this._getParty(partyAddress)

    if (!party.exists) {
      this._log.warn(`Party not found: ${partyAddress}`)

      return
    } else if (party.data.ended || party.data.cancelled) {
      this._log.warn(
        `Party ${partyAddress} already ended/cancelled, so cannot finalize`
      )

      return
    }

    const participantList = await this._getParticipantList(partyAddress)

    if (!participantList.exists) {
      this._log.warn(`No participant list found for party ${partyAddress}`)

      return
    }

    if (participantList.data.finalized) {
      this._log.warn(`Party ${partyAddress} already finalized`)

      return
    }

    const { participants = [] } = participantList.data

    this._log.warn(`Finalizing attendance for party ${partyAddress} ...`)

    updateParticipantListFromMaps(participants, maps)

    await Promise.all([
      participantList.set({
        address: partyAddress,
        participants: [...participants],
        finalized: true
      }),
      party.update({
        ended: true
      })
    ])
  }

  async updateParticipantListFromContract(partyInstance) {
    const partyAddress = partyInstance.address.toLowerCase()

    const party = await this._getParty(partyAddress)

    if (!party.exists) {
      this._log.warn(`Party not found: ${partyAddress}`)

      return {}
    } else if (party.data.ended) {
      this._log.warn(
        `Party ${partyAddress} already ended, so cannot update participant list`
      )

      return {}
    }

    const participantList = await this._getParticipantList(partyAddress)

    if (safeGet(participantList, 'data.finalized')) {
      this._log.warn(
        `Party ${partyAddress} already finalized, so cannot update participant list`
      )

      return {}
    }

    this._log.info(
      `Update participant list for party ${partyAddress} from contract ...`
    )

    const { participants = [] } = safeGet(participantList, 'data', {})

    const registered = await partyInstance.registered()

    for (let i = 1; registered >= i; i += 1) {
      /* eslint-disable no-await-in-loop */
      const pAddress = await partyInstance.participantsIndex(i)
      const entryIndex = participants.findIndex(({ address }) =>
        addressesMatch(address, pAddress)
      )

      // if not found
      if (0 > entryIndex) {
        const p = await partyInstance.participants(pAddress)

        const entry = await this._createParticipantEntry(pAddress, null, {
          status: PARTICIPANT_STATUS.REGISTERED,
          index: toBN(p.index).toString(10)
        })

        participants.push(entry)
      }
      // if found
      else {
        const entry = await this._createParticipantEntry(
          pAddress,
          participants[entryIndex]
        )

        participants.splice(entryIndex, 1, entry)
      }
      /* eslint-enable no-await-in-loop */
    }

    await participantList.update({
      participants: [...participants]
    })

    return {}
  }

  async updateParticipantStatus(
    partyAddress,
    participantAddress,
    { status, index } = {}
  ) {
    if (!PARTICIPANT_STATUS[status]) {
      throw new Error(`Invalid status: ${status}`)
    }

    partyAddress = partyAddress.toLowerCase()

    const party = await this._getParty(partyAddress)

    if (!party.exists) {
      this._log.warn(`Party not found: ${partyAddress}`)

      return {}
    } else if (
      party.data.ended &&
      PARTICIPANT_STATUS.WITHDRAWN_PAYOUT !== status
    ) {
      this._log.warn(
        `Party ${partyAddress} already ended, so can only update status of participant ${participantAddress} to ${
          PARTICIPANT_STATUS.WITHDRAWN_PAYOUT
        }`
      )

      return {}
    }

    const participantList = await this._getParticipantList(partyAddress)

    if (
      safeGet(participantList, 'data.finalized') &&
      PARTICIPANT_STATUS.WITHDRAWN_PAYOUT !== status
    ) {
      this._log.warn(
        `Party ${partyAddress} already finalized, so can only update status of participant ${participantAddress} to ${
          PARTICIPANT_STATUS.WITHDRAWN_PAYOUT
        }`
      )

      return {}
    }

    participantAddress = participantAddress.toLowerCase()

    const list = participantList.exists ? participantList.data.participants : []
    const listIndex = list.findIndex(({ address: a }) =>
      addressesMatch(a, participantAddress)
    )
    const existingEntry = 0 <= listIndex ? list[listIndex] : null

    const newEntry = await this._createParticipantEntry(
      participantAddress,
      existingEntry,
      {
        status,
        ...(0 <= parseInt(index, 10) ? { index: `${index}` } : null)
      }
    )

    this._log.info(
      `Update status of participant ${participantAddress} at party ${partyAddress} to ${JSON.stringify(
        newEntry
      )}`
    )

    // no participant list exists yet, so create one
    if (!list.length) {
      await participantList.set({
        address: partyAddress,
        participants: [newEntry]
      })
    }
    // if participant found
    else if (existingEntry) {
      list.splice(listIndex, 1, newEntry)

      await participantList.update({
        participants: [...list]
      })
    }
    // if participant not found
    else {
      await participantList.update({
        participants: [...list, newEntry]
      })
    }

    return newEntry
  }

  async setNewPartyOwner(address, newOwnerAddress) {
    address = address.toLowerCase()

    const doc = await this._getParty(address)

    assertEthereumAddress(newOwnerAddress)

    newOwnerAddress = newOwnerAddress.toLowerCase()

    if (doc.exists) {
      this._log.info(`Party ${address} has new owner: ${newOwnerAddress}`)

      await doc.update({
        owner: newOwnerAddress
      })
    }
  }

  async addPartyAdmin(address, adminAddress) {
    address = address.toLowerCase()

    const doc = await this._getParty(address)

    assertEthereumAddress(adminAddress)

    adminAddress = adminAddress.toLowerCase()

    if (doc.exists) {
      const { admins = [] } = doc.data

      if (!admins.includes(adminAddress)) {
        this._log.info(`Party ${address} adds admin: ${adminAddress}`)

        await doc.update({
          admins: [...admins, adminAddress]
        })
      }
    }
  }

  async removePartyAdmin(address, adminAddress) {
    address = address.toLowerCase()

    const doc = await this._getParty(address)

    assertEthereumAddress(adminAddress)

    adminAddress = adminAddress.toLowerCase()

    if (doc.exists) {
      const { admins = [] } = doc.data

      const pos = admins.indexOf(adminAddress)

      if (0 <= pos) {
        this._log.info(`Party ${address} removes admin: ${adminAddress}`)

        admins.splice(pos, 1)

        await doc.update({
          admins: [...admins]
        })
      }
    }
  }

  async markPartyCancelled(address) {
    address = address.toLowerCase()

    const doc = await this._getParty(address)

    if (doc.exists) {
      this._log.info(`Party ${address} cancelled`)

      await doc.update({
        cancelled: true,
        ended: true
      })
    }
  }

  async getKey(key) {
    const doc = await this._get(`setting/${this._id(key)}`)

    return doc.exists ? doc.data.value : undefined
  }

  async _createParticipantEntry(
    address,
    existingEntry,
    { status, index } = {}
  ) {
    const userProfile = await this.getUserProfile(address, true)

    const newEntry = {
      address: address.toLowerCase(),
      status,
      index,
      ...(userProfile.social ? { social: userProfile.social } : null),
      ...(userProfile.username ? { username: userProfile.username } : null),
      ...(userProfile.realName ? { realName: userProfile.realName } : null)
    }

    // don't overwrite existing entry data unless we have new values
    ;['index', 'status', 'social', 'realName', 'username'].forEach(key => {
      if (undefined === newEntry[key]) {
        if (undefined !== safeGet(existingEntry, key)) {
          newEntry[key] = existingEntry[key]
        } else if ('index' === key || 'status' === key) {
          throw new Error(
            `Undefined value for ${key} for participant ${address}`
          )
        }
      }
    })

    return newEntry
  }

  async _isUsernameTaken(username) {
    const query = this._nativeDb
      .collection('user')
      .where('username', '==', username.toLowerCase())
      .limit(1)

    return !!(await query.get()).docs.length
  }

  async setKey(key, value) {
    const doc = await this._get(`setting/${this._id(key)}`)

    await doc.set({ value })
  }

  async _getUser(address, { mustExist = false } = {}) {
    const ref = await this._get(`user/${address.toLowerCase()}`)

    if (mustExist && !ref.exists) {
      throw new Error(`User not found: ${address}`)
    }

    return ref
  }

  async _getParty(address) {
    return this._get(`party/${this._id(address.toLowerCase())}`)
  }

  async _getPendingParty(id) {
    return this._get(`pendingParty/${this._id(id)}`)
  }

  async _getParticipantList(address) {
    return this._get(`participantList/${this._id(address.toLowerCase())}`)
  }

  async _get(refPath) {
    const ref = this._nativeDb.doc(refPath)
    const doc = await ref.get()

    if (doc.exists) {
      ref.exists = true
      ref.data = doc.data()
    }

    // wrap update()
    ref.update = (orig => props => {
      removeUndefinedValuesFromObject(props)
      const ts = Date.now()
      return orig.call(ref, {
        ...props,
        lastUpdated: ts
      })
    })(ref.update)

    // wrap set()
    ref.set = (orig => props => {
      removeUndefinedValuesFromObject(props)
      const ts = Date.now()
      return orig.call(ref, {
        ...props,
        lastUpdated: ts
      })
    })(ref.set)

    return ref
  }

  _id(str) {
    return `${str}-${this._blockChain.networkId}`
  }

  _extractPartyMeta(doc) {
    return ['name', 'description', 'date', 'location', 'image'].reduce(
      (m, k) => {
        if (undefined !== doc[k]) {
          m[k] = doc[k]
        }
        return m
      },
      {}
    )
  }
}

module.exports = async ({ config, log, blockChain }) => {
  const nativeDb = await setupFirestoreDb({ config, log })

  return new Db({ nativeDb, log, blockChain })
}
