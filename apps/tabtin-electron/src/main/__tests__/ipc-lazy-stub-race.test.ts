/**
 * IPC-LAZY-STUB 回归测试
 *
 * 验证 ipc-lazy.ts 的核心契约：
 *
 * 1. **Stub 永远存在**：registerDeferredIpcStubs() 调用后，所有 deferred
 *    channel 都已通过 ipcMain.handle 同步注册。
 *
 * 2. **零竞态**：即使在模块加载完成前调用 stub，调用方仍然能拿到结果
 *    （而不是 "No handler registered" 错误），最坏情况只是首次调用慢
 *    几十毫秒。
 *
 * 3. **同模块共享 load promise**：同一个模块的多个 channel 第一次被
 *    并发调用时，模块只 import 一次。
 *
 * 4. **Sender 校验**：非 trusted sender 被拒绝，与 guardedHandle 行为
 *    一致。
 *
 * 5. **加载失败可重试**：模块 import 失败后 cache 被清掉，下一次调用
 *    重新尝试 import。
 *
 * 6. **EAGER 模式**：TABTIN_EAGER_IPC=1 时所有模块同步加载完成。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mock infrastructure ───────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  isTrustedSender: vi.fn(() => true),

  // 给 file-system/ipc 的 mock 留个测试用的 handler 实现
  fsReadDirImpl: vi.fn(async (_event: unknown, dirPath: string) => ({
    success: true,
    entries: [{ name: 'mock.txt', path: dirPath + '/mock.txt' }],
  })),
  fsWriteFileImpl: vi.fn(async (_event: unknown, _filePath: string, _content: string) => ({
    success: true,
  })),
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
    transports: {
      file: { level: false, fileName: '' },
      console: { level: false, format: '' },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    scope: vi.fn(() => noopLogger),
  }
  return {
    default: {
      ...noopLogger,
      create: vi.fn(() => noopLogger),
    },
  }
})

vi.mock('../auth', () => ({
  isTrustedSender: mocks.isTrustedSender,
}))

// 关键：把 file-system/ipc 模块替换为一个轻量 mock，避免拉入真模块
// 那一堆重依赖（@vscode/ripgrep、security-policy 等）。
vi.mock('../file-system/ipc', () => {
  return {
    fileSystemHandlers: {
      'fs:readDir': mocks.fsReadDirImpl,
      'fs:writeFile': mocks.fsWriteFileImpl,
      'fs:readFilePreview': vi.fn(async () => ({ success: true })),
      'fs:ensureSpaceSandbox': vi.fn(async () => ({ success: true })),
      'fs:watch': vi.fn(async () => ({ success: true })),
      'fs:unwatch': vi.fn(async () => ({ success: true })),
      'fs:readBinaryFile': vi.fn(async () => ({ success: true })),
      'fs:writeBinaryFile': vi.fn(async () => ({ success: true })),
      'fs:createDir': vi.fn(async () => ({ success: true })),
      'fs:rename': vi.fn(async () => ({ success: true })),
      'fs:deleteDir': vi.fn(async () => ({ success: true })),
      'fs:deleteFile': vi.fn(async () => ({ success: true })),
      'fs:ripgrepSearch': vi.fn(async () => ({ success: true, results: [] })),
      'fs:ripgrepSearchCancel': vi.fn(async () => ({ success: true, canceled: false })),
      'fs:replaceInFiles': vi.fn(async () => ({ success: true, files: [], totalReplacements: 0 })),
      'fs:computeSkillContentHash': vi.fn(async () => ({ success: true, hash: 'mock' })),
      'shell:openPath': vi.fn(async () => ({ success: true })),
      'shell:openExternal': vi.fn(async () => ({ success: true })),
      'shell:showItemInFolder': vi.fn(async () => ({ success: true })),
    },
    registerFileSystemIpcHandlers: vi.fn(),
    unregisterFileSystemIpcHandlers: vi.fn(),
  }
})

// Mock 其他已迁移模块（每个都需要导出 handlers map + register 函数）
vi.mock('../tabsite/ipc', () => ({
  tabsiteHandlers: {
    'tabsite:initTemplate': vi.fn(async () => ({ success: true })),
    'tabsite:startDevServer': vi.fn(async () => ({ success: true })),
    'tabsite:stopDevServer': vi.fn(async () => ({ stopped: true })),
    'tabsite:getDevServerStatus': vi.fn(async () => ({ running: false })),
  },
  registerTabsiteIpcHandlers: vi.fn(),
}))
vi.mock('../resource-monitor/ipc', () => ({
  resourceMonitorHandlers: {
    'resource-monitor:getSnapshot': vi.fn(async () => ({})),
  },
  registerResourceMonitorIpcHandlers: vi.fn(),
}))
vi.mock('../browser-env/ipc', () => ({
  browserEnvHandlers: {
    'browser-env:list': vi.fn(async () => ({ success: true })),
    'browser-env:create': vi.fn(async () => ({ success: true })),
    'browser-env:rename': vi.fn(async () => ({ success: true })),
    'browser-env:delete': vi.fn(async () => ({ success: true })),
    'browser-env:bind-space': vi.fn(async () => ({ success: true })),
    'browser-env:get-partition': vi.fn(async () => 'persist:default'),
    'browser-env:get-environment-for-space': vi.fn(async () => ({ partition: 'persist:default', environment: null, is_explicit: null })),
  },
  initBrowserEnvSideEffects: vi.fn(),
  registerBrowserEnvHandlers: vi.fn(),
}))
vi.mock('../services/LocalMcpService', () => ({
  localMcpHandlers: {
    'localMcp:discover': vi.fn(),
    'localMcp:listConnections': vi.fn(),
    'localMcp:getConnectionDetail': vi.fn(),
    'localMcp:shareConnectionToOrganization': vi.fn(),
    'localMcp:importCandidate': vi.fn(),
    'localMcp:saveManualConnection': vi.fn(),
    'localMcp:upsertOrganizationMirror': vi.fn(),
    'localMcp:attachConnection': vi.fn(),
    'localMcp:setConnectionEnabled': vi.fn(),
    'localMcp:deleteConnection': vi.fn(),
    'localMcp:probeConnection': vi.fn(),
    'localMcp:cancelProbe': vi.fn(),
    'localMcp:waitForPlatformOAuthTicket': vi.fn(),
    'localMcp:closePlatformOAuthWindow': vi.fn(),
  },
  registerLocalMcpIPC: vi.fn(),
}))
vi.mock('../services/ApprovalManager', () => ({
  approvalSyncHandlers: {
    'sandbox:sync-approval-preferences': vi.fn(async () => ({ sessionCount: 0, persistedCount: 0 })),
  },
  registerApprovalSyncHandlers: vi.fn(),
  registerApprovalSyncEventListeners: vi.fn(),
}))

// LEGACY 模块只有 register 函数（CredentialVaultIPC 待 P2 迁移；
// ApprovalSyncEventIPC 走 ApprovalManager 模块的 register 函数，
// 已在上面 services/ApprovalManager mock 里覆盖）
vi.mock('../credential-vault/ipc', () => ({ registerCredentialVaultHandlers: vi.fn() }))
// TabtinFileProtocol 已迁到 startup-services.registerCoreProcessHandlers
// 同步注册，不再走 ipc-lazy。保留 mock 防御 import 副作用。
vi.mock('../file-system/protocol', () => ({ registerTabtinFileProtocol: vi.fn() }))

// ── 工具函数 ───────────────────────────────────────────────────────────────

type IpcInvokeListener = (event: unknown, ...args: unknown[]) => unknown

function getStubListener(channel: string): IpcInvokeListener {
  // 找到最后一次对该 channel 的 handle 调用——后注册的 listener 覆盖前面的
  const calls = mocks.handle.mock.calls.filter(c => c[0] === channel)
  if (calls.length === 0) {
    throw new Error(`stub for "${channel}" 未注册`)
  }
  return calls[calls.length - 1][1] as IpcInvokeListener
}

function makeFakeEvent(): unknown {
  return { senderFrame: { url: 'app://main' } }
}

// ── 测试 ──────────────────────────────────────────────────────────────────

describe('ipc-lazy: Stub 永驻 + 模块按需加载', () => {
  let ipcLazy: typeof import('../ipc-lazy')

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.isTrustedSender.mockReturnValue(true)
    // 重置 module，让 ipc-lazy 内部的状态（stubsRegistered、moduleHandlersCache）干净
    vi.resetModules()
    delete process.env.TABTIN_EAGER_IPC
    ipcLazy = await import('../ipc-lazy')
    ipcLazy.__resetDeferredIpcForTesting()
  })

  afterEach(() => {
    delete process.env.TABTIN_EAGER_IPC
  })

  describe('registerDeferredIpcStubs', () => {
    it('同步为所有 deferred channel 注册 ipcMain.handle stub', () => {
      ipcLazy.registerDeferredIpcStubs()

      const registered = ipcLazy.__getRegisteredStubChannelsForTesting()
      // FileSystemIPC 17 个 channel
      expect(registered).toContain('fs:readDir')
      expect(registered).toContain('fs:watch')
      expect(registered).toContain('fs:unwatch')
      expect(registered).toContain('shell:openPath')
      expect(registered.length).toBeGreaterThanOrEqual(17)

      // 每个 channel 都已 ipcMain.handle
      for (const channel of registered) {
        const handled = mocks.handle.mock.calls.some(c => c[0] === channel)
        expect(handled, `channel "${channel}" 未注册到 ipcMain`).toBe(true)
      }
    })

    it('幂等：重复调用不会重复注册（避免 Electron "second handler" 报错）', () => {
      ipcLazy.registerDeferredIpcStubs()
      const firstCount = mocks.handle.mock.calls.length

      ipcLazy.registerDeferredIpcStubs()
      const secondCount = mocks.handle.mock.calls.length

      expect(secondCount).toBe(firstCount)
    })

    it('注册时不应触发模块加载（懒加载契约）', () => {
      ipcLazy.registerDeferredIpcStubs()
      expect(ipcLazy.__getLoadedModuleNamesForTesting()).toEqual([])
    })
  })

  describe('Stub 调用行为', () => {
    it('第一次调用 stub 触发模块加载 + 转发到真 handler', async () => {
      ipcLazy.registerDeferredIpcStubs()
      expect(ipcLazy.__getLoadedModuleNamesForTesting()).toEqual([])

      const stub = getStubListener('fs:readDir')
      const result = await stub(makeFakeEvent(), '/tmp/test')

      expect(ipcLazy.__getLoadedModuleNamesForTesting()).toContain('FileSystemIPC')
      expect(mocks.fsReadDirImpl).toHaveBeenCalledWith(expect.anything(), '/tmp/test')
      expect(result).toEqual({
        success: true,
        entries: [{ name: 'mock.txt', path: '/tmp/test/mock.txt' }],
      })
    })

    it('同模块多 channel 并发调用时，cache 只创建一次（共享 load promise）', async () => {
      ipcLazy.registerDeferredIpcStubs()
      const stubReadDir = getStubListener('fs:readDir')
      const stubWriteFile = getStubListener('fs:writeFile')

      await Promise.all([
        stubReadDir(makeFakeEvent(), '/a'),
        stubWriteFile(makeFakeEvent(), '/b', 'content'),
        stubReadDir(makeFakeEvent(), '/c'),
      ])

      // 即使三次并发调用了两个不同 channel，cache 里只有一个 module entry
      expect(ipcLazy.__getLoadedModuleNamesForTesting()).toEqual(['FileSystemIPC'])
      expect(mocks.fsReadDirImpl).toHaveBeenCalledTimes(2)
      expect(mocks.fsWriteFileImpl).toHaveBeenCalledTimes(1)
    })

    it('非 trusted sender 被拒绝（与 guardedHandle 行为一致 — Wave 0 envelope shape）', async () => {
      mocks.isTrustedSender.mockReturnValue(false)
      ipcLazy.registerDeferredIpcStubs()
      const stub = getStubListener('fs:readDir')

      const result = await stub(makeFakeEvent(), '/tmp/test')

      // Wave 0 + W1 D3: stub 共用 utils/guarded-handle.ts 的
      // buildUnauthorizedReject 工厂，envelope 形状 ↔ guardedHandle，
      // 每次调用 stamp per-call trace_id。
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
      })
      // 真 handler **不应**被调用
      expect(mocks.fsReadDirImpl).not.toHaveBeenCalled()
    })

    it('handler 抛错时透传给调用方', async () => {
      mocks.fsReadDirImpl.mockRejectedValueOnce(new Error('disk full'))
      ipcLazy.registerDeferredIpcStubs()
      const stub = getStubListener('fs:readDir')

      await expect(stub(makeFakeEvent(), '/tmp')).rejects.toThrow('disk full')
    })

    it("senderPolicy='skip' 模块允许非 trusted sender（如 sandbox:sync-approval-preferences）", async () => {
      mocks.isTrustedSender.mockReturnValue(false)
      ipcLazy.registerDeferredIpcStubs()
      const stub = getStubListener('sandbox:sync-approval-preferences')

      // 即使 sender 不可信，stub 也会走真 handler（不返回 Unauthorized）
      const result = await stub(makeFakeEvent())
      expect(result).toEqual({ sessionCount: 0, persistedCount: 0 })
    })

    it('Wave 1 D3：sender 校验失败时 reject envelope 含 per-call trace_id', async () => {
      mocks.isTrustedSender.mockReturnValue(false)
      ipcLazy.registerDeferredIpcStubs()
      const stub = getStubListener('fs:readDir')

      const a = await stub(makeFakeEvent(), '/x') as any
      const b = await stub(makeFakeEvent(), '/y') as any

      expect(a.ok).toBe(false)
      expect(b.ok).toBe(false)
      expect(a.trace_id).toMatch(/^[A-Za-z0-9_-]{12}$/)
      expect(b.trace_id).toMatch(/^[A-Za-z0-9_-]{12}$/)
      expect(a.trace_id).not.toBe(b.trace_id) // per-call generate
    })

    it('Wave 1 D3：handler 返 envelope 形态时自动 stamp trace_id', async () => {
      // 让 fsReadDirImpl 返回 envelope 形态（ok 字段）
      mocks.fsReadDirImpl.mockResolvedValueOnce({
        ok: true,
        data: { entries: [] },
      } as any)
      ipcLazy.registerDeferredIpcStubs()
      const stub = getStubListener('fs:readDir')

      const result = await stub(makeFakeEvent(), '/tmp') as any

      expect(result.ok).toBe(true)
      expect(result.trace_id).toMatch(/^[A-Za-z0-9_-]{12}$/)
    })
  })

  describe('registerDeferredIpcHandlers (legacy + 预热)', () => {
    it('未先调用 stub 注册时，会兜底自动注册（warn）', async () => {
      // 注意：不调用 registerDeferredIpcStubs
      await ipcLazy.registerDeferredIpcHandlers()

      const registered = ipcLazy.__getRegisteredStubChannelsForTesting()
      expect(registered).toContain('fs:readDir')
    })

    it('幂等：多次调用不会重复触发 legacy register', async () => {
      // 用 CredentialVault 验证——它仍在 LEGACY 路径
      const credentialMod = await import('../credential-vault/ipc')
      const spy = credentialMod.registerCredentialVaultHandlers as ReturnType<typeof vi.fn>

      ipcLazy.registerDeferredIpcStubs()
      await ipcLazy.registerDeferredIpcHandlers()
      await ipcLazy.registerDeferredIpcHandlers()

      expect(spy).toHaveBeenCalledTimes(1)
    })
  })

  describe('EAGER 模式', () => {
    it('TABTIN_EAGER_IPC=1 时同步加载所有模块', async () => {
      process.env.TABTIN_EAGER_IPC = '1'
      vi.resetModules()
      const eagerMod = await import('../ipc-lazy')
      eagerMod.__resetDeferredIpcForTesting()

      eagerMod.registerDeferredIpcStubs()
      expect(eagerMod.__getLoadedModuleNamesForTesting()).toEqual([]) // 注册阶段不触发加载

      await eagerMod.registerDeferredIpcHandlers()

      // EAGER 模式下，registerDeferredIpcHandlers 返回时所有 deferred 模块已加载
      expect(eagerMod.__getLoadedModuleNamesForTesting()).toContain('FileSystemIPC')
    })
  })
})
