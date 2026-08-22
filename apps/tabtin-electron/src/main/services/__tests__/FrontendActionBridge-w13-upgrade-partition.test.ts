/**
 * FrontendActionBridge · W1.3 修复：tabtin:upgrade partition 复用守护测试。
 *
 * 调研报告 A2-H2 / 总控 §五 W1.3：
 *   历史上 access-strategy-upgrade 流程使用 `tabtin:upgrade:${Date.now()}` 作为
 *   partition 名，每次触发都会在 `userData/Partitions/` 下新建一个永远不被清理
 *   的目录——重度用户磁盘上能积累几百上千个孤儿 partition（GB 级）。
 *
 * 本测试守住三条不变量：
 *   1. `UPGRADE_TRANSIENT_PARTITION` 是稳定字符串，不含 `Date.now()` / 时间戳片段。
 *   2. 形如 `'persist:tabtin:upgrade:transient'` 的最终 partition 命名稳定。
 *   3. `clearUpgradeTransientPartition()` 调用 `session.fromPartition` 命中
 *      `persist:tabtin:upgrade:transient`，并执行 `clearStorageData()`。
 *
 * 这是 W1.3 三个修复中最简单的一个——核心改动是把 partition 字符串从动态
 * 时间戳换成稳定常量，配合启动期清理。无需走完整的 access-strategy-upgrade
 * 链路，能把"时间戳被替换"和"启动清理被调用"这两点钉死即可。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── electron 必须在 import FrontendActionBridge 之前 mock，避免模块初始化
//    时调用真实 `electron.session` ──────────────────────────────────────────
const { mockClearStorageData, mockFromPartition } = vi.hoisted(() => ({
  mockClearStorageData: vi.fn().mockResolvedValue(undefined),
  mockFromPartition: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp') },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  session: {
    fromPartition: mockFromPartition.mockImplementation(() => ({
      clearStorageData: mockClearStorageData,
    })),
  },
}))

// 下游依赖统一 stub 掉，让模块加载顺利完成（与 v1f2 测试套件思路一致）。
vi.mock('@tabtin/action-tools/adapters', () => ({
  ActionExecutorAdapter: class {
    getRegisteredTools = vi.fn().mockReturnValue([])
    hasToolForAction = vi.fn().mockReturnValue(false)
    executeAction = vi.fn().mockResolvedValue({ success: true })
  },
}))

vi.mock('@tabtin/action-tools/impl', () => ({
  getSharedBrowserToolImpl: vi
    .fn()
    .mockReturnValue({ destroy: vi.fn().mockResolvedValue(undefined) }),
}))

vi.mock('@tabtin/action-tools/headless', () => ({
  validateProjectPath: vi.fn(),
  // Wave 1.5（2026-05-13）：FileLockManager / resolveFileLockPath 已废弃删除——
  // 锁实现下沉为 withFileLock 函数 API + ActionExecutorAdapter 统一加锁。
}))

vi.mock('@tabtin/terminal-core', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/terminal-core')>(
    '@tabtin/terminal-core',
  )
  return {
    ...actual,
    getInteractiveTerminalPolicySupportError: vi.fn().mockReturnValue(null),
    normalizeTerminalExecutionPolicy: vi.fn().mockReturnValue({}),
    evaluateLocalFilePolicy: vi.fn().mockReturnValue({ blocked: false }),
    evaluateLocalTerminalPolicy: vi.fn().mockReturnValue({ blocked: false }),
    isAutoApprovedTerminalWrite: vi.fn().mockReturnValue(true),
    containsCommandSubstitution: vi.fn().mockReturnValue(false),
    evaluateTerminalPolicyDegradation: vi.fn().mockReturnValue(null),
    executeDegraded: vi.fn(),
    resolveSpacesRoot: vi.fn().mockReturnValue('/home/user'),
  }
})

vi.mock('@tabtin/security-policy', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/security-policy')>(
    '@tabtin/security-policy',
  )
  return {
    ...actual,
    PolicyEvaluator: { evaluate: vi.fn().mockReturnValue({ action: 'allow' }) },
    parseSecurityPolicy: vi.fn().mockReturnValue({}),
    CHECKPOINT_MUTATING_ACTIONS: new Set(),
  }
})

vi.mock('../ApprovalManager', () => ({ requestApproval: vi.fn() }))
vi.mock('../CDPNetworkBridge', () => ({ enableForTab: vi.fn() }))
vi.mock('../../cli/cli-server', () => ({
  getCLISpaceId: vi.fn().mockReturnValue(undefined),
  getCLICrawlspaceId: vi.fn().mockReturnValue(undefined),
  getCLIOrganizationRoot: vi.fn().mockReturnValue('/home/user/project'),
}))
vi.mock('../../embedded-crawl-view', () => ({ getView: vi.fn() }))
vi.mock('../../view-factory', () => ({
  getViewFactory: vi.fn().mockReturnValue({ getWebContents: vi.fn().mockReturnValue(null) }),
}))
vi.mock('../../run-session/RunSessionManager', () => ({
  getRunSessionManager: vi.fn().mockReturnValue({
    createRun: vi.fn(),
    getRun: vi.fn(),
    openTab: vi.fn(),
    setActiveView: vi.fn(),
  }),
}))
vi.mock('../../crawlspace/CrawlspaceContextHub', () => ({
  getCrawlspaceContextHub: vi
    .fn()
    .mockReturnValue({ getAllSnapshots: vi.fn().mockReturnValue([]) }),
}))
vi.mock('../../browser-env/BrowserEnvironmentService', () => ({
  getBrowserEnvironmentService: vi.fn().mockReturnValue({
    getPartitionForSpace: vi.fn(),
  }),
}))
vi.mock('../StreamDownloadService', () => ({
  getStreamDownloadService: vi
    .fn()
    .mockReturnValue({ on: vi.fn(), removeListener: vi.fn() }),
}))
vi.mock('../LocalMcpService', () => ({
  getLocalMcpService: vi
    .fn()
    .mockReturnValue({ dispose: vi.fn().mockResolvedValue(undefined) }),
}))
vi.mock('../../logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))
vi.mock('../tool-registry', () => ({ registerAllTools: vi.fn() }))
vi.mock('../bridge-core', () => ({
  setupCoreAPIs: vi.fn().mockReturnValue({ contextSpaceBridge: null }),
}))
vi.mock('../resource-actions', () => ({ setupResourceDetectionAPI: vi.fn() }))
vi.mock('../cdp-actions', () => ({ setupAllCDPActions: vi.fn() }))
vi.mock('../../cli/routes/shared/error-handler', () => ({
  resolveOrganizationIdFromUserInfo: vi.fn().mockReturnValue(''),
}))
vi.mock('../../checkpoint/CheckpointService', () => ({
  getCheckpointService: vi.fn(),
}))
// 路径权限治理 Wave 2：updateSpaceDenyPaths / updateGitSpaceDenyPaths 是
// O8 死代码，已删除。但保留这两条 mock 是为了让 vi.mock 替换整个 module
// 时不至于因 import 失败引发 pre-existing FrontendActionBridge 测试套件的
// "electron mock 缺 app" 错误（该错误来自 ElectronWsGateway 链路，与本
// wave 无关）。stub 形态对生产代码无影响（O8 已无 caller）。
vi.mock('../../file-system/ipc', () => ({}))
vi.mock('../../git-ipc', () => ({}))

import {
  UPGRADE_TRANSIENT_PARTITION,
  clearUpgradeTransientPartition,
  kickoffUpgradePartitionStartupClear,
  awaitUpgradePartitionStartupClear,
  acquireUpgradeRefcount,
  __resetUpgradePartitionStartupClearForTest,
  __resetUpgradeRefcountForTest,
  __getUpgradeRefcountForTest,
} from '../FrontendActionBridge'

describe('W1.3 / A2-H2 · upgrade partition 复用守护', () => {
  beforeEach(() => {
    mockClearStorageData.mockClear()
    mockFromPartition.mockClear()
    __resetUpgradePartitionStartupClearForTest()
  })

  it('UPGRADE_TRANSIENT_PARTITION 是稳定字符串，不含时间戳 / Date.now() / 随机片段', () => {
    expect(UPGRADE_TRANSIENT_PARTITION).toBe('tabtin:upgrade:transient')
    // 反向防回归：禁止意外引入时间片段
    expect(UPGRADE_TRANSIENT_PARTITION).not.toMatch(/\d{10,}/)
    expect(UPGRADE_TRANSIENT_PARTITION).not.toMatch(/random|uuid/i)
  })

  it('clearUpgradeTransientPartition 命中 persist:tabtin:upgrade:transient 并 clearStorageData', async () => {
    await clearUpgradeTransientPartition()
    expect(mockFromPartition).toHaveBeenCalledTimes(1)
    expect(mockFromPartition).toHaveBeenCalledWith(
      `persist:${UPGRADE_TRANSIENT_PARTITION}`,
    )
    expect(mockClearStorageData).toHaveBeenCalledTimes(1)
  })

  it('clearUpgradeTransientPartition 在 clearStorageData 失败时不抛（best-effort）', async () => {
    mockClearStorageData.mockRejectedValueOnce(new Error('Session not ready'))
    await expect(clearUpgradeTransientPartition()).resolves.toBeUndefined()
  })

  it('多次调用 clearUpgradeTransientPartition 是幂等的（每次都命中同一个 partition）', async () => {
    await clearUpgradeTransientPartition()
    await clearUpgradeTransientPartition()
    await clearUpgradeTransientPartition()
    expect(mockFromPartition).toHaveBeenCalledTimes(3)
    for (const call of mockFromPartition.mock.calls) {
      expect(call[0]).toBe(`persist:${UPGRADE_TRANSIENT_PARTITION}`)
    }
    expect(mockClearStorageData).toHaveBeenCalledTimes(3)
  })
})

// ── R2 F1 引用计数行为级测试（不依赖源码 grep，直接观察函数行为）──────
describe('W1.3 / R2 F1 · acquireUpgradeRefcount 引用计数（防并发互踩）', () => {
  beforeEach(() => {
    mockClearStorageData.mockClear()
    mockFromPartition.mockClear()
    __resetUpgradePartitionStartupClearForTest()
    __resetUpgradeRefcountForTest()
  })

  it('单流程：acquire → release 计数 0→1→0，release 时清 partition', async () => {
    expect(__getUpgradeRefcountForTest()).toBe(0)
    const release = acquireUpgradeRefcount()
    expect(__getUpgradeRefcountForTest()).toBe(1)
    expect(mockClearStorageData).not.toHaveBeenCalled()
    await release()
    expect(__getUpgradeRefcountForTest()).toBe(0)
    expect(mockClearStorageData).toHaveBeenCalledTimes(1)
  })

  it('两并发流程：A acquire B acquire A release（计数仍 1）→ 不清；B release（计数归 0）→ 清', async () => {
    const releaseA = acquireUpgradeRefcount()
    expect(__getUpgradeRefcountForTest()).toBe(1)
    const releaseB = acquireUpgradeRefcount()
    expect(__getUpgradeRefcountForTest()).toBe(2)

    await releaseA()
    // A 退出：计数 1，**不应清**——B 还在用 partition
    expect(__getUpgradeRefcountForTest()).toBe(1)
    expect(mockClearStorageData).not.toHaveBeenCalled()

    await releaseB()
    // B 退出：计数归零，末次清
    expect(__getUpgradeRefcountForTest()).toBe(0)
    expect(mockClearStorageData).toHaveBeenCalledTimes(1)
  })

  it('三并发流程：A B C 并发 acquire，依次 release，仅末次清', async () => {
    const r1 = acquireUpgradeRefcount()
    const r2 = acquireUpgradeRefcount()
    const r3 = acquireUpgradeRefcount()
    expect(__getUpgradeRefcountForTest()).toBe(3)

    await r1()
    await r2()
    expect(mockClearStorageData).not.toHaveBeenCalled()
    await r3()
    expect(mockClearStorageData).toHaveBeenCalledTimes(1)
  })

  it('release 是幂等的（double-release 不重复清）', async () => {
    const release = acquireUpgradeRefcount()
    await release()
    await release() // 第二次 release 应被吞掉，不重复 -1
    await release()
    expect(__getUpgradeRefcountForTest()).toBe(0)
    expect(mockClearStorageData).toHaveBeenCalledTimes(1)
  })

  it('release 在 clearStorageData throw 时不抛（best-effort）', async () => {
    mockClearStorageData.mockRejectedValueOnce(new Error('Session not ready'))
    const release = acquireUpgradeRefcount()
    await expect(release()).resolves.toBeUndefined()
    expect(__getUpgradeRefcountForTest()).toBe(0)
  })
})

describe('W1.3 / R2 F3 · 启动 gate（防启动 fire-and-forget 与首次升级 race）', () => {
  beforeEach(() => {
    mockClearStorageData.mockClear()
    mockFromPartition.mockClear()
    __resetUpgradePartitionStartupClearForTest()
  })

  it('未触发 kickoff 时 awaitUpgradePartitionStartupClear 立即 resolve（不阻塞）', async () => {
    const start = Date.now()
    await awaitUpgradePartitionStartupClear()
    expect(Date.now() - start).toBeLessThan(50)
  })

  it('kickoff 后第一次升级 await 等 clear 完成才返回（防 race）', async () => {
    let resolveClear!: () => void
    mockClearStorageData.mockImplementationOnce(
      () => new Promise<void>((r) => { resolveClear = r }),
    )
    kickoffUpgradePartitionStartupClear()

    const awaitPromise = awaitUpgradePartitionStartupClear()
    let resolved = false
    awaitPromise.then(() => { resolved = true })

    // 给一个 tick 让 promise 状态更新——await 不应该已经 resolve
    await new Promise((r) => setImmediate(r))
    expect(resolved).toBe(false)

    // clear resolve 后 await 才完成
    resolveClear()
    await awaitPromise
    expect(resolved).toBe(true)
  })

  it('clearStorageData 卡住（5s+）时 await 在超时后强制返回（防 hang 业务）', async () => {
    mockClearStorageData.mockImplementationOnce(() => new Promise<void>(() => {}))
    kickoffUpgradePartitionStartupClear()

    vi.useFakeTimers()
    const awaitPromise = awaitUpgradePartitionStartupClear()
    await vi.advanceTimersByTimeAsync(5000)
    await awaitPromise // 应该 resolve（不抛、不 hang）
    vi.useRealTimers()
  })

  it('kickoff 后多次 await 都能正常等到（同一 gate promise 复用）', async () => {
    kickoffUpgradePartitionStartupClear()
    await awaitUpgradePartitionStartupClear()
    await awaitUpgradePartitionStartupClear()
    await awaitUpgradePartitionStartupClear()
    expect(mockClearStorageData).toHaveBeenCalledTimes(1)
  })
})
