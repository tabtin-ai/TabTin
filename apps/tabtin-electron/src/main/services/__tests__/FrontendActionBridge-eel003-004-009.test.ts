/**
 * EEL-003 / EEL-004 / EEL-009 回归测试
 *
 * EEL-003: read_file / glob_search / grep_search / read_lints 须受 workspace 路径边界检查约束
 * EEL-004: write_file / edit_file / delete_file 须受 validateProjectPath 校验约束
 * EEL-009: read_file 不应触发写操作审批逻辑（evaluateLocalFilePolicy），
 *          应走 READ_SANDBOX_ACTIONS 独立路径
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { requestApprovalMock, adapterExecuteActionMock, evaluateLocalFilePolicyMock } = vi.hoisted(() => ({
  requestApprovalMock: vi.fn(),
  adapterExecuteActionMock: vi.fn().mockResolvedValue({ success: true }),
  evaluateLocalFilePolicyMock: vi.fn().mockReturnValue({ blocked: false }),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp') },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
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
vi.mock('@tabtin/terminal-core', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/terminal-core')>('@tabtin/terminal-core')
  return {
    ...actual,
    getInteractiveTerminalPolicySupportError: vi.fn().mockReturnValue(null),
    normalizeTerminalExecutionPolicy: vi.fn().mockReturnValue({}),
    evaluateLocalFilePolicy: evaluateLocalFilePolicyMock,
    evaluateLocalTerminalPolicy: vi.fn().mockReturnValue({ blocked: false }),
    isAutoApprovedTerminalWrite: vi.fn().mockReturnValue(true),
    containsCommandSubstitution: vi.fn().mockReturnValue(false),
  }
})
vi.mock('@tabtin/security-policy', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/security-policy')>('@tabtin/security-policy')
  return { ...actual }
})
vi.mock('../ApprovalManager', () => ({ requestApproval: requestApprovalMock }))
vi.mock('../CDPNetworkBridge', () => ({ enableForTab: vi.fn() }))
vi.mock('../../cli/cli-context', () => ({
  getCLISpaceId: vi.fn(),
  getCLICrawlspaceId: vi.fn(),
  getCLIOrganizationRoot: vi.fn().mockReturnValue('/home/user/project'),
  getCLIWorkspaceScopeKey: vi.fn().mockReturnValue(null),
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
import { validateProjectPath } from '@tabtin/action-tools/headless'

// ─── EEL-003: workspace 路径边界检查（读操作） ────────────────────

describe('EEL-003: READ_SANDBOX_ACTIONS workspace 路径越界拦截', () => {
  let bridge: FrontendActionBridge
  const mockWindow = {} as any

  beforeEach(() => {
    vi.clearAllMocks()
    bridge = new FrontendActionBridge(mockWindow)
  })

  it('read_file 读取 workspace 内文件 → 允许', async () => {
    const result = await bridge.executeAction({
      task_id: 'test',
      action: 'read_file',
      params: { file_path: '/home/user/project/src/index.ts' },
    } as any)

    expect(result.success).toBe(true)
  })

  it('read_file 读取 workspace 外文件 → POLICY_BLOCKED', async () => {
    const result = await bridge.executeAction({
      task_id: 'test',
      action: 'read_file',
      params: { file_path: '/etc/passwd' },
    } as any)

    expect(result.success).toBe(false)
    expect((result as any).error_code).toBe('POLICY_BLOCKED')
  })

  it('read_file 通过 ../ 遍历越界 → POLICY_BLOCKED', async () => {
    const result = await bridge.executeAction({
      task_id: 'test',
      action: 'read_file',
      params: { file_path: '/home/user/project/../../root/.ssh/id_rsa' },
    } as any)

    expect(result.success).toBe(false)
    expect((result as any).error_code).toBe('POLICY_BLOCKED')
  })

  it('read_file 读取 ~/.tabtin/ 下文件 → 允许', async () => {
    const os = await import('node:os')
    const tabtinPath = `${os.homedir()}/.tabtin/config.json`

    const result = await bridge.executeAction({
      task_id: 'test',
      action: 'read_file',
      params: { file_path: tabtinPath },
    } as any)

    expect(result.success).toBe(true)
  })

  it('glob_search 的 target_directory 越界 → POLICY_BLOCKED', async () => {
    const result = await bridge.executeAction({
      task_id: 'test',
      action: 'glob_search',
      params: { target_directory: '/etc', pattern: '*.conf' },
    } as any)

    expect(result.success).toBe(false)
    expect((result as any).error_code).toBe('POLICY_BLOCKED')
  })

  it('grep_search 的 path 越界 → POLICY_BLOCKED', async () => {
    const result = await bridge.executeAction({
      task_id: 'test',
      action: 'grep_search',
      params: { path: '/var/log', pattern: 'error' },
    } as any)

    expect(result.success).toBe(false)
    expect((result as any).error_code).toBe('POLICY_BLOCKED')
  })

  it('read_lints 的 paths 中有越界路径 → POLICY_BLOCKED', async () => {
    const result = await bridge.executeAction({
      task_id: 'test',
      action: 'read_lints',
      params: { paths: ['/home/user/project/src/a.ts', '/etc/shadow'] },
    } as any)

    expect(result.success).toBe(false)
    expect((result as any).error_code).toBe('POLICY_BLOCKED')
  })

  it('read_lints 所有路径都在 workspace 内 → 允许', async () => {
    const result = await bridge.executeAction({
      task_id: 'test',
      action: 'read_lints',
      params: { paths: ['/home/user/project/src/a.ts', '/home/user/project/src/b.ts'] },
    } as any)

    expect(result.success).toBe(true)
  })
})

// ─── EEL-004: workspace 路径边界检查（写操作） ────────────────────

describe('EEL-004: FILE_POLICY_ACTIONS workspace 路径越界拦截', () => {
  let bridge: FrontendActionBridge
  const mockWindow = {} as any

  beforeEach(() => {
    vi.clearAllMocks()
    bridge = new FrontendActionBridge(mockWindow)
  })

  const WRITE_ACTIONS = ['write_file', 'edit_file', 'delete_file']

  for (const actionType of WRITE_ACTIONS) {
    it(`${actionType} 写入 workspace 内 → 允许`, async () => {
      const result = await bridge.executeAction({
        task_id: 'test',
        action: actionType,
        params: { file_path: '/home/user/project/src/index.ts', content: 'hello' },
      } as any)

      expect(result.success).toBe(true)
    })

    it(`${actionType} 写入 workspace 外 → POLICY_BLOCKED`, async () => {
      const result = await bridge.executeAction({
        task_id: 'test',
        action: actionType,
        params: { file_path: '/tmp/malicious.sh', content: 'rm -rf /' },
      } as any)

      expect(result.success).toBe(false)
      expect((result as any).error_code).toBe('POLICY_BLOCKED')
    })

    it(`${actionType} 通过 ../ 遍历越界 → POLICY_BLOCKED`, async () => {
      const result = await bridge.executeAction({
        task_id: 'test',
        action: actionType,
        params: { file_path: '/home/user/project/../../../etc/crontab', content: '* * * *' },
      } as any)

      expect(result.success).toBe(false)
      expect((result as any).error_code).toBe('POLICY_BLOCKED')
    })
  }
})

// ─── W2afollow-up: FILE_POLICY_ACTIONS 覆盖 mkdir/move_file ───

describe('W2a follow-up: mkdir/move_file 纳入 FILE_POLICY_ACTIONS', () => {
  let bridge: FrontendActionBridge
  const mockWindow = {} as any

  beforeEach(() => {
    vi.clearAllMocks()
    bridge = new FrontendActionBridge(mockWindow)
  })

  it('mkdir 在 workspace 内 → 允许', async () => {
    const result = await bridge.executeAction({
      task_id: 'test',
      action: 'mkdir',
      params: { path: '/home/user/project/src/newdir' },
    } as any)

    expect(result.success).toBe(true)
  })

  it('mkdir 在 workspace 外 → POLICY_BLOCKED', async () => {
    const result = await bridge.executeAction({
      task_id: 'test',
      action: 'mkdir',
      params: { path: '/etc/newdir' },
    } as any)

    expect(result.success).toBe(false)
    expect((result as any).error_code).toBe('POLICY_BLOCKED')
  })

  it('move_file：from 和 to 都在 workspace 内 → 允许', async () => {
    const result = await bridge.executeAction({
      task_id: 'test',
      action: 'move_file',
      params: {
        from: '/home/user/project/src/old.ts',
        to: '/home/user/project/src/new.ts',
      },
    } as any)

    expect(result.success).toBe(true)
  })

  it('move_file：from 越界（即使 to 在 workspace 内）→ POLICY_BLOCKED', async () => {
    const result = await bridge.executeAction({
      task_id: 'test',
      action: 'move_file',
      params: {
        from: '/etc/passwd',
        to: '/home/user/project/src/new.ts',
      },
    } as any)

    expect(result.success).toBe(false)
    expect((result as any).error_code).toBe('POLICY_BLOCKED')
  })

  it('move_file：to 越界（即使 from 在 workspace 内）→ POLICY_BLOCKED（回归：曾经只查 path/file_path 会漏查 to）', async () => {
    const result = await bridge.executeAction({
      task_id: 'test',
      action: 'move_file',
      params: {
        from: '/home/user/project/src/old.ts',
        to: '/tmp/exfiltrated.ts',
      },
    } as any)

    expect(result.success).toBe(false)
    expect((result as any).error_code).toBe('POLICY_BLOCKED')
  })

  it('move_file：from 通过 ../ 遍历越界 → POLICY_BLOCKED', async () => {
    const result = await bridge.executeAction({
      task_id: 'test',
      action: 'move_file',
      params: {
        from: '/home/user/project/../../etc/shadow',
        to: '/home/user/project/src/new.ts',
      },
    } as any)

    expect(result.success).toBe(false)
    expect((result as any).error_code).toBe('POLICY_BLOCKED')
  })
})

// ─── EEL-009: read_file 不应触发写操作审批 ────────────────────

describe('EEL-009: read_file 不触发写操作确认逻辑', () => {
  let bridge: FrontendActionBridge
  const mockWindow = {} as any

  beforeEach(() => {
    vi.clearAllMocks()
    bridge = new FrontendActionBridge(mockWindow)
  })

  it('read_file 不触发 evaluateLocalFilePolicy 的 approvalRequired', async () => {
    evaluateLocalFilePolicyMock.mockReturnValue({ blocked: false, approvalRequired: false })

    const result = await bridge.executeAction({
      task_id: 'test',
      action: 'read_file',
      params: { file_path: '/home/user/project/src/index.ts' },
    } as any)

    expect(result.success).toBe(true)
    expect(requestApprovalMock).not.toHaveBeenCalled()
  })

  it('read_file 即使 evaluateLocalFilePolicy 返回 approvalRequired=true 也不触发审批（因为走 READ 路径而非写路径）', async () => {
    evaluateLocalFilePolicyMock.mockReturnValue({ blocked: false, approvalRequired: true })

    const result = await bridge.executeAction({
      task_id: 'test',
      action: 'read_file',
      params: { file_path: '/home/user/project/src/index.ts' },
    } as any)

    expect(result.success).toBe(true)
    expect(requestApprovalMock).not.toHaveBeenCalled()
  })

  it('write_file 仍然通过 evaluateLocalFilePolicy 审批', async () => {
    evaluateLocalFilePolicyMock.mockReturnValue({ blocked: false, approvalRequired: true })
    requestApprovalMock.mockResolvedValue({ approved: false })

    const result = await bridge.executeAction({
      task_id: 'test',
      action: 'write_file',
      params: { file_path: '/home/user/project/src/index.ts', content: 'hello' },
    } as any)

    expect(result.success).toBe(false)
    expect(requestApprovalMock).toHaveBeenCalled()
  })
})

// ─── validateProjectPath 单元测试 ────────────────────

describe('validateProjectPath', () => {
  // 路径权限治理 Wave 1：签名升级为 `workspaceRoots: readonly string[]`。
  const opts = {
    workspaceRoots: ['/home/user/project'],
    platformDataRoot: "/tmp/platform-data",
    homeDir: '/home/user',
  }

  it('workspace 内路径 → 不抛出', () => {
    expect(() => validateProjectPath('read', '/home/user/project/src/file.ts', opts)).not.toThrow()
  })

  it('workspace 外路径 → 抛出', () => {
    expect(() => validateProjectPath('read', '/etc/passwd', opts)).toThrow()
  })

  it('~/.tabtin/ 内路径 → 不抛出', () => {
    const tabtinPath = '/home/user/.tabtin/some/file'
    expect(() => validateProjectPath('read', tabtinPath, opts)).not.toThrow()
  })

  it('workspace 路径前缀攻击 → 抛出 (e.g., /home/user/project-evil)', () => {
    expect(() => validateProjectPath('read', '/home/user/project-evil/file.ts', opts)).toThrow()
  })

  it('.. 遍历越界 → 抛出', () => {
    expect(() => validateProjectPath('read', '/home/user/project/../../etc/passwd', opts)).toThrow()
  })

  it('无 workspaceRoot 时仅允许 ~/.tabtin/', () => {
    expect(() => validateProjectPath('read', '/arbitrary/path', {
      platformDataRoot: "/tmp/platform-data",
      homeDir: '/home/user',
    })).toThrow()
  })
})
