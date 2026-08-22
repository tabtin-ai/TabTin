import assert from 'node:assert/strict'
import test from 'node:test'

import { refreshStoredUserProfile } from './auth-profile-refresh'

const storedUser = {
  id: 'user-1',
  nickname: '吴瑞源',
  avatar: 'user-avatars/stale-object-key.png',
  is_verified_email: true,
  is_verified_phone: true,
  date_joined: '2026-01-01T00:00:00Z',
  login_count: 1,
}

test('refreshes a restored web session with the latest signed avatar', async () => {
  const latestUser = {
    ...storedUser,
    avatar: 'https://assets-test.example.com/user-avatars/current.png?signature=fresh',
  }
  let savedAvatar: string | undefined

  const result = await refreshStoredUserProfile({
    storedUser,
    loadProfile: async () => latestUser,
    persistUser: async (user) => {
      savedAvatar = user.avatar
    },
  })

  assert.equal(result.avatar, latestUser.avatar)
  assert.equal(savedAvatar, latestUser.avatar)
})

test('keeps the restored identity when profile refresh is temporarily unavailable', async () => {
  let persistCalls = 0

  const result = await refreshStoredUserProfile({
    storedUser,
    loadProfile: async () => {
      throw new Error('network unavailable')
    },
    persistUser: async () => {
      persistCalls += 1
    },
  })

  assert.equal(result, storedUser)
  assert.equal(persistCalls, 0)
})
