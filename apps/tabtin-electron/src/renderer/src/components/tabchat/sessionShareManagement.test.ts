import { describe, expect, it } from 'vitest'
import {
  isOutgoingSessionShare,
  resolveSessionShareManagementState,
  resolveSharedSessionRowState,
} from './sessionShareManagement'

describe('session share management state', () => {
  it('renders pending as awaiting confirmation with cancel only', () => {
    expect(resolveSessionShareManagementState('pending')).toEqual({
      showCurrentPeer: false,
      showTier: false,
      canRevoke: true,
      canResume: false,
      statusLabel: 'pending',
    })
  })

  it('keeps a visible management trigger without collaborator avatars', () => {
    expect(resolveSessionShareManagementState('revoked').showTier).toBe(false)
    expect(resolveSessionShareManagementState('active').showTier).toBe(true)
  })

  it('prevents an owner from opening a pending shared session', () => {
    expect(resolveSharedSessionRowState('pending', true)).toEqual({
      disabled: true,
      showTier: false,
      statusLabel: 'pending',
    })
    expect(resolveSharedSessionRowState('active', true).disabled).toBe(false)
  })

  it('根据 owner 领域事实识别收到的共享，不依赖 direction', () => {
    expect(isOutgoingSessionShare({
      ownerUserId: 'owner-1',
      currentUserId: 'grantee-1',
    })).toBe(false)
  })

  it('根据 owner 领域事实识别发出的共享', () => {
    expect(isOutgoingSessionShare({
      ownerUserId: 'owner-1',
      currentUserId: 'owner-1',
    })).toBe(true)
  })
})
