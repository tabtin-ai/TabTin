/**
 * FrontendActionBridge destroyed guard 回归测试
 *
 * 回归覆盖 SC-005：destroy() 后调用 executeAction 应立即返回错误，
 * 而非挂起或抛出 TypeError（访问已 null 的引用）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp') },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}))
vi.mock('@tabtin/action-tools/adapters', () => {
  class MockAdapter {
    getRegisteredTools = vi.fn().mockReturnValue([])
    hasToolForAction = vi.fn().mockReturnValue(false)
    executeAction = vi.fn().mockResolvedValue({ success: true })
  }
  return { ActionExecutorAdapter: MockAdapter }
})
vi.mock('@tabtin/action-tools/impl', () => ({
  getSharedBrowserToolImpl: vi.fn().mockReturnValue({
    destroy: vi.fn().mockResolvedValue(undefined),
  }),
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
  }
})
vi.mock('../ApprovalManager', () => ({ requestApproval: vi.fn() }))
vi.mock('../CDPNetworkBridge', () => ({ enableForTab: vi.fn() }))
vi.mock('../../cli/cli-server', () => ({
  getCLISpaceId: vi.fn(),
  getCLICrawlspaceId: vi.fn(),
  getCLIOrganizationRoot: vi.fn().mockReturnValue(null),
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

import { FrontendActionBridge } from '../FrontendActionBridge'

describe('FrontendActionBridge destroyed guard (SC-005)', () => {
  let bridge: FrontendActionBridge
  const mockWindow = {} as any

  beforeEach(() => {
    bridge = new FrontendActionBridge(mockWindow)
  })

  it('destroyed 属性初始为 false', () => {
    expect(bridge.destroyed).toBe(false)
  })

  it('destroy() 后 destroyed 属性为 true', async () => {
    await bridge.destroy()
    expect(bridge.destroyed).toBe(true)
  })

  it('destroy() 后 executeAction 立即返回失败而非挂起', async () => {
    await bridge.destroy()

    const result = await bridge.executeAction({
      task_id: 'test-task',
      action: 'open_tab',
      params: { url: 'https://example.com' },
    } as any)

    expect(result.success).toBe(false)
    expect(result.error).toContain('destroyed')
  })

  it('destroy() 前 executeAction 正常工作', async () => {
    const result = await bridge.executeAction({
      task_id: 'test-task',
      action: 'open_tab',
      params: { url: 'https://example.com' },
    } as any)

    expect(result.success).toBe(true)
  })
})
