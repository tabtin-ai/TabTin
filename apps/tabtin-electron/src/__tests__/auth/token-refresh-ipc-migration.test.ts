/**
 * Token 刷新 IPC 迁移回归测试
 *
 * 验证 SS-31 迁移完成后：
 * - 渲染进程不再调用已废弃的 auth:getRefreshToken IPC
 * - 所有刷新路径统一委托主进程 auth:refreshAccessToken
 * - 渲染进程不再直接写 Keychain（auth.save）做 token 持久化
 *
 * 覆盖问题: TA-001, TA-002, TA-003, TA-004, TA-005, TL-003, TL-004, TL-005
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SERVICES_DIR = resolve(__dirname, '../../renderer/src/services')
const PRELOAD_DIR = resolve(__dirname, '../../preload')

function readSource(dir: string, file: string): string {
  return readFileSync(resolve(dir, file), 'utf-8')
}

describe('TA-001 / TL-003 回归：废弃 auth:getRefreshToken IPC 不应被调用', () => {
  it('preload/index.ts 不应包含 auth:getRefreshToken IPC invoke', () => {
    const source = readSource(PRELOAD_DIR, 'index.ts')
    expect(source).not.toContain("auth:getRefreshToken")
  })

  it('api.ts 不应调用 window.tabtin.auth.getRefreshToken()', () => {
    const source = readSource(SERVICES_DIR, 'api.ts')
    expect(source).not.toContain('.getRefreshToken()')
  })

  it('tabtin-client.ts 不应调用 window.tabtin.auth.getRefreshToken()', () => {
    const source = readSource(SERVICES_DIR, 'tabtin-client.ts')
    expect(source).not.toContain('.auth.getRefreshToken')
    expect(source).not.toContain("auth?.getRefreshToken")
  })
})

describe('TA-004 / TL-008 回归：preload 类型声明不应保留废弃方法', () => {
  it('preload 类型声明中 auth 接口应包含 refreshAccessToken', () => {
    const source = readSource(PRELOAD_DIR, 'index.ts')
    expect(source).toContain('refreshAccessToken')
  })

  it('preload 实现中应 invoke auth:refreshAccessToken', () => {
    const source = readSource(PRELOAD_DIR, 'index.ts')
    // W2-α(contract)：preload 所有 IPC 入口已由 ipc-shim 的 invokeIpc 包装接管，
    // 不再裸调 ipcRenderer.invoke；正则容忍可选泛型参数
    // （实际形态 `invokeIpc<AuthRefreshLegacyResult>('auth:refreshAccessToken')`）。
    expect(source).toMatch(/invokeIpc(<[^>]+>)?\(\s*['"]auth:refreshAccessToken['"]/)
  })
})

describe('TA-002 / TA-003 / TL-005 回归：渲染进程刷新应委托主进程', () => {
  it('api.ts 不应在 refreshToken 方法中直接发送 HTTP 刷新请求', () => {
    const source = readSource(SERVICES_DIR, 'api.ts')
    expect(source).not.toContain('body: JSON.stringify({ refresh_token:')
    expect(source).not.toMatch(/apiRequest\(\{[\s\S]*?refresh-token/)
  })

  it('api.ts 的 refreshToken 方法应调用 refreshAccessToken IPC', () => {
    const source = readSource(SERVICES_DIR, 'api.ts')
    expect(source).toContain('window.tabtin.auth.refreshAccessToken()')
  })

  it('api.ts 不应维护 refreshTokenValue 内存缓存', () => {
    const source = readSource(SERVICES_DIR, 'api.ts')
    expect(source).not.toContain('refreshTokenValue')
  })

  it('tabtin-client.ts 不应包含渲染进程侧的 refresh-token HTTP 请求', () => {
    const source = readSource(SERVICES_DIR, 'tabtin-client.ts')
    expect(source).not.toContain('/auth/refresh-token')
  })

  it('tabtin-client.ts 的 refresh 回调应委托主进程', () => {
    const source = readSource(SERVICES_DIR, 'tabtin-client.ts')
    expect(source).toContain('window.tabtin.auth.refreshAccessToken()')
  })
})

describe('TA-005 / TL-004 回归：渲染进程不应直接写 Keychain', () => {
  it('tabtin-client.ts 不应调用 auth.save() 直接持久化 token', () => {
    const source = readSource(SERVICES_DIR, 'tabtin-client.ts')
    expect(source).not.toContain('auth.save(')
    expect(source).not.toContain('auth?.save(')
  })

  it('api.ts 的 refreshAccessTokenWithLock 不应调用 persistAuthTokens', () => {
    const source = readSource(SERVICES_DIR, 'api.ts')
    expect(source).not.toContain('persistAuthTokens')
  })

  it('tabtin-client.ts 刷新成功后应通过 notifyTokensSynced 同步内存状态', () => {
    const source = readSource(SERVICES_DIR, 'tabtin-client.ts')
    expect(source).toContain('notifyTokensSynced')
  })
})

describe('统一刷新架构验证', () => {
  it('所有渲染进程刷新路径应最终通过 refreshAccessToken IPC', () => {
    const apiSource = readSource(SERVICES_DIR, 'api.ts')
    const clientSource = readSource(SERVICES_DIR, 'tabtin-client.ts')
    const preloadSource = readSource(PRELOAD_DIR, 'index.ts')

    const apiUsesIpc = apiSource.includes('window.tabtin.auth.refreshAccessToken()')
    const clientUsesIpc = clientSource.includes('window.tabtin.auth.refreshAccessToken()')
    // W2-α(contract)：preload 经 ipc-shim 的 invokeIpc 包装调起 auth:refreshAccessToken
    // （取代裸 ipcRenderer.invoke）；正则容忍可选泛型参数。
    const preloadExposesIpc = /invokeIpc(<[^>]+>)?\(\s*['"]auth:refreshAccessToken['"]/.test(preloadSource)

    expect(apiUsesIpc).toBe(true)
    expect(clientUsesIpc).toBe(true)
    expect(preloadExposesIpc).toBe(true)
  })

  it('api.ts refreshToken 方法应返回 auth.get() 获取的完整 bundle', () => {
    const source = readSource(SERVICES_DIR, 'api.ts')
    expect(source).toContain('window.tabtin.auth.get()')
    expect(source).toContain('authBundle')
  })
})
