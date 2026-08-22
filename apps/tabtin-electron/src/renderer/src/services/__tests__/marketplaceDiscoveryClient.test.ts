/**
 * marketplaceDiscoveryClient — Wave B-B3 单元测试。
 *
 * 覆盖：
 * - 成功响应：通过 ``app-discovery:update-patterns`` IPC 推送有效 patterns。
 * - 字段过滤：忽略缺字段 / 类型错误的 entry。
 * - 双层包裹解析：兼容 Django ``{success, data: {patterns}}`` 与裸 ``{patterns}``。
 * - 无效 / 网络失败：静默不抛错，不推送任何 patterns。
 * - 无 ipcRenderer 环境：跳过推送（mobile/web 不应触发）。
 * - sourceId = ``marketplace-api`` 与主进程 ``patternsBySource`` 约定一致。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const apiRequestMock = vi.fn()

vi.mock('@/adapters/api-adapter-instance', () => ({
  apiRequest: (...args: unknown[]) => apiRequestMock(...args),
}))

vi.mock('@/config/api', () => ({
  API_CONFIG: { baseURL: 'https://api.test' },
  API_ENDPOINTS: { MARKETPLACE: { DISCOVERY_PATTERNS: '/marketplace/discovery-patterns' } },
}))

import {
  __test__,
  bootstrapMarketplaceDiscoveryPatterns,
} from '../marketplaceDiscoveryClient'

const { extractPatterns, isValidEntry, SOURCE_ID } = __test__

interface MockIpc {
  send: ReturnType<typeof vi.fn>
}

// setup.ts 给 ``window.electron`` 加了不可 reconfigure 的描述符（只 writable: true，
// 默认 configurable: false），所以这里直接赋值替换 value，避免 ``Object.defineProperty``
// 二次报 "Cannot redefine property"。
function installIpc(): MockIpc {
  const ipc: MockIpc = { send: vi.fn() }
  ;(window as unknown as { electron: { ipcRenderer: MockIpc } }).electron = {
    ipcRenderer: ipc,
  }
  return ipc
}

function uninstallIpc() {
  ;(window as unknown as { electron: unknown }).electron = undefined
}

describe('marketplaceDiscoveryClient — extractPatterns', () => {
  it('reads patterns from {data: {patterns}} envelope (Django ninja)', () => {
    expect(
      extractPatterns({
        data: {
          patterns: [
            { appId: 'demo-app', appName: 'Demo App', patterns: ['*.demo.example.com'] },
          ],
        },
      }),
    ).toEqual([{ appId: 'demo-app', appName: 'Demo App', patterns: ['*.demo.example.com'] }])
  })

  it('reads patterns from bare {patterns} envelope', () => {
    expect(
      extractPatterns({
        patterns: [
          { appId: 'demo-other', appName: 'Demo Other', patterns: ['*.other.local'] },
        ],
      }),
    ).toEqual([{ appId: 'demo-other', appName: 'Demo Other', patterns: ['*.other.local'] }])
  })

  it('reads patterns from doubly-nested data.data.patterns', () => {
    expect(
      extractPatterns({
        data: { data: { patterns: [
          { appId: 'x', appName: 'X', patterns: ['*.x.io'] },
        ] } },
      }),
    ).toEqual([{ appId: 'x', appName: 'X', patterns: ['*.x.io'] }])
  })

  it('returns null (not [] !) on invalid payload shapes — null guards IPC over-write', () => {
    expect(extractPatterns(null)).toBeNull()
    expect(extractPatterns(undefined)).toBeNull()
    expect(extractPatterns({})).toBeNull()
    expect(extractPatterns({ data: {} })).toBeNull()
    expect(extractPatterns({ data: { patterns: 'not-an-array' } })).toBeNull()
  })

  it('returns null when body is success:false (业务失败防止 source 被空数组清空)', () => {
    expect(
      extractPatterns({ success: false, code: 'ERR_X', data: null }),
    ).toBeNull()
    expect(
      extractPatterns({ success: false, data: { patterns: [] } }),
    ).toBeNull()
  })

  it('returns true empty array when body is {success:true, data:{patterns:[]}}', () => {
    expect(
      extractPatterns({ success: true, data: { patterns: [] } }),
    ).toEqual([])
  })

  it('filters out malformed entries (missing appId / wrong type)', () => {
    const dirty = {
      patterns: [
        { appId: 'demo-app', appName: 'Demo App', patterns: ['*.demo.example.com'] },
        { appId: '', appName: 'empty id', patterns: ['*.x'] },
        { appId: 'noPatterns' },
        { appName: 'no id', patterns: ['*.y'] },
        { appId: 'badPatterns', appName: 'bad', patterns: [123, '*.ok'] },
        'totally-not-an-object',
      ],
    }
    expect(extractPatterns(dirty)).toEqual([
      { appId: 'demo-app', appName: 'Demo App', patterns: ['*.demo.example.com'] },
    ])
  })

  it('isValidEntry rejects non-string patterns and empty strings', () => {
    expect(isValidEntry({ appId: 'a', appName: 'A', patterns: ['valid'] })).toBe(true)
    expect(isValidEntry({ appId: 'a', appName: 'A', patterns: [''] })).toBe(false)
    expect(isValidEntry({ appId: 'a', appName: 'A', patterns: [null] })).toBe(false)
  })
})

describe('marketplaceDiscoveryClient — bootstrapMarketplaceDiscoveryPatterns', () => {
  beforeEach(() => {
    apiRequestMock.mockReset()
    uninstallIpc()
  })

  it('on success: sends extracted patterns through app-discovery:update-patterns IPC', async () => {
    const ipc = installIpc()
    apiRequestMock.mockResolvedValue({
      status: 200,
      data: {
        data: {
          patterns: [
            { appId: 'demo-app', appName: 'Demo App', patterns: ['*.demo.example.com', '*.example.com'] },
          ],
        },
      },
    })

    await bootstrapMarketplaceDiscoveryPatterns()

    expect(apiRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.test/marketplace/discovery-patterns',
        method: 'GET',
      }),
    )
    expect(ipc.send).toHaveBeenCalledWith(
      'app-discovery:update-patterns',
      [
        { appId: 'demo-app', appName: 'Demo App', patterns: ['*.demo.example.com', '*.example.com'] },
      ],
      SOURCE_ID,
    )
    expect(SOURCE_ID).toBe('marketplace-api')
  })

  it('on empty patterns list: still pushes empty array (clears stale source state)', async () => {
    const ipc = installIpc()
    apiRequestMock.mockResolvedValue({
      status: 200,
      data: { data: { patterns: [] } },
    })

    await bootstrapMarketplaceDiscoveryPatterns()

    expect(ipc.send).toHaveBeenCalledWith(
      'app-discovery:update-patterns',
      [],
      SOURCE_ID,
    )
  })

  it('on HTTP failure (status >= 400): silent no-op, does not push any fallback', async () => {
    const ipc = installIpc()
    apiRequestMock.mockResolvedValue({ status: 503, data: null })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await bootstrapMarketplaceDiscoveryPatterns()

    expect(ipc.send).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('on apiRequest throwing: silent no-op, does not push any fallback', async () => {
    const ipc = installIpc()
    apiRequestMock.mockRejectedValue(new Error('network down'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await bootstrapMarketplaceDiscoveryPatterns()

    expect(ipc.send).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('skips entirely when window.electron is unavailable (web/mobile fallback)', async () => {
    uninstallIpc()
    apiRequestMock.mockResolvedValue({
      status: 200,
      data: { data: { patterns: [{ appId: 'demo-app', appName: 'Demo App', patterns: ['*.demo.example.com'] }] } },
    })

    await bootstrapMarketplaceDiscoveryPatterns()
    expect(apiRequestMock).not.toHaveBeenCalled()
  })

  it('does not push when payload deeply malformed (extractPatterns returns null)', async () => {
    const ipc = installIpc()
    apiRequestMock.mockResolvedValue({ status: 200, data: 'not-an-object' })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(bootstrapMarketplaceDiscoveryPatterns()).resolves.toBeUndefined()
    expect(ipc.send).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('does not push when body is success:false (avoids clearing marketplace-api source)', async () => {
    const ipc = installIpc()
    apiRequestMock.mockResolvedValue({
      status: 200,
      data: { success: false, code: 'ERR', data: null },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await bootstrapMarketplaceDiscoveryPatterns()
    expect(ipc.send).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('still pushes empty list when body explicitly says {success:true, patterns:[]}', async () => {
    const ipc = installIpc()
    apiRequestMock.mockResolvedValue({
      status: 200,
      data: { success: true, data: { patterns: [] } },
    })

    await bootstrapMarketplaceDiscoveryPatterns()
    expect(ipc.send).toHaveBeenCalledWith(
      'app-discovery:update-patterns',
      [],
      SOURCE_ID,
    )
  })
})
