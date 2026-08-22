/**
 * IPC-LAZY 错误 envelope 路径测试 — W2-δ 收口。
 *
 * 验证 `ipc-lazy.ts::registerOneStub` 在两类失败时返 envelope 而非 throw：
 *
 * 1. **模块 import 失败 → `errResponse('LOAD_FAILED', ...)`**：mod.load()
 *    返 reject 时，stub 清掉 cache + 返 envelope。renderer 拿到 ok:false
 *    可统一处理（W2-α invokeIpc shim 会把它转成 PlatformIpcError）。
 *
 * 2. **handlers map 缺 channel → `errResponse('HANDLER_NOT_FOUND', ...)`**：
 *    模块 load 成功但 handlers map 不含 channel 名（譬如开发者改 channels
 *    数组时漏改 handlers map），stub 返 envelope。
 *
 * 历史版本（W2-δ 之前）这两种情况是 throw，invoke 端拿到 reject——renderer
 * 端的 invokeIpc shim 没法在统一 envelope 路径处理。改 envelope 后 + W1 D3
 * 的 ALS trace context 自动 stamp trace_id，user 截屏 toast 末 6 位仍可
 * grep 到 ipc-lazy 这条加载/缺 handler 的 main log。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  isTrustedSender: vi.fn(() => true),
  // mod.load() 抛错的 mock — 用 mockRejectedValue 让 import 失败
  failingLoad: vi.fn(),
  // mod.load() 成功但 handlers map 缺 channel
  partialHandlers: {} as Record<string, unknown>,
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
  },
  ipcMain: {
    handle: mocks.handle,
    removeHandler: mocks.removeHandler,
  },
}))

vi.mock('electron-log', () => {
  const noopLogger = {
    transports: { file: { level: false }, console: { level: false } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    scope: vi.fn(() => noopLogger),
  }
  return { default: { ...noopLogger, create: vi.fn(() => noopLogger) } }
})

vi.mock('../auth', () => ({
  isTrustedSender: mocks.isTrustedSender,
}))

// 把 file-system/ipc 改造成"由 mocks.failingLoad 控制 load 行为 + 由
// mocks.partialHandlers 控制 handlers map"。
vi.mock('../file-system/ipc', () => ({
  // 这里返一个 getter，让我们能在测试中改 partialHandlers 状态。
  get fileSystemHandlers() {
    return mocks.partialHandlers
  },
  registerFileSystemIpcHandlers: vi.fn(),
}))

// 其它模块 mock 成空 handlers map（不参与本测试逻辑，只为 import 不崩）
vi.mock('../tabsite/ipc', () => ({ tabsiteHandlers: {} }))
vi.mock('../resource-monitor/ipc', () => ({ resourceMonitorHandlers: {} }))
vi.mock('../browser-env/ipc', () => ({
  browserEnvHandlers: {},
  initBrowserEnvSideEffects: vi.fn(),
}))
vi.mock('../services/LocalMcpService', () => ({ localMcpHandlers: {} }))
vi.mock('../services/ApprovalManager', () => ({
  approvalSyncHandlers: {},
  registerApprovalSyncEventListeners: vi.fn(),
}))
vi.mock('../credential-vault/ipc', () => ({ registerCredentialVaultHandlers: vi.fn() }))
vi.mock('../file-system/protocol', () => ({ registerTabtinFileProtocol: vi.fn() }))

type IpcInvokeListener = (event: unknown, ...args: unknown[]) => unknown

function getStubListener(channel: string): IpcInvokeListener {
  const calls = mocks.handle.mock.calls.filter(c => c[0] === channel)
  if (calls.length === 0) {
    throw new Error(`stub for "${channel}" 未注册`)
  }
  return calls[calls.length - 1][1] as IpcInvokeListener
}

function makeFakeEvent(): unknown {
  return { senderFrame: { url: 'app://main' } }
}

describe('ipc-lazy: W2-δ 错误 envelope 路径', () => {
  let ipcLazy: typeof import('../ipc-lazy')

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.isTrustedSender.mockReturnValue(true)
    mocks.partialHandlers = {} // 默认空 handlers，让 fs:readDir 等触发 HANDLER_NOT_FOUND
    vi.resetModules()
    ipcLazy = await import('../ipc-lazy')
    ipcLazy.__resetDeferredIpcForTesting()
  })

  afterEach(() => {
    delete process.env.TABTIN_EAGER_IPC
  })

  describe('HANDLER_NOT_FOUND envelope', () => {
    it('handlers map 缺 channel → 返 envelope errResponse(HANDLER_NOT_FOUND)', async () => {
      // mocks.partialHandlers 默认是 {}，所有 fs:* channel 都缺 handler
      ipcLazy.registerDeferredIpcStubs()
      const stub = getStubListener('fs:readDir')

      const result = await stub(makeFakeEvent(), '/tmp/test') as any

      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('HANDLER_NOT_FOUND')
      expect(result.error.message).toContain('FileSystemIPC')
      expect(result.error.message).toContain('fs:readDir')
      expect(result.error.detail).toMatchObject({
        module: 'FileSystemIPC',
        channel: 'fs:readDir',
      })
    })

    it('HANDLER_NOT_FOUND envelope 含 per-call trace_id（W1 D3 ALS stamp）', async () => {
      ipcLazy.registerDeferredIpcStubs()
      const stub = getStubListener('fs:readDir')

      const a = await stub(makeFakeEvent(), '/x') as any
      const b = await stub(makeFakeEvent(), '/y') as any

      expect(a.trace_id).toMatch(/^[A-Za-z0-9_-]{12}$/)
      expect(b.trace_id).toMatch(/^[A-Za-z0-9_-]{12}$/)
      expect(a.trace_id).not.toBe(b.trace_id)
    })

    it('handlers map 命中 → 不返 HANDLER_NOT_FOUND（正常流程）', async () => {
      const realHandler = vi.fn(async () => ({ entries: [] }))
      mocks.partialHandlers = { 'fs:readDir': realHandler }

      ipcLazy.registerDeferredIpcStubs()
      const stub = getStubListener('fs:readDir')

      const result = await stub(makeFakeEvent(), '/tmp')
      expect(result).toEqual({ entries: [] })
      expect(realHandler).toHaveBeenCalled()
    })
  })

  describe('LOAD_FAILED envelope', () => {
    // 因为 vi.mock 的 hoisted 顺序问题，让 file-system/ipc mock 直接 throw
    // 比较繁琐——但把 mod.load() 当作 import('./file-system/ipc') 的 promise，
    // ipc-lazy 内部 load: async () => (await import(...)).fileSystemHandlers。
    // 我们让 mock 的 fileSystemHandlers getter 抛错：等价于 await import 后
    // 取属性失败 → 进 stub catch 分支。

    it('mod.load() 抛错 → 返 envelope errResponse(LOAD_FAILED)', async () => {
      // 让 fileSystemHandlers getter 抛错
      Object.defineProperty(mocks, 'partialHandlers', {
        get() {
          throw new Error('mock load failure: pretend disk full')
        },
        configurable: true,
      })

      // 重新 import ipc-lazy 让 mock 生效
      vi.resetModules()
      ipcLazy = await import('../ipc-lazy')
      ipcLazy.__resetDeferredIpcForTesting()
      ipcLazy.registerDeferredIpcStubs()
      const stub = getStubListener('fs:readDir')

      const result = await stub(makeFakeEvent(), '/tmp/test') as any

      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('LOAD_FAILED')
      expect(result.error.message).toContain('FileSystemIPC')
      expect(result.error.detail).toMatchObject({
        module: 'FileSystemIPC',
        channel: 'fs:readDir',
        error_message: expect.stringContaining('mock load failure'),
      })
      expect(result).toHaveProperty('trace_id')
      expect(typeof result.trace_id).toBe('string')

      // 重新装回 mocks.partialHandlers 以避免污染下一组测试
      Object.defineProperty(mocks, 'partialHandlers', {
        value: {},
        writable: true,
        configurable: true,
      })
    })
  })
})
