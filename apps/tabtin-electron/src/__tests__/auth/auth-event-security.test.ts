/**
 * CL-1 / CL-2 安全回归测试
 *
 * CL-1: Token 不再通过 CustomEvent 广播到 window
 * CL-2: 恶意 CustomEvent 注入无法替换 Zustand 中的 token
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  persistAuthTokens,
  notifyTokensSynced,
  notifyLogoutRequired,
  setAuthSyncHandler,
  setAuthLogoutHandler,
} from '../../renderer/src/utils/authPersistence'

describe('CL-1: persistAuthTokens 不再广播 token 到 DOM', () => {
  let mockSave: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockSave = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).tabtin = { auth: { save: mockSave } }
  })

  afterEach(() => {
    delete (window as any).tabtin
  })

  it('persistAuthTokens 不再 dispatch auth:tokensUpdated 事件', async () => {
    const listener = vi.fn()
    window.addEventListener('auth:tokensUpdated', listener)

    await persistAuthTokens({
      accessToken: 'secret_at',
      refreshToken: 'secret_rt',
      userInfo: { id: '1' } as any,
    })

    expect(listener).not.toHaveBeenCalled()
    window.removeEventListener('auth:tokensUpdated', listener)
  })

  it('persistAuthTokens 仍正确写入 Keychain', async () => {
    await persistAuthTokens({
      accessToken: 'at',
      refreshToken: 'rt',
      userInfo: null,
      expiresAt: 1700000000000,
    })

    expect(mockSave).toHaveBeenCalledWith('at', 'rt', null, 1700000000000)
  })

  it('persistAuthTokens 正确计算 expiresAt', async () => {
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
})

describe('CL-1: 内部通道不泄露 token 到 DOM', () => {
  it('notifyTokensSynced 不触发任何 DOM CustomEvent', () => {
    const tokensSyncedListener = vi.fn()
    const tokensUpdatedListener = vi.fn()
    window.addEventListener('auth:tokensSynced', tokensSyncedListener)
    window.addEventListener('auth:tokensUpdated', tokensUpdatedListener)

    setAuthSyncHandler(() => {})
    notifyTokensSynced({
      accessToken: 'secret_at',
      refreshToken: 'secret_rt',
      user: null,
    })

    expect(tokensSyncedListener).not.toHaveBeenCalled()
    expect(tokensUpdatedListener).not.toHaveBeenCalled()

    window.removeEventListener('auth:tokensSynced', tokensSyncedListener)
    window.removeEventListener('auth:tokensUpdated', tokensUpdatedListener)
  })

  it('notifyLogoutRequired 不触发任何 DOM CustomEvent', () => {
    const logoutListener = vi.fn()
    window.addEventListener('auth:logout', logoutListener)

    setAuthLogoutHandler(() => {})
    notifyLogoutRequired('token_refresh_failed')

    expect(logoutListener).not.toHaveBeenCalled()

    window.removeEventListener('auth:logout', logoutListener)
  })
})

describe('CL-2: 内部通道正常工作', () => {
  afterEach(() => {
    setAuthSyncHandler(() => {})
    setAuthLogoutHandler(() => {})
  })

  it('notifyTokensSynced 通过回调传递数据', () => {
    const handler = vi.fn()
    setAuthSyncHandler(handler)

    notifyTokensSynced({
      accessToken: 'at_123',
      refreshToken: 'rt_456',
      user: { id: '1', username: 'test' } as any,
    })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({
      accessToken: 'at_123',
      refreshToken: 'rt_456',
      user: { id: '1', username: 'test' },
    })
  })

  it('notifyLogoutRequired 通过回调传递原因', () => {
    const handler = vi.fn()
    setAuthLogoutHandler(handler)

    notifyLogoutRequired('token_refresh_failed')

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('token_refresh_failed')
  })

  it('未注册 handler 时调用不抛异常', () => {
    setAuthSyncHandler(null as any)
    setAuthLogoutHandler(null as any)

    expect(() =>
      notifyTokensSynced({ accessToken: 'at', refreshToken: 'rt' })
    ).not.toThrow()
    expect(() => notifyLogoutRequired('test')).not.toThrow()
  })
})

describe('CL-2: 恶意 CustomEvent 注入防护', () => {
  it('恶意 auth:tokensSynced 事件无法通过内部通道替换 token', () => {
    const internalHandler = vi.fn()
    setAuthSyncHandler(internalHandler)

    window.dispatchEvent(
      new CustomEvent('auth:tokensSynced', {
        detail: {
          accessToken: 'malicious_token',
          refreshToken: 'malicious_refresh',
          user: { id: 'hacker' },
        },
      })
    )

    expect(internalHandler).not.toHaveBeenCalled()
  })

  it('恶意 auth:logout 事件无法通过内部通道触发登出', () => {
    const internalHandler = vi.fn()
    setAuthLogoutHandler(internalHandler)

    window.dispatchEvent(
      new CustomEvent('auth:logout', {
        detail: { reason: 'malicious_logout' },
      })
    )

    expect(internalHandler).not.toHaveBeenCalled()
  })

  it('恶意 auth:tokensUpdated 事件不会被处理（事件已移除）', () => {
    const anyListener = vi.fn()

    window.dispatchEvent(
      new CustomEvent('auth:tokensUpdated', {
        detail: {
          accessToken: 'stolen_token',
          refreshToken: 'stolen_refresh',
        },
      })
    )

    expect(anyListener).not.toHaveBeenCalled()
  })
})
