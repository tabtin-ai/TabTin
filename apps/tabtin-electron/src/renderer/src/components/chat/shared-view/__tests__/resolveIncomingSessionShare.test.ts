import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSessionShare: vi.fn(),
  listIncomingSessionShares: vi.fn(),
}))

vi.mock('@/services/tabchatApi', () => ({
  getSessionShare: mocks.getSessionShare,
  listIncomingSessionShares: mocks.listIncomingSessionShares,
}))

import {
  resolveIncomingSessionShare,
  resolveRestoredIncomingSessionShare,
} from '../resolveIncomingSessionShare'

describe('resolveIncomingSessionShare', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('沿用 incoming 列表顺序选择同会话的最新有效授权', async () => {
    mocks.listIncomingSessionShares.mockResolvedValue([
      { id: 'share-latest', session_id: 'session-1' },
      { id: 'share-other', session_id: 'session-2' },
      { id: 'share-older', session_id: 'session-1' },
    ])

    await expect(resolveIncomingSessionShare('organization-1', 'session-1')).resolves.toEqual({
      id: 'share-latest',
      session_id: 'session-1',
    })
    expect(mocks.listIncomingSessionShares).toHaveBeenCalledWith('organization-1')
  })

  it('没有有效授权时返回 null', async () => {
    mocks.listIncomingSessionShares.mockResolvedValue([
      { id: 'share-other', session_id: 'session-2' },
    ])

    await expect(resolveIncomingSessionShare('organization-1', 'session-1')).resolves.toBeNull()
  })

  it('恢复标签时优先使用仍有效的原授权', async () => {
    mocks.getSessionShare.mockResolvedValue({
      id: 'share-current',
      session_id: 'session-1',
      status: 'active',
    })

    await expect(resolveRestoredIncomingSessionShare(
      'organization-1',
      'session-1',
      'share-current',
    )).resolves.toEqual({
      id: 'share-current',
      session_id: 'session-1',
      status: 'active',
    })
    expect(mocks.listIncomingSessionShares).not.toHaveBeenCalled()
  })

  it('原授权失效后切换到同会话的最新有效授权', async () => {
    mocks.getSessionShare.mockResolvedValue({
      id: 'share-revoked',
      session_id: 'session-1',
      status: 'revoked',
    })
    mocks.listIncomingSessionShares.mockResolvedValue([
      { id: 'share-latest', session_id: 'session-1' },
    ])

    await expect(resolveRestoredIncomingSessionShare(
      'organization-1',
      'session-1',
      'share-revoked',
    )).resolves.toEqual({ id: 'share-latest', session_id: 'session-1' })
  })
})
