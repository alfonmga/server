const safeGet = require('lodash.get')
const { PARTICIPANT_STATUS } = require('../constants/status')
const { ADMIN, OWNER } = require('../constants/roles')
const { addressesMatch } = require('../utils/validators')

const assertUser = async user => {
  if (!safeGet(user, 'address')) {
    throw new Error('Not logged in!')
  }
}

const participantStatusToInternalStatus = status => (
  PARTICIPANT_STATUS[status] || PARTICIPANT_STATUS.UNKNOWN
)

const internalStatusToParticipantStatus = status => {
  // eslint-disable-next-line no-restricted-syntax
  for (const key in PARTICIPANT_STATUS) {
    if (PARTICIPANT_STATUS[key] === status) {
      return key
    }
  }

  return 'UNKNOWN'
}

module.exports = ({ db }) => {
  const assertPartyRole = async (partyAddress, user, role) => {
    assertUser(user)

    const party = await db.getParty(partyAddress)

    const isOwner = party && addressesMatch(party.owner, user.address)
    const isAdmin = party && party.admins.find(a => addressesMatch(a, user.address))

    switch (role) {
      case ADMIN: {
        if (isAdmin || isOwner) {
          return
        }
        break
      }
      case OWNER: {
        if (isOwner) {
          return
        }
        break
      }
      default:
        break
    }

    throw new Error(`Must have role: ${role}`)
  }

  const loadProfileOrJustReturnAddress = async (address, currentUser) => {
    const profile = await db.getUserProfile(
      address,
      currentUser && addressesMatch(currentUser.address, address)
    )

    return {
      ...profile,
      address
    }
  }

  return {
    Query: {
      allParties: async () => db.getAllParties(),
      activeParties: async () => db.getParties({ onlyActive: true }),
      party: async (_, { address }) => db.getParty(address),
      userProfile: async (_, { address }, { user }) => (
        loadProfileOrJustReturnAddress(address, user)
      ),
    },
    Mutation: {
      createLoginChallenge: async (_, { address }) => db.createLoginChallenge(address),
      loginUser: async (_, __, { user }) => {
        await assertUser(user)

        return db.loginUser(user.address)
      },
      updateUserProfile: async (_, { profile }, { user }) => {
        await assertUser(user)

        const { address } = user

        return db.updateUserProfile(address, profile)
      },
      updatePartyMeta: async (_, { address: partyAddress, meta }, { user }) => {
        await assertPartyRole(partyAddress, user, OWNER)

        return db.updatePartyMeta(partyAddress, meta)
      },
      updateParticipantStatus: async (_, {
        address: partyAddress,
        participant: { address, status }
      }, { user }) => {
        await assertPartyRole(partyAddress, user, ADMIN)

        return db.updateParticipantStatus(
          partyAddress, address, { status: participantStatusToInternalStatus(status) }
        )
      },
    },
    Party: {
      owner: async ({ owner }, _, { user }) => (
        loadProfileOrJustReturnAddress(owner, user)
      ),
      admins: async ({ admins }, _, { user }) => (
        (admins || []).map(admin => (
          loadProfileOrJustReturnAddress(admin, user)
        ))
      ),
      participants: async ({ address }) => db.getParticipants(address),
    },
    LoginChallenge: {
      str: s => s
    },
    Participant: {
      status: ({ status }) => internalStatusToParticipantStatus(status),
      user: ({ address, social }) => ({ address, social })
    },
  }
}
