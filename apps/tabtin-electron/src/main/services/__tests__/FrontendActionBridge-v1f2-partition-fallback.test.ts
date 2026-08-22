/**
 * FrontendActionBridge：open_tab partition 解析契约。
 *
 * 本地化退役 Wave 2 之后 BES 永远立即返回真实 partition，不再有 pending /
 * legacy 兜底分支。这套用例覆盖：
 *   - Service 返回真 partition → 透传
 *   - Service 抛异常 → partition 留空，下游按 metadata.spaceId 二次解析
 *   - caller 显式传 partition → 优先使用
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  adapterExecuteActionMock,
  getPartitionForSpaceMock,
  getCLISpaceIdMock,
  getCLICrawlspaceIdMock,
  getCLIWorkspaceScopeKeyMock,
} = vi.hoisted(() => ({
  adapterExecuteActionMock: vi.fn().mockResolvedValue({ success: true }),
  getPartitionForSpaceMock: vi.fn(),
  getCLISpaceIdMock: vi.fn(),
  getCLICrawlspaceIdMock: vi.fn(),
  getCLIWorkspaceScopeKeyMock: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp') },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
}))

vi.mock('@tabtin/action-tools/adapters', () => {
  class MockAdapter {
    getRegisteredTools = vi.fn().mockReturnValue([])
    hasToolForAction = vi.fn().mockReturnValue(false)
    executeAction = adapterExecuteActionMock
  }
  return { ActionExecutorAdapter: MockAdapter }
})

vi.mock('@tabtin/action-tools/impl', () => ({
  getSharedBrowserToolImpl: vi.fn().mockReturnValue({
    destroy: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('@tabtin/action-tools/headless', () => ({
  validateProjectPath: vi.fn(),
  // Wave 1.5（2026-05-13）：FileLockManager / resolveFileLockPath 已废弃删除——
  // 锁实现下沉为 withFileLock 函数 API + ActionExecutorAdapter 统一加锁。
}))

vi.mock('@tabtin/terminal-core', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/terminal-core')>('@tabtin/terminal-core')
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
  const actual = await vi.importActual<typeof import('@tabtin/security-policy')>('@tabtin/security-policy')
  return {
    ...actual,
    CHECKPOINT_MUTATING_ACTIONS: new Set(),
  }
})

vi.mock('../ApprovalManager', () => ({ requestApproval: vi.fn() }))
vi.mock('../CDPNetworkBridge', () => ({ enableForTab: vi.fn() }))

vi.mock('../../cli/cli-context', () => ({
  getCLISpaceId: getCLISpaceIdMock,
  getCLICrawlspaceId: getCLICrawlspaceIdMock,
  getCLIOrganizationRoot: vi.fn().mockReturnValue('/home/user/project'),
  getCLIWorkspaceScopeKey: getCLIWorkspaceScopeKeyMock,
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
  getCrawlspaceContextHub: vi.fn().mockReturnValue({ getAllSnapshots: vi.fn().mockReturnValue([]) }),
}))

vi.mock('../../browser-env/BrowserEnvironmentService', () => ({
  getBrowserEnvironmentService: vi.fn().mockReturnValue({
    getPartitionForSpace: getPartitionForSpaceMock,
  }),
}))

vi.mock('../StreamDownloadService', () => ({
  getStreamDownloadService: vi.fn().mockReturnValue({
    on: vi.fn(),
    removeListener: vi.fn(),
  }),
}))

vi.mock('../LocalMcpService', () => ({
  getLocalMcpService: vi.fn().mockReturnValue({
    dispose: vi.fn().mockResolvedValue(undefined),
  }),
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
  djangoRequest: vi.fn(),
  errorResponse: vi.fn(),
}))

vi.mock('../../checkpoint/CheckpointService', () => ({
  getCheckpointService: vi.fn(),
}))

// 路径权限治理 Wave 2：updateSpaceDenyPaths / updateGitSpaceDenyPaths 是
// O8 死代码，已删除。保留对模块的 mock 让 vi 替换整个 import，避免触发
// pre-existing FrontendActionBridge 测试套件的"electron mock 缺 app"错误
// （来自 ElectronWsGateway 链路，与本 wave 无关）。
vi.mock('../../file-system/ipc', () => ({}))
vi.mock('../../git-ipc', () => ({}))

import { FrontendActionBridge } from '../FrontendActionBridge'

describe('FrontendActionBridge open_tab partition 解析', () => {
  let bridge: FrontendActionBridge
  const mockWindow = {} as any

  beforeEach(() => {
    vi.clearAllMocks()
    adapterExecuteActionMock.mockResolvedValue({ success: true })
    getCLISpaceIdMock.mockReturnValue(undefined)
    getCLICrawlspaceIdMock.mockReturnValue(undefined)
    getCLIWorkspaceScopeKeyMock.mockReturnValue(undefined)
    bridge = new FrontendActionBridge(mockWindow)
  })

  it('Service 抛异常时 partition 为 undefined（不再拼 legacy fallback）', async () => {
    getPartitionForSpaceMock.mockImplementation(() => {
      throw new Error('not started')
    })
    getCLICrawlspaceIdMock.mockReturnValue('cs-99999')

    await bridge.executeAction({
      task_id: 't2',
      action: 'open_tab',
      params: {
        url: 'https://example.com',
        metadata: { spaceId: 'space-B' },
      },
    } as any)

    const downstreamParams = adapterExecuteActionMock.mock.calls[0][0].params
    expect(downstreamParams.partition).toBeUndefined()
  })

  it('Service 返回有效 partition 时，透传到下游', async () => {
    getPartitionForSpaceMock.mockReturnValue('tabtin:env:env-prod')
    getCLICrawlspaceIdMock.mockReturnValue('cs-77777')

    await bridge.executeAction({
      task_id: 't3',
      action: 'open_tab',
      params: {
        url: 'https://example.com',
        metadata: { spaceId: 'space-C' },
      },
    } as any)

    const downstreamParams = adapterExecuteActionMock.mock.calls[0][0].params
    expect(downstreamParams.partition).toBe('tabtin:env:env-prod')
  })

  it('#6538：无 thread 的 open_tab 不读取上一个 Agent scope，交给前台 fallback', async () => {
    getCLISpaceIdMock.mockReturnValue('space-visible')
    getCLIWorkspaceScopeKeyMock.mockReturnValue('conversation:session-1')
    getPartitionForSpaceMock.mockReturnValue('tabtin:env:env-visible')

    await bridge.executeAction({
      task_id: 't-visible',
      action: 'open_tab',
      params: {
        url: 'https://example.com',
      },
    } as any)

    const downstreamParams = adapterExecuteActionMock.mock.calls[0][0].params
    expect(downstreamParams.metadata).toEqual({ spaceId: 'space-visible' })
    expect(downstreamParams.tabScopeKey).toBeUndefined()
    expect(downstreamParams.workspaceScopeKey).toBeUndefined()
    expect(getCLIWorkspaceScopeKeyMock).not.toHaveBeenCalled()
  })

  it('open_tab 保留调用方显式传入的 scope，不用当前 CLI scope 覆盖', async () => {
    getCLISpaceIdMock.mockReturnValue('space-visible')
    getCLIWorkspaceScopeKeyMock.mockReturnValue('conversation:current')
    getPartitionForSpaceMock.mockReturnValue('tabtin:env:env-visible')

    await bridge.executeAction({
      task_id: 't-explicit-scope',
      action: 'open_tab',
      params: {
        url: 'https://example.com',
        tabScopeKey: 'conversation:explicit-tab',
        workspaceScopeKey: 'conversation:explicit-workspace',
      },
    } as any)

    const downstreamParams = adapterExecuteActionMock.mock.calls[0][0].params
    expect(downstreamParams.tabScopeKey).toBe('conversation:explicit-tab')
    expect(downstreamParams.workspaceScopeKey).toBe('conversation:explicit-workspace')
  })

  it('#6538/#2179：open_tab 按发起 thread 取 scope，不被全局最近一次覆盖', async () => {
    getCLISpaceIdMock.mockReturnValue('space-visible')
    getCLIWorkspaceScopeKeyMock.mockImplementation((threadId?: string | null) => {
      if (threadId === 'session-A') return 'conversation:session-A'
      if (threadId === 'session-B') return 'conversation:session-B'
      if (threadId) return null
      return 'conversation:global-stale'
    })
    getPartitionForSpaceMock.mockReturnValue('tabtin:env:env-visible')

    await bridge.executeAction({
      task_id: 't-thread-a',
      action: 'open_tab',
      thread_id: 'session-A',
      params: {
        url: 'https://36kr.com',
      },
    } as any)

    const downstreamParams = adapterExecuteActionMock.mock.calls[0][0].params
    expect(downstreamParams.tabScopeKey).toBe('conversation:session-A')
    expect(downstreamParams.workspaceScopeKey).toBe('conversation:session-A')
    expect(getCLIWorkspaceScopeKeyMock).toHaveBeenCalledWith('session-A')
  })

  it('显式传入 params.partition 时优先使用，不走 Service 解析', async () => {
    getPartitionForSpaceMock.mockReturnValue('tabtin:env:should-not-use')
    getCLICrawlspaceIdMock.mockReturnValue('cs-explicit')

    await bridge.executeAction({
      task_id: 't4',
      action: 'open_tab',
      params: {
        url: 'https://example.com',
        partition: 'tabtin:env:explicit-env',
        metadata: { spaceId: 'space-D' },
      },
    } as any)

    const downstreamParams = adapterExecuteActionMock.mock.calls[0][0].params
    expect(downstreamParams.partition).toBe('tabtin:env:explicit-env')
  })
})
