import { beforeEach, describe, expect, it, vi } from 'vitest'

const organizationState = { selectedOrganization: { id: 'org-1' } }

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: { getState: () => organizationState },
}))

vi.mock('@/services/tabchatApi', () => ({ batchGetUsers: vi.fn() }))

vi.mock('./sessionResetRegistry', () => ({ registerResetAction: vi.fn() }))

import * as tabchatApi from '@/services/tabchatApi'
import { useUserProfileCache } from './useUserProfileCache'

describe('useUserProfileCache.upsertProfile', () => {
  beforeEach(() => {
    vi.mocked(tabchatApi.batchGetUsers).mockReset()
    useUserProfileCache.getState().reset()
  })

  it('用保存后的资料覆盖已缓存的旧昵称和头像', () => {
    useUserProfileCache.setState({
      profiles: {
        'user-5093': {
          id: 'user-5093',
          nickname: '',
          username: 'user_5093',
          avatar: 'old-avatar',
        },
      },
    })

    useUserProfileCache.getState().upsertProfile({
      id: 'user-5093',
      nickname: '晨曦',
      username: 'user_5093',
      avatar: 'new-avatar',
    })

    expect(useUserProfileCache.getState().getDisplayName('user-5093')).toBe('晨曦')
    expect(useUserProfileCache.getState().getAvatar('user-5093')).toBe('new-avatar')
  })

  it('拒绝乱序实时事件回退到较旧的资料版本', () => {
    useUserProfileCache.getState().upsertProfile({
      id: 'user-5093', nickname: '新版昵称', username: 'user_5093', avatar: 'new-avatar', revision: 2,
    })
    useUserProfileCache.getState().upsertProfile({
      id: 'user-5093', nickname: '旧昵称', username: 'user_5093', avatar: 'old-avatar', revision: 1,
    })

    expect(useUserProfileCache.getState().getDisplayName('user-5093')).toBe('新版昵称')
    expect(useUserProfileCache.getState().getAvatar('user-5093')).toBe('new-avatar')
  })

  it('拒绝飞行中旧 batch 响应覆盖更晚的实时资料', async () => {
    vi.useFakeTimers()
    let resolveBatch: (profiles: Awaited<ReturnType<typeof tabchatApi.batchGetUsers>>) => void
    vi.mocked(tabchatApi.batchGetUsers).mockReturnValueOnce(new Promise((resolve) => {
      resolveBatch = resolve
    }))

    useUserProfileCache.getState().ensureProfiles(['user-5093'])
    await vi.advanceTimersByTimeAsync(0)
    useUserProfileCache.getState().upsertProfile({
      id: 'user-5093', nickname: '实时新版', username: 'user_5093', avatar: 'new-avatar', revision: 2,
    })
    resolveBatch!([{ id: 'user-5093', nickname: '旧 batch', username: 'user_5093', avatar: 'old-avatar', revision: 1 }])
    await Promise.resolve()

    expect(useUserProfileCache.getState().getDisplayName('user-5093')).toBe('实时新版')
    vi.useRealTimers()
  })

  it('为带版本的头像追加缓存键，避免复用旧图片', () => {
    useUserProfileCache.getState().upsertProfile({
      id: 'user-5093',
      nickname: '晨曦',
      username: 'user_5093',
      avatar: 'https://cdn.example.com/avatar.png?token=abc',
      avatar_version: 'new-file-version',
      revision: 1,
    })

    expect(useUserProfileCache.getState().getAvatar('user-5093')).toBe(
      'https://cdn.example.com/avatar.png?token=abc&v=new-file-version',
    )
  })

  it('允许腾讯资料提示覆盖空占位', () => {
    useUserProfileCache.setState({
      profiles: {
        'user-new': { id: 'user-new', nickname: '', username: '', avatar: '' },
      },
    })

    useUserProfileCache.getState().upsertProfileHint({
      id: 'user-new',
      nickname: '沈庾涛',
    })

    expect(useUserProfileCache.getState().getDisplayName('user-new')).toBe('沈庾涛')
  })

  it('拒绝腾讯资料提示覆盖带版本的服务端资料', () => {
    useUserProfileCache.getState().upsertProfile({
      id: 'user-existing',
      nickname: '服务端昵称',
      avatar: 'https://example.com/avatar.png',
      revision: 3,
    })

    useUserProfileCache.getState().upsertProfileHint({
      id: 'user-existing',
      nickname: '腾讯旧昵称',
    })

    expect(useUserProfileCache.getState().profiles['user-existing']).toMatchObject({
      nickname: '服务端昵称',
      avatar: 'https://example.com/avatar.png',
      revision: 3,
    })
  })

  it('服务端 revision 为零时仍拒绝腾讯提示覆盖权威资料', () => {
    useUserProfileCache.getState().upsertProfile({
      id: 'user-existing',
      nickname: '服务端昵称',
      avatar: 'https://example.com/server.png',
      revision: 0,
    })

    useUserProfileCache.getState().upsertProfileHint({
      id: 'user-existing',
      nickname: '腾讯旧昵称',
      avatar: 'https://example.com/tencent.png',
    })

    expect(useUserProfileCache.getState().profiles['user-existing']).toMatchObject({
      nickname: '服务端昵称',
      avatar: 'https://example.com/server.png',
    })
  })

  it('未查到的用户不会写入永久空占位，后续事件可以重试', async () => {
    vi.useFakeTimers()
    vi.mocked(tabchatApi.batchGetUsers)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'user-new',
        nickname: '沈庾涛',
        username: 'user_1976',
        avatar: '',
        revision: 1,
      }])

    useUserProfileCache.getState().ensureProfiles(['user-new'])
    await vi.runAllTimersAsync()
    expect(useUserProfileCache.getState().profiles['user-new']).toBeUndefined()

    useUserProfileCache.getState().ensureProfiles(['user-new'])
    await vi.runAllTimersAsync()

    expect(tabchatApi.batchGetUsers).toHaveBeenCalledTimes(2)
    expect(useUserProfileCache.getState().getDisplayName('user-new')).toBe('沈庾涛')
    vi.useRealTimers()
  })
})
