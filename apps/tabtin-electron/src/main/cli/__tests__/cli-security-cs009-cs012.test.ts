/**
 * 回归测试：CS-009、CS-010、CS-011、CS-012
 *
 * CS-009: /table/create 字段创建失败时应返回 207 而非 200+ok:true
 * CS-010: refreshAccessToken 的 fetch 必须有超时保护（AbortSignal）
 * CS-011: server.json 写入时必须设置 0o600 权限
 * CS-012: extensions.ts 路径穿越防护必须防御多重编码
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { configureCLIRoutes, handleTableRoute, handleExtensionsRoute } from '@tabtin/cli-routes'

// ─── CS-009：table/create 字段失败返回 207 ──────────────────
//
// PlatformSurface 重构后，table 路由已迁移到 @tabtin/cli-routes。原本测试用
// `await import('../routes/table-crud')` 直接调内部 sub-module 已不可行
// （cli-routes 只 export 顶层 handleTableRoute）。改成走 handleTableRoute 入口，
// 通过 configureCLIRoutes 注入 mock djangoRequest——这是 cli-routes 设计的
// 标准注入点，与运行时 Electron / Daemon 注入方式完全一致。

describe('CS-009: /table/create 字段失败语义', () => {
  let capturedStatus: number
  let capturedData: any
  const sendJSON = (_res: any, status: number, data: any) => {
    capturedStatus = status
    capturedData = data
  }
  const mockRes = {} as http.ServerResponse

  beforeEach(() => {
    capturedStatus = 0
    capturedData = null
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('字段创建失败时返回 207 + partial:true', async () => {
    const mockDjangoRequest = vi.fn()
      .mockResolvedValueOnce({ status: 200, data: { data: { id: 'tbl_123' } } })
      .mockResolvedValueOnce({ status: 422, data: { error: 'invalid field_type' } })

    configureCLIRoutes({
      djangoRequest: mockDjangoRequest,
      getSpaceId: () => 'sp_1',
    })

    await handleTableRoute(
      '/table/create', 'POST',
      { space_id: 'sp_1', name: 'T', fields: [{ name: 'c1', field_type: 'bad' }] },
      mockRes, sendJSON,
    )

    expect(capturedStatus).toBe(207)
    expect(capturedData.ok).toBe(false)
    expect(capturedData.error.detail.partial).toBe(true)
    expect(capturedData.error.detail.table_id).toBe('tbl_123')
    expect(capturedData.error.code).toBe('VALIDATION_ERROR')
    expect(capturedData.error.detail.fields_error).toEqual({ error: 'invalid field_type' })
  })

  it('字段创建成功时返回 200 + ok:true', async () => {
    const mockDjangoRequest = vi.fn()
      .mockResolvedValueOnce({ status: 200, data: { data: { id: 'tbl_456' } } })
      .mockResolvedValueOnce({ status: 200, data: { data: { fields: [{ name: 'c1' }] } } })
      .mockResolvedValueOnce({ status: 200, data: { data: { tables: [] } } })

    configureCLIRoutes({
      djangoRequest: mockDjangoRequest,
      getSpaceId: () => 'sp_1',
    })

    await handleTableRoute(
      '/table/create', 'POST',
      { space_id: 'sp_1', name: 'T', fields: [{ name: 'c1', field_type: 'text' }] },
      mockRes, sendJSON,
    )

    expect(capturedStatus).toBe(200)
    expect(capturedData.ok).toBe(true)
    expect(capturedData.data.table).toBeDefined()
  })

  it('历史字段 type 形态在建表前被拒绝', async () => {
    const mockDjangoRequest = vi.fn()

    configureCLIRoutes({
      djangoRequest: mockDjangoRequest,
      getSpaceId: () => 'sp_1',
    })

    await handleTableRoute(
      '/table/create', 'POST',
      { space_id: 'sp_1', name: 'T', fields: [{ name: 'c1', type: 'text' }] },
      mockRes, sendJSON,
    )

    expect(capturedStatus).toBe(400)
    expect(capturedData.ok).toBe(false)
    expect(capturedData.error.message).toContain('field_type')
    expect(mockDjangoRequest).not.toHaveBeenCalled()
  })

  it('select 裸 options 数组在建表前被拒绝', async () => {
    const mockDjangoRequest = vi.fn()

    configureCLIRoutes({
      djangoRequest: mockDjangoRequest,
      getSpaceId: () => 'sp_1',
    })

    await handleTableRoute(
      '/table/create', 'POST',
      {
        space_id: 'sp_1',
        name: 'T',
        fields: [{ name: '状态', field_type: 'select', options: ['A', 'B'] }],
      },
      mockRes, sendJSON,
    )

    expect(capturedStatus).toBe(400)
    expect(capturedData.ok).toBe(false)
    expect(capturedData.error.message).toContain('options.choices')
    expect(mockDjangoRequest).not.toHaveBeenCalled()
  })

  it('非选择字段裸 options 数组也在建表前被拒绝', async () => {
    const mockDjangoRequest = vi.fn()

    configureCLIRoutes({
      djangoRequest: mockDjangoRequest,
      getSpaceId: () => 'sp_1',
    })

    await handleTableRoute(
      '/table/create', 'POST',
      {
        space_id: 'sp_1',
        name: 'T',
        fields: [{ name: '评分', field_type: 'number', options: [] }],
      },
      mockRes, sendJSON,
    )

    expect(capturedStatus).toBe(400)
    expect(capturedData.ok).toBe(false)
    expect(capturedData.error.message).toContain('options 必须是对象')
    expect(mockDjangoRequest).not.toHaveBeenCalled()
  })

  it('nested_list 子字段历史 type 形态在建表前被拒绝', async () => {
    const mockDjangoRequest = vi.fn()

    configureCLIRoutes({
      djangoRequest: mockDjangoRequest,
      getSpaceId: () => 'sp_1',
    })

    await handleTableRoute(
      '/table/create', 'POST',
      {
        space_id: 'sp_1',
        name: 'T',
        fields: [{
          name: '明细',
          field_type: 'nested_list',
          options: {
            nested_schema: {
              fields: [{ name: '子项', type: 'text' }],
            },
          },
        }],
      },
      mockRes, sendJSON,
    )

    expect(capturedStatus).toBe(400)
    expect(capturedData.ok).toBe(false)
    expect(capturedData.error.message).toContain('field_type')
    expect(mockDjangoRequest).not.toHaveBeenCalled()
  })
})

// ─── CS-010：refreshAccessToken 超时保护 ────────────────────

describe('CS-010: refreshAccessToken 超时保护', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  // auth.ts 在 macOS Tahoe 兼容修复后已经从 keytar 切换到 Electron safeStorage
  // 包装的 safe-credential-store，原本的 `vi.doMock('keytar', ...)` 完全不生效。
  // 现在 mock 走真实的 credentialStore 接口（getPassword 返回 bundle JSON）。
  const makeAuthBundleMock = () => ({
    getPassword: vi.fn().mockResolvedValue(
      JSON.stringify({
        accessToken: 'old_at',
        refreshToken: 'old_rt',
        userInfo: { id: 1 },
      }),
    ),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
  })

  const baseAuthMocks = () => {
    vi.doMock('../../safe-credential-store', () => ({
      credentialStore: makeAuthBundleMock(),
    }))
    vi.doMock('../../config/api', () => ({
      API_BASE_URL: 'http://localhost:6060/api',
    }))
    vi.doMock('@tabtin/config', () => ({
      joinApiPath: (base: string, p: string) => base + p,
    }))
    vi.doMock('../../logger', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    }))
    vi.doMock('electron', () => ({
      ipcMain: { handle: vi.fn() },
      BrowserWindow: { getAllWindows: () => [] },
      app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => 'test'), isPackaged: false },
      webContents: { getAllWebContents: () => [] },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from(s),
        decryptString: (b: Buffer) => b.toString(),
      },
    }))
    vi.doMock('../../utils/guarded-handle', () => ({ guardedHandle: vi.fn() }))
  }

  it('fetch 被传入了 AbortSignal', async () => {
    let capturedSignal: AbortSignal | undefined

    vi.stubGlobal('fetch', vi.fn((_url: string, opts: any) => {
      capturedSignal = opts?.signal
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: { access_token: 'new_at', refresh_token: 'new_rt' },
        }),
      })
    }))

    baseAuthMocks()

    const { TokenManager } = await import('../../auth')
    await TokenManager.preloadAuthData()

    try {
      await TokenManager.refreshAccessToken()
    } catch {
      // mock 可能不完整，但只关心 signal 是否传递
    }

    expect(capturedSignal).toBeDefined()
    expect(capturedSignal).toBeInstanceOf(AbortSignal)
  })

  it('fetch 超时时抛出可读错误消息', async () => {
    vi.stubGlobal('fetch', vi.fn(() => {
      const err = new DOMException('The operation was aborted', 'AbortError')
      return Promise.reject(err)
    }))

    baseAuthMocks()

    const { TokenManager } = await import('../../auth')
    await TokenManager.preloadAuthData()

    await expect(TokenManager.refreshAccessToken()).rejects.toThrow(/超时/)
  })
})

// ─── CS-011：server.json 权限（源码静态验证）────────────────

describe('CS-011: server.json 文件权限', () => {
  it('CLI server 通过 writeDiscoveryFileDetailed 写入 server/dev discovery 文件', async () => {
    const fs = await import('node:fs')
    const cliServerSource = fs.readFileSync(
      require('node:path').resolve(__dirname, '../cli-server.ts'),
      'utf-8',
    )
    const serverCoreSource = fs.readFileSync(
      require('node:path').resolve(__dirname, '../../../../../../packages/cli-server-core/src/server.ts'),
      'utf-8',
    )

    expect(cliServerSource).toContain("writeDiscoveryFileDetailed('server.json'")
    expect(cliServerSource).toContain("writeDiscoveryFileDetailed('dev-server.json'")

    const modePattern = /writeFileSync\([^)]*mode:\s*0o600/g
    const modeMatches = serverCoreSource.match(modePattern) || []
    expect(modeMatches.length).toBeGreaterThanOrEqual(1)
  })

  it('不使用字符串 encoding-only 参数（第三个参数应为对象）', async () => {
    const fs = await import('node:fs')
    const source = fs.readFileSync(
      require('node:path').resolve(__dirname, '../../../../../../packages/cli-server-core/src/server.ts'),
      'utf-8',
    )

    const dangerousPattern = /writeFileSync\(\s*filePath[^)]*,\s*'utf-8'\s*\)/g
    const dangerousMatches = source.match(dangerousPattern) || []
    expect(dangerousMatches.length).toBe(0)
  })
})

// ─── CS-012：extensions.ts 多重编码路径穿越 ─────────────────

describe('CS-012: extensions 路径穿越防护（纯函数提取）', () => {
  /*
   * 直接测试 fullyDecodeURIComponent + 路径检查逻辑，
   * 不依赖完整模块 import，避免 vitest 模块缓存问题。
   */
  function fullyDecodeURIComponent(str: string): string {
    let prev = str
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const decoded = decodeURIComponent(prev)
        if (decoded === prev) return decoded
        prev = decoded
      } catch {
        return prev
      }
    }
  }

  const path = require('node:path')

  function isPathSafe(pathPart: string): boolean {
    const fullyDecoded = fullyDecodeURIComponent(pathPart)
    if (fullyDecoded.includes('..') || !fullyDecoded.startsWith('/')) {
      return false
    }
    const normalized = path.posix.normalize(fullyDecoded)
    if (normalized.includes('..') || !normalized.startsWith('/')) {
      return false
    }
    return true
  }

  it('正常路径通过', () => {
    expect(isPathSafe('/my-plugin/config')).toBe(true)
    expect(isPathSafe('/cli-commands/')).toBe(true)
  })

  it('单次编码 %2e%2e → .. 被拒绝', () => {
    expect(isPathSafe('/%2e%2e/etc/passwd')).toBe(false)
  })

  it('双重编码 %252e%252e → %2e%2e → .. 被拒绝', () => {
    expect(isPathSafe('/%252e%252e/etc/passwd')).toBe(false)
  })

  it('三重编码 %25252e%25252e 被拒绝', () => {
    expect(isPathSafe('/%25252e%25252e/etc/passwd')).toBe(false)
  })

  it('显式 .. 被拒绝', () => {
    expect(isPathSafe('/../admin')).toBe(false)
    expect(isPathSafe('/foo/../../bar')).toBe(false)
  })

  it('不以 / 开头被拒绝', () => {
    expect(isPathSafe('foo/bar')).toBe(false)
  })

  it('混合编码 %2e%2e%2f 被拒绝', () => {
    expect(isPathSafe('/%2e%2e%2fetc/passwd')).toBe(false)
  })
})

describe('CS-012: extensions 路由集成', () => {
  let capturedStatus: number
  let capturedData: any
  const sendJSON = (_res: any, status: number, data: any) => {
    capturedStatus = status
    capturedData = data
  }
  const mockRes = {} as http.ServerResponse

  beforeEach(() => {
    capturedStatus = 0
    capturedData = null
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // extensions 路由也已迁移到 @tabtin/cli-routes；mock djangoRequest 通过
  // configureCLIRoutes 注入，跟 CS-009 同一模式。
  //
  // 注意：新版 extensions.ts 只对 `/extensions/run/*` 子前缀代理到 Django——
  // 其他路径直接 404 UNKNOWN_ROUTE。所以路径穿越 / 合法路径的集成测试都要
  // 走 `/run/` 前缀；老路径 `/extensions/my-plugin/config` 在新实现下属于
  // 未知路由，跟安全检查无关。
  it('双重编码路径穿越在 /run/ 前缀下被阻止', async () => {
    configureCLIRoutes({
      djangoRequest: vi.fn().mockResolvedValue({ status: 200, data: { ok: true } }),
      getSpaceId: () => null,
    })

    await handleExtensionsRoute(
      '/extensions/run/%252e%252e/admin',
      'GET', undefined, mockRes, sendJSON,
    )
    expect(capturedStatus).toBe(400)
  })

  it('合法的 /run/ 路径正常代理到 Django', async () => {
    const mockDjangoRequest = vi.fn().mockResolvedValue({ status: 200, data: { ok: true } })
    configureCLIRoutes({
      djangoRequest: mockDjangoRequest,
      getSpaceId: () => null,
    })

    await handleExtensionsRoute(
      '/extensions/run/my-plugin/config',
      'GET', undefined, mockRes, sendJSON,
    )
    expect(capturedStatus).toBe(200)
    expect(mockDjangoRequest).toHaveBeenCalledWith(
      'GET',
      '/extensions/run/my-plugin/config',
      undefined,
      expect.any(Object),
    )
  })
})
