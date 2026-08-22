/**
 * FP-024 / FP-026 回归测试
 *
 * FP-024: token 刷新时不应通过 notifyTokensSynced 传递完整 user 对象
 * FP-026: useAuthStore partialize 不应将 PII（email/phone）持久化到 localStorage
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PERSIST_KEYS } from '../../renderer/src/stores/persist-key-registry'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

describe('FP-026: useAuthStore partialize 过滤 PII 字段', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()

    ;(window as any).tabtin = {
      auth: {
        save: vi.fn().mockResolvedValue({ success: true }),
        load: vi.fn().mockResolvedValue(null),
        clear: vi.fn().mockResolvedValue({ success: true }),
        getAccessToken: vi.fn().mockResolvedValue({ success: false }),
        getRefreshToken: vi.fn().mockResolvedValue({ success: false }),
        isTokenExpiringSoon: vi.fn().mockResolvedValue({ success: false }),
      },
    }
  })

  afterEach(() => {
    localStorage.clear()
    delete (window as any).tabtin
  })

  it('partialize 不应将 email 和 phone 写入 localStorage', async () => {
    const { useAuthStore } = await import(
      '../../renderer/src/stores/useAuthStore'
    )

    const fullUser = {
      id: 'u-001',
      username: 'testuser',
      email: 'secret@example.com',
      phone: '+8613800138000',
      nickname: 'Test',
      avatar: 'https://cdn.example.com/avatar.png',
      bio: 'some bio',
      is_verified_email: true,
      is_verified_phone: true,
      date_joined: '2025-01-01T00:00:00Z',
      last_login: '2026-03-18T00:00:00Z',
      login_count: 42,
    }

    useAuthStore.setState({
      isAuthenticated: true,
      user: fullUser as any,
    })

    // Zustand persist 同步写入 localStorage
    await vi.waitFor(() => {
      const raw = localStorage.getItem(PERSIST_KEYS.auth)
      expect(raw).toBeTruthy()
    })

    const raw = localStorage.getItem(PERSIST_KEYS.auth)!
    const persisted = JSON.parse(raw)
    const persistedUser = persisted.state?.user

    expect(persistedUser).toBeTruthy()
    expect(persistedUser.id).toBe('u-001')
    expect(persistedUser.username).toBe('testuser')
    expect(persistedUser.nickname).toBe('Test')
    expect(persistedUser.avatar).toBe('https://cdn.example.com/avatar.png')
    expect(persistedUser.is_verified_email).toBe(true)
    expect(persistedUser.is_verified_phone).toBe(true)
    expect(persistedUser.login_count).toBe(42)

    expect(persistedUser).not.toHaveProperty('email')
    expect(persistedUser).not.toHaveProperty('phone')
    expect(persistedUser).not.toHaveProperty('bio')
    expect(persistedUser).not.toHaveProperty('date_joined')
    expect(persistedUser).not.toHaveProperty('last_login')
  })

  it('user 为 null 时 partialize 不应崩溃', async () => {
    const { useAuthStore } = await import(
      '../../renderer/src/stores/useAuthStore'
    )

    useAuthStore.setState({
      isAuthenticated: false,
      user: null,
    })

    await vi.waitFor(() => {
      const raw = localStorage.getItem(PERSIST_KEYS.auth)
      expect(raw).toBeTruthy()
    })

    const raw = localStorage.getItem(PERSIST_KEYS.auth)!
    const persisted = JSON.parse(raw)

    expect(persisted.state?.user).toBeNull()
  })

  it('内存中的 user 仍保留完整字段（PII 仅从 localStorage 剔除）', async () => {
    const { useAuthStore } = await import(
      '../../renderer/src/stores/useAuthStore'
    )

    const fullUser = {
      id: 'u-002',
      email: 'user@example.com',
      phone: '+8613900139000',
      nickname: 'FullUser',
    }

    useAuthStore.setState({ user: fullUser as any })

    const inMemory = useAuthStore.getState().user
    expect(inMemory?.email).toBe('user@example.com')
    expect(inMemory?.phone).toBe('+8613900139000')
  })
})

describe('FP-024: token 刷新不应通过 notifyTokensSynced 传递 user', () => {
  it('notifyTokensSynced 不含 user 时 syncHandler 不更新 user', async () => {
    const handler = vi.fn()

    const { setAuthSyncHandler, notifyTokensSynced } = await import(
      '../../renderer/src/utils/authPersistence'
    )

    setAuthSyncHandler(handler)

    notifyTokensSynced({
      accessToken: 'new_at',
      refreshToken: 'new_rt',
    })

    expect(handler).toHaveBeenCalledTimes(1)
    const payload = handler.mock.calls[0][0]
    expect(payload.accessToken).toBe('new_at')
    expect(payload.refreshToken).toBe('new_rt')
    expect(payload).not.toHaveProperty('user')
  })
})
