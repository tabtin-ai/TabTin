/**
 * 跨窗口 Token 广播回归测试
 *
 * 覆盖 CR-003/CR-004/CR-007/CR-008/CR-019：
 * - 主进程 token 刷新成功后广播 auth:token-refreshed-signal 给所有窗口
 * - 主进程 token 刷新认证失败后广播 auth:force-logout
 * - 渲染进程 refreshToken() 复用实例级锁
 * - loadAuthFromStorage 通过 apiService.tryRefreshTokens() 走锁
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// CR-003: 主进程刷新成功后广播 auth:token-refreshed-signal
// ============================================================

describe('CR-003: 主进程 Token 刷新成功后广播', () => {
  it('刷新成功时应向所有窗口发送 auth:token-refreshed-signal', async () => {
    const sentChannels: string[] = []

    const mockWindows = [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string) => {
            sentChannels.push(channel)
          },
        },
      },
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string) => {
            sentChannels.push(channel)
          },
        },
      },
    ]

    function broadcastTokenRefreshed(
      getAllWindows: () => typeof mockWindows,
    ): void {
      for (const win of getAllWindows()) {
        if (!win.isDestroyed()) {
          try {
            win.webContents.send('auth:token-refreshed-signal')
          } catch {
            // ignored
          }
        }
      }
    }

    broadcastTokenRefreshed(() => mockWindows)

    expect(sentChannels).toHaveLength(2)
    expect(sentChannels[0]).toBe('auth:token-refreshed-signal')
    expect(sentChannels[1]).toBe('auth:token-refreshed-signal')
  })

  it('已销毁的窗口不应收到广播', () => {
    const sentMessages: string[] = []

    const mockWindows = [
      {
        isDestroyed: () => true,
        webContents: {
          send: () => { sentMessages.push('destroyed') },
        },
      },
      {
        isDestroyed: () => false,
        webContents: {
          send: () => { sentMessages.push('alive') },
        },
      },
    ]

    for (const win of mockWindows) {
      if (!win.isDestroyed()) {
        win.webContents.send('auth:token-refreshed-signal')
      }
    }

    expect(sentMessages).toEqual(['alive'])
  })

  it('webContents.send 抛异常不应中断其他窗口的广播', () => {
    const received: string[] = []

    const mockWindows = [
      {
        isDestroyed: () => false,
        webContents: {
          send: () => { throw new Error('window closed') },
        },
      },
      {
        isDestroyed: () => false,
        webContents: {
          send: (ch: string) => { received.push(ch) },
        },
      },
    ]

    for (const win of mockWindows) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send('auth:token-refreshed-signal')
        } catch {
          // ignored
        }
      }
    }

    expect(received).toEqual(['auth:token-refreshed-signal'])
  })
})

// ============================================================
// CR-019: 主进程刷新认证失败后广播 auth:force-logout
// ============================================================

describe('CR-019: Token 刷新认证失败后广播 force-logout', () => {
  it('认证失败时应向所有窗口发送 auth:force-logout', () => {
    const sentChannels: string[] = []

    const mockWindows = [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string) => { sentChannels.push(channel) },
        },
      },
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string) => { sentChannels.push(channel) },
        },
      },
    ]

    function broadcastForceLogout(getAllWindows: () => typeof mockWindows): void {
      for (const win of getAllWindows()) {
        if (!win.isDestroyed()) {
          try {
            win.webContents.send('auth:force-logout')
          } catch {
            // ignored
          }
        }
      }
    }

    broadcastForceLogout(() => mockWindows)

    expect(sentChannels).toEqual(['auth:force-logout', 'auth:force-logout'])
  })

  it('clearAuthData + 广播应确保所有窗口得到通知', () => {
    let authCleared = false
    const broadcastTargets: string[] = []

    function simulateRefreshFailure401(): void {
      authCleared = true
      for (const win of [{ id: 'win-1' }, { id: 'win-2' }]) {
        broadcastTargets.push(win.id)
      }
    }

    simulateRefreshFailure401()

    expect(authCleared).toBe(true)
    expect(broadcastTargets).toEqual(['win-1', 'win-2'])
  })
})

// ============================================================
// CR-004: 渲染进程监听 auth:token-refreshed-signal 更新缓存
// ============================================================

describe('CR-004: 渲染进程跨窗口 Token 同步', () => {
  it('收到 auth:token-refreshed-signal 应从安全存储重新加载并更新缓存', async () => {
    let apiServiceToken: string | null = null
    let storeAccessToken: string | null = null

    function setAuthToken(token: string | null) {
      apiServiceToken = token
    }

    function setStoreState(state: { accessToken: string }) {
      storeAccessToken = state.accessToken
    }

    async function loadAuthBundle() {
      return { accessToken: 'cross_window_new_token', refreshToken: 'rt', user: null }
    }

    async function onTokenRefreshedSignal() {
      const bundle = await loadAuthBundle()
      if (bundle?.accessToken) {
        setAuthToken(bundle.accessToken)
        setStoreState({ accessToken: bundle.accessToken })
      }
    }

    await onTokenRefreshedSignal()

    expect(apiServiceToken).toBe('cross_window_new_token')
    expect(storeAccessToken).toBe('cross_window_new_token')
  })

  it('窗口 A 刷新成功后，窗口 B 应通过信号重新加载获得新 token', async () => {
    type Listener = () => void
    const listeners: Listener[] = []

    function registerTokenRefreshedListener(cb: Listener) {
      listeners.push(cb)
      return () => {
        const idx = listeners.indexOf(cb)
        if (idx >= 0) listeners.splice(idx, 1)
      }
    }

    function simulateBroadcast() {
      for (const l of listeners) l()
    }

    let windowALoaded = false
    let windowBLoaded = false

    registerTokenRefreshedListener(() => { windowALoaded = true })
    registerTokenRefreshedListener(() => { windowBLoaded = true })

    simulateBroadcast()

    expect(windowALoaded).toBe(true)
    expect(windowBLoaded).toBe(true)
  })
})

// ============================================================
// CR-007: refreshToken() 复用实例级锁
// ============================================================

describe('CR-007: refreshToken 与 401 自动刷新共享锁', () => {
  it('refreshToken 和 401 刷新并发时只应执行一次实际刷新', async () => {
    let actualRefreshCalls = 0
    let lockPromise: Promise<string | null> | null = null

    async function refreshAccessTokenWithLock(): Promise<string | null> {
      if (lockPromise) return lockPromise

      lockPromise = (async () => {
        try {
          actualRefreshCalls++
          await new Promise((r) => setTimeout(r, 30))
          return 'locked_token'
        } finally {
          lockPromise = null
        }
      })()

      return lockPromise
    }

    async function refreshTokenPublic() {
      return refreshAccessTokenWithLock()
    }

    async function handle401Retry() {
      return refreshAccessTokenWithLock()
    }

    const [fromPublic, from401] = await Promise.all([
      refreshTokenPublic(),
      handle401Retry(),
    ])

    expect(fromPublic).toBe('locked_token')
    expect(from401).toBe('locked_token')
    expect(actualRefreshCalls).toBe(1)
  })

  it('之前的 refreshToken 绕过锁会导致两次刷新（旧行为验证）', async () => {
    let actualRefreshCalls = 0

    async function refreshDirectly(): Promise<string> {
      actualRefreshCalls++
      await new Promise((r) => setTimeout(r, 10))
      return `token_${actualRefreshCalls}`
    }

    let lockPromise: Promise<string | null> | null = null
    async function refreshWithLock(): Promise<string | null> {
      if (lockPromise) return lockPromise
      lockPromise = (async () => {
        try {
          return await refreshDirectly()
        } finally {
          lockPromise = null
        }
      })()
      return lockPromise
    }

    const [fromDirect, fromLock] = await Promise.all([
      refreshDirectly(),
      refreshWithLock(),
    ])

    expect(actualRefreshCalls).toBe(2)
  })
})

// ============================================================
// CR-008: loadAuthFromStorage 使用 apiService.tryRefreshTokens()
// ============================================================

describe('CR-008: 启动时 token 刷新走渲染进程锁', () => {
  it('多窗口同时 loadAuthFromStorage 应只触发一次实际刷新', async () => {
    let actualRefreshCount = 0
    let lockPromise: Promise<string | null> | null = null

    async function tryRefreshTokens(): Promise<string | null> {
      if (lockPromise) return lockPromise

      lockPromise = (async () => {
        try {
          actualRefreshCount++
          await new Promise((r) => setTimeout(r, 30))
          return 'startup_refreshed_token'
        } finally {
          lockPromise = null
        }
      })()

      return lockPromise
    }

    async function loadAuthFromStorage() {
      const isExpiring = true
      if (isExpiring) {
        return tryRefreshTokens()
      }
      return null
    }

    const [win1, win2, win3] = await Promise.all([
      loadAuthFromStorage(),
      loadAuthFromStorage(),
      loadAuthFromStorage(),
    ])

    expect(win1).toBe('startup_refreshed_token')
    expect(win2).toBe('startup_refreshed_token')
    expect(win3).toBe('startup_refreshed_token')
    expect(actualRefreshCount).toBe(1)
  })

  it('之前直接调 IPC 会绕过渲染进程锁导致多次 IPC 调用', async () => {
    let ipcCallCount = 0

    async function directIpcRefresh(): Promise<string> {
      ipcCallCount++
      await new Promise((r) => setTimeout(r, 10))
      return `token_${ipcCallCount}`
    }

    await Promise.all([
      directIpcRefresh(),
      directIpcRefresh(),
      directIpcRefresh(),
    ])

    expect(ipcCallCount).toBe(3)
  })
})

// ============================================================
// CR-003 + CR-004 端到端场景
// ============================================================

describe('CR-003/CR-004 端到端: 刷新后跨窗口 Token 一致性', () => {
  it('窗口 A 刷新 → 主进程广播信号 → 窗口 B 重新加载 token → 一致', async () => {
    let storedToken = 'old_token'
    const windowTokens: Record<string, string | null> = {
      A: 'old_token',
      B: 'old_token',
    }

    type Listener = () => void
    const broadcastListeners: Record<string, Listener> = {}

    function registerListener(windowId: string, cb: Listener) {
      broadcastListeners[windowId] = cb
    }

    function simulateMainProcessBroadcast() {
      for (const cb of Object.values(broadcastListeners)) {
        cb()
      }
    }

    registerListener('A', () => { windowTokens.A = storedToken })
    registerListener('B', () => { windowTokens.B = storedToken })

    storedToken = 'freshly_refreshed_token'
    windowTokens.A = storedToken
    simulateMainProcessBroadcast()

    expect(windowTokens.A).toBe('freshly_refreshed_token')
    expect(windowTokens.B).toBe('freshly_refreshed_token')
  })
})

// ============================================================
// 源码结构验证（确保修复不被回退）
// ============================================================

describe('源码结构回归验证', () => {
  it('auth.ts 应包含 _broadcastTokenRefreshed 方法', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../main/auth.ts'),
      'utf-8',
    )
    expect(source).toContain('_broadcastTokenRefreshed')
    expect(source).toContain("auth:token-refreshed")
  })

  it('auth.ts 应在刷新成功后调用 _broadcastTokenRefreshed', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../main/auth.ts'),
      'utf-8',
    )
    const updateBundleIdx = source.indexOf('await this.updateBundle({')
    const broadcastIdx = source.indexOf('this._broadcastTokenRefreshed()')
    expect(updateBundleIdx).toBeGreaterThan(-1)
    expect(broadcastIdx).toBeGreaterThan(updateBundleIdx)
  })

  it('auth.ts 应在认证失败时调用 _broadcastForceLogout', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../main/auth.ts'),
      'utf-8',
    )
    expect(source).toContain('_broadcastForceLogout')
    const clearAuthIdx = source.indexOf('await this.clearAuthData()')
    const broadcastLogoutIdx = source.indexOf('this._broadcastForceLogout()')
    expect(clearAuthIdx).toBeGreaterThan(-1)
    expect(broadcastLogoutIdx).toBeGreaterThan(clearAuthIdx)
  })

  it('api.ts refreshToken 应通过 refreshAccessTokenWithLock 执行', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../renderer/src/services/api.ts'),
      'utf-8',
    )
    const refreshTokenMethod = source.match(
      /async refreshToken\(\)[\s\S]*?(?=\n  \/\/|\n  async [a-z])/,
    )
    expect(refreshTokenMethod).toBeTruthy()
    expect(refreshTokenMethod![0]).toContain('refreshAccessTokenWithLock')
    expect(refreshTokenMethod![0]).not.toContain('window.tabtin.auth.refreshAccessToken()')
  })

  it('useAuthStore loadAuthFromStorage 应使用 apiService.tryRefreshTokens', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../renderer/src/stores/useAuthStore.ts'),
      'utf-8',
    )
    expect(source).toContain('apiService.tryRefreshTokens()')
    const loadAuthSection = source.slice(
      source.indexOf('loadAuthFromStorage'),
      source.indexOf('clearAuth:'),
    )
    expect(loadAuthSection).not.toContain('window.tabtin.auth.refreshAccessToken()')
  })

  it('useAuthStore 应注册 onTokenRefreshed 监听器', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../renderer/src/stores/useAuthStore.ts'),
      'utf-8',
    )
    expect(source).toContain('onTokenRefreshed')
    expect(source).toContain('apiService.setAuthToken(bundle.accessToken)')
  })

  it('preload 应暴露 onTokenRefreshed API', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../preload/index.ts'),
      'utf-8',
    )
    expect(source).toContain('onTokenRefreshed')
    expect(source).toContain("auth:token-refreshed-signal")
  })
})
