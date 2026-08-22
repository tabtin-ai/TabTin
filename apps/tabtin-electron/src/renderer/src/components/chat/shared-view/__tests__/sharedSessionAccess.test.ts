import { describe, expect, it, vi } from 'vitest'
import {
  parseSessionCollaborationAccessRevokedEvent,
  parseSessionCollaborationAccessRestoredEvent,
  resolveSharedSessionAccess,
} from '../sharedSessionAccess'

vi.mock('@tabtin/chat-client', () => ({ ChatAPIError: class ChatAPIError {} }))
vi.mock('@/services/sessionShareApi', () => ({ ShareApiError: class ShareApiError {} }))

describe('resolveSharedSessionAccess', () => {
  it('owner 在停止共享后仍可查看原任务', () => {
    expect(resolveSharedSessionAccess({
      currentUserId: 'owner-1',
      share: {
        owner_user_id: 'owner-1',
        status: 'revoked',
      },
      detailLoaded: true,
      accessDenied: false,
    })).toEqual({
      isOwner: true,
      denied: false,
      canAccessTimeline: true,
    })
  })

  it('grantee 在停止共享后进入无权态', () => {
    expect(resolveSharedSessionAccess({
      currentUserId: 'grantee-1',
      share: {
        owner_user_id: 'owner-1',
        status: 'revoked',
      },
      detailLoaded: true,
      accessDenied: false,
    })).toEqual({
      isOwner: false,
      denied: true,
      canAccessTimeline: false,
    })
  })
})

describe('parseSessionCollaborationAccessRevokedEvent', () => {
  it('解析撤权控制事件并拒绝不完整载荷', () => {
    expect(parseSessionCollaborationAccessRevokedEvent({
      type: 'session.collaboration.access_revoked',
      payload: {
        object_id: 'share-1',
        version: 2,
        access_epoch: 2,
      },
    })).toEqual({ objectId: 'share-1', version: 2, accessEpoch: 2 })

    expect(parseSessionCollaborationAccessRevokedEvent({
      type: 'session.collaboration.access_revoked',
      payload: { object_id: 'share-1' },
    })).toBeNull()
  })
})

describe('parseSessionCollaborationAccessRestoredEvent', () => {
  it('解析恢复授权通知并拒绝不完整载荷', () => {
    expect(parseSessionCollaborationAccessRestoredEvent({
      type: 'session.collaboration.access_restored',
      payload: {
        object_id: 'share-1',
        version: 3,
        access_epoch: 3,
      },
    })).toEqual({ objectId: 'share-1', version: 3, accessEpoch: 3 })

    expect(parseSessionCollaborationAccessRestoredEvent({
      type: 'session.collaboration.access_restored',
      payload: { object_id: 'share-1' },
    })).toBeNull()
  })
})
