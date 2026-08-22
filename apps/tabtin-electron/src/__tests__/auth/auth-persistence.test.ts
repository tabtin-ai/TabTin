/**
 * authPersistence 模块测试
 * 测试 token 持久化逻辑（CL-1 修复后不再广播 DOM 事件）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { persistAuthTokens } from '../../renderer/src/utils/authPersistence'

describe('persistAuthTokens', () => {
  let mockSave: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockSave = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).tabtin = {
      auth: {
        save: mockSave,
      },
    }
  })

  afterEach(() => {
    delete (window as any).tabtin
  })

  it('应正确传递所有参数到 auth.save', async () => {
    await persistAuthTokens({
      accessToken: 'at',
      refreshToken: 'rt',
      userInfo: { id: '1' } as any,
      expiresAt: 1700000000000,
    })

    expect(mockSave).toHaveBeenCalledWith('at', 'rt', { id: '1' }, 1700000000000)
  })

  it('应从 expiresIn 计算 expiresAt', async () => {
    const before = Date.now()
    const result = await persistAuthTokens({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresIn: 3600,
    })
    const after = Date.now()

    expect(result).toBeGreaterThanOrEqual(before + 3600 * 1000)
    expect(result).toBeLessThanOrEqual(after + 3600 * 1000)
  })

  it('expiresAt 优先于 expiresIn', async () => {
    const result = await persistAuthTokens({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 9999999,
      expiresIn: 3600,
    })

    expect(result).toBe(9999999)
  })

  it('无过期时间时返回 null', async () => {
    const result = await persistAuthTokens({
      accessToken: 'at',
      refreshToken: 'rt',
    })

    expect(result).toBeNull()
    expect(mockSave).toHaveBeenCalledWith('at', 'rt', null, null)
  })

  it('不应广播任何 DOM 事件（CL-1 安全修复）', async () => {
    const tokensUpdatedListener = vi.fn()
    const tokensSyncedListener = vi.fn()
    window.addEventListener('auth:tokensUpdated', tokensUpdatedListener)
    window.addEventListener('auth:tokensSynced', tokensSyncedListener)

    await persistAuthTokens({
      accessToken: 'at',
      refreshToken: 'rt',
      userInfo: { id: '1' } as any,
    })

    expect(tokensUpdatedListener).not.toHaveBeenCalled()
    expect(tokensSyncedListener).not.toHaveBeenCalled()

    window.removeEventListener('auth:tokensUpdated', tokensUpdatedListener)
    window.removeEventListener('auth:tokensSynced', tokensSyncedListener)
  })
})
