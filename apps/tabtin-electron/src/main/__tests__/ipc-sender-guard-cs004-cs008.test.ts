/**
 * 回归测试 CS-004 ~ CS-008
 *
 * 验证 run-session、tins、tin-bridge 模块的 IPC handler
 * 在收到非信任来源调用时返回 Unauthorized 错误。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── 收集 ipcMain.handle 注册的 handler ──────────────
type IpcHandler = (event: any, ...args: any[]) => any

const handlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  webContents: { fromId: vi.fn() },
  app: { getPath: () => '/tmp/mock' },
}))

vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

let mockIsTrusted = true

vi.mock('../auth', () => ({
  isTrustedSender: vi.fn(() => mockIsTrusted),
  isTinSandboxSender: vi.fn(() => false),
}))

vi.mock('../run-session/RunSessionManager', () => ({
  getRunSessionManager: () => ({
    createRun: vi.fn(() => ({ runId: 'r1', sessionId: 's1', profile: null })),
    getRun: vi.fn(() => null),
    addObservation: vi.fn(),
    checkQuotaForNewView: vi.fn(() => ({ allowed: true })),
    registerViewLocked: vi.fn().mockResolvedValue(undefined),
    setActiveView: vi.fn(),
    endRun: vi.fn(),
    openTab: vi.fn(async () => ({ success: true })),
    switchTab: vi.fn(async () => ({ success: true })),
    closeTab: vi.fn(async () => ({ success: true })),
  }),
}))

vi.mock('../tins/activation-matcher', () => ({
  matchActivationRules: vi.fn(() => false),
}))

vi.mock('../tins/tin-sandbox', () => ({
  prepareSandbox: vi.fn(() => null),
  cleanupSandbox: vi.fn(),
}))

vi.mock('../tins/types', () => ({
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  hasPermissionForApi: vi.fn(() => ({ allowed: true, missing: [] })),
}))

vi.mock('../tins/tin-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tins/tin-manager')>()
  return {
    ...actual,
    getTinManager: vi.fn(() => ({
      isDisposed: () => false,
      findInstance: () => ({
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        tin_id: 't1',
        organization_id: 'ws1',
        is_enabled: true,
        tin: { name: 'test', status: 'active', permissions: ['page:read'] },
      }),
      getPageContext: () => ({ url: 'https://example.com', title: 'Test' }),
      resolveVariables: () => ({}),
      emitToRenderer: vi.fn(),
      emitToTinWebview: vi.fn(),
    })),
  }
})

function makeTrustedEvent() {
  return { senderFrame: { url: 'file:///app/index.html' }, sender: { id: 1 } }
}

function makeUntrustedEvent() {
  return { senderFrame: { url: 'https://evil.example.com/attack.html' }, sender: { id: 999 } }
}

// ── run-session 测试 ──────────────────────────────

describe('CS-004/CS-005: run-session IPC senderFrame guard', () => {
  beforeEach(async () => {
    handlers.clear()
    mockIsTrusted = true
    const mod = await import('../run-session/ipc')
    mod.registerRunSessionIpcHandlers()
  })

  afterEach(async () => {
    const mod = await import('../run-session/ipc')
    mod.unregisterRunSessionIpcHandlers()
  })

  const guardedChannels = [
    'run-session:create',
    'run-session:registerView',
    'run-session:setActiveView',
    'run-session:endRun',
    'run-session:openTab',
    'run-session:switchTab',
    'run-session:closeTab',
    'run-session:addEvent',
  ]

  for (const channel of guardedChannels) {
    it(`${channel} — 拒绝非信任来源`, async () => {
      mockIsTrusted = false
      const handler = handlers.get(channel)
      expect(handler, `handler for ${channel} should be registered`).toBeDefined()

      const result = await handler!(makeUntrustedEvent())
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
      })
    })

    it(`${channel} — 允许信任来源`, async () => {
      mockIsTrusted = true
      const handler = handlers.get(channel)
      expect(handler, `handler for ${channel} should be registered`).toBeDefined()

      const result = await handler!(makeTrustedEvent(), ...(channel === 'run-session:addEvent'
        ? [{ type: 'test-event' }]
        : channel === 'run-session:registerView'
          ? ['run-id', { viewId: 'v1' }]
          : channel === 'run-session:setActiveView'
            ? ['run-id', 'v1']
            : channel === 'run-session:endRun'
              ? ['run-id']
              : []))

      expect(result).not.toMatchObject({ error: expect.stringContaining('Unauthorized') })
    })
  }

  const readOnlyChannels = [
    'run-session:get',
  ]

  for (const channel of readOnlyChannels) {
    it(`${channel} — 只读查询不需要 guard`, () => {
      const handler = handlers.get(channel)
      expect(handler, `handler for ${channel} should be registered`).toBeDefined()
    })
  }
})

// ── tins 测试 ──────────────────────────────────────

describe('CS-006/CS-007: tins IPC senderFrame guard', () => {
  beforeEach(async () => {
    handlers.clear()
    mockIsTrusted = true

    // TinManager 构造函数中调用 registerIpcHandlers，
    // 需要新建实例来触发注册
    vi.resetModules()
  })

  it('tins:sync-page-context — 拒绝非信任来源', async () => {
    // 重新导入以触发构造
    handlers.clear()
    const { TinManager } = await import('../tins/tin-manager')
    new TinManager()

    mockIsTrusted = false
    const handler = handlers.get('tins:sync-page-context')
    expect(handler).toBeDefined()

    const result = await handler!(makeUntrustedEvent(), { url: 'https://evil.com', title: 'Evil' })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
    })
  })

  it('tins:register-webview — 拒绝非信任来源', async () => {
    handlers.clear()
    const { TinManager } = await import('../tins/tin-manager')
    new TinManager()

    mockIsTrusted = false
    const handler = handlers.get('tins:register-webview')
    expect(handler).toBeDefined()

    const result = await handler!(makeUntrustedEvent(), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 42)
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
    })
  })

  it('tins:sync-page-context — 允许信任来源', async () => {
    handlers.clear()
    const { TinManager } = await import('../tins/tin-manager')
    new TinManager()

    mockIsTrusted = true
    const handler = handlers.get('tins:sync-page-context')
    expect(handler).toBeDefined()

    const result = await handler!(makeTrustedEvent(), { url: 'https://example.com', title: 'Hi' })
    expect(result).not.toMatchObject({ error: expect.stringContaining('Unauthorized') })
  })

  it('tins:register-webview — 允许信任来源', async () => {
    handlers.clear()
    const { TinManager } = await import('../tins/tin-manager')
    new TinManager()

    mockIsTrusted = true
    const handler = handlers.get('tins:register-webview')
    expect(handler).toBeDefined()

    const result = await handler!(makeTrustedEvent(), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 42)
    expect(result).not.toMatchObject({ error: expect.stringContaining('Unauthorized') })
  })
})

// ── tin-bridge 测试 ──────────────────────────────────
//
// Wave 2 W2-δ 改造后：
//   - 注册路径用 `guardedHandleAllowingTinSandbox`（utils/guarded-handle.ts），
//     sender guard 失败返 envelope `{ ok:false, error:{ code:'UNAUTHORIZED', ... } }`
//   - handleBridgeMessage 内部全部返 envelope（`okResponse(...)` /
//     `errResponse(code, ...)`），不再有 legacy `{id, success, data?, error?}` 形态
//   - sandbox 端 `bridgeRequest()`（generateTinPreloadScript 内）解 envelope，
//     成功返 `envelope.data`，失败 throw — sandbox 第三方代码用 try/catch

describe('CS-008: tin-bridge:request senderFrame guard', () => {
  beforeEach(async () => {
    handlers.clear()
    mockIsTrusted = true

    const mod = await import('../tins/tin-bridge')
    mod.initTinBridge({
      getPageContent: vi.fn(async () => 'content'),
      getPageSelection: vi.fn(async () => ''),
      invokeAgent: vi.fn(async () => 'reply'),
    })
  })

  afterEach(async () => {
    const mod = await import('../tins/tin-bridge')
    mod.disposeTinBridge()
  })

  it('tin-bridge:request — 拒绝非信任来源（envelope 形态 + trace_id）', async () => {
    mockIsTrusted = false
    const handler = handlers.get('tin-bridge:request')
    expect(handler).toBeDefined()

    const result = await handler!(
      makeUntrustedEvent(),
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      { type: 'getPageUrl' }
    )
    // W2-δ 后：tin-bridge:request 走 `guardedHandleAllowingTinSandbox` —
    // 拒绝路径返 envelope `{ ok:false, error:{ code:'UNAUTHORIZED', ... }, trace_id }`，
    // 跟 W0/W1 主线 `guardedHandle` 一致，不再独立写 legacy `{success, error: string}`。
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
    })
    expect(result).toHaveProperty('trace_id')
    expect(typeof result.trace_id).toBe('string')
  })

  it('tin-bridge:request — 允许信任来源（envelope 形态成功路径）', async () => {
    mockIsTrusted = true
    const handler = handlers.get('tin-bridge:request')
    expect(handler).toBeDefined()

    const result = await handler!(
      makeTrustedEvent(),
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      { type: 'getPageUrl' }
    )
    expect(result.ok).toBe(true)
    expect(result.data).toBe('https://example.com')
    expect(result).toHaveProperty('trace_id')
  })

  it('tin-bridge:request — VALIDATION_ERROR 路径（非 UUID instanceId）', async () => {
    mockIsTrusted = true
    const handler = handlers.get('tin-bridge:request')
    expect(handler).toBeDefined()

    const result = await handler!(
      makeTrustedEvent(),
      'not-a-uuid', // 触发 VALIDATION_ERROR 分支
      { type: 'getPageUrl' }
    )
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
    expect(result.error.message).toContain('Invalid instanceId')
    expect(result.error.detail).toMatchObject({
      instance_id: 'not-a-uuid',
      message_type: 'getPageUrl',
    })
  })
})
