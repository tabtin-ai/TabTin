/**
 * Regression tests for Checkpoint & init chain P1 fixes (Wave 1 F5).
 *
 * CP-01: checkpoint_initial action handler registration
 * CP-04: checkpoint_gc action handler registration
 * CP-02: start() error rollback — stop() called on failure
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// CP-01 & CP-04: DaemonActionBridge registers checkpoint_initial / checkpoint_gc
// ---------------------------------------------------------------------------
// We import the class and verify its handler map after registerCoreExecutors().
// The bridge needs minimal config/plugin/logger stubs — it does not connect.
// ---------------------------------------------------------------------------

vi.mock('../src/platform/workspace/checkpoint/CheckpointService.js', () => {
  const mockService = {
    init: vi.fn().mockResolvedValue('/fake/.tabtin/shadow'),
    commit: vi.fn().mockResolvedValue('abc123'),
    restore: vi.fn().mockResolvedValue(undefined),
    getDiff: vi.fn().mockResolvedValue([]),
    getInitialCommitHash: vi.fn().mockResolvedValue('root-hash-000'),
    gc: vi.fn().mockResolvedValue(undefined),
  }
  return {
    getCheckpointService: vi.fn().mockReturnValue(mockService),
    destroyCheckpointService: vi.fn().mockResolvedValue(undefined),
    destroyAllCheckpointServices: vi.fn().mockResolvedValue(undefined),
    setCheckpointLogger: vi.fn(),
    __mockService: mockService,
  }
})

vi.mock('@tabtin/action-tools/headless', () => ({
  // Wave 2 起 API 升级为 workspaceRoots 数组；Wave 4 P0-2 修复 9 处 checkpoint
  // handler 都走 helper 后，mock 也要支持多目录数组（之前 mock 单 workspaceRoot
  // 永远不命中 if 抛错，是 pre-existing baseline 漂移）。
  validateProjectPath: vi.fn(
    (
      _: 'read' | 'write',
      projectPath: string,
      opts: { workspaceRoot?: string; workspaceRoots?: string[] },
    ) => {
      const roots = opts.workspaceRoots ?? (opts.workspaceRoot ? [opts.workspaceRoot] : [])
      if (roots.length === 0) return
      const inAny = roots.some((r) => String(projectPath).startsWith(r))
      if (!inAny) {
        throw new Error(
          `Read of "${projectPath}" rejected: path is outside allowed directories.`,
        )
      }
    },
  ),
  // Wave 1.5（2026-05-13）：FileLockManager / resolveFileLockPath 已废弃删除——
  // 锁实现下沉到 @tabtin/action-tools/utils/file-lock 的 withFileLock 函数 API，
  // 由 ActionExecutorAdapter 统一加锁。本测试不依赖锁行为，mock 出口字段一并清理。
  createHeadlessAdapter: () => ({
    getRegisteredTools: () => [],
    hasToolForAction: () => false,
    executeAction: vi.fn(),
  }),
}))

vi.mock('@tabtin/terminal-core', () => ({
  evaluateLocalTerminalPolicy: vi.fn(),
  evaluateLocalFilePolicy: vi.fn(),
  isAutoApprovedTerminalWrite: vi.fn(),
  containsCommandSubstitution: vi.fn().mockReturnValue(false),
  resolvePlatformDataRoot: vi.fn(() => '/tmp/tabtin-platform-data'),
  // ：resolveWorkspaceRootsForPolicy 把 dataRoot 一并纳入 boundary
  // 允许区，validateProjectPath 调用方需要这个 mock 才能通过策略检查。
  resolveDataRoot: vi.fn(() => '/tmp/tabtin-data-root'),
}))

import { DaemonActionBridge, validateProjectPath } from '../src/application/execution/action-bridge.js'
import type { DaemonConfig } from '../src/base/types/daemon-config.js'
import { createActionExecutionTestPorts, type ActionExecutionTestPorts } from './helpers/action-execution-ports.js'

let actionPorts: ActionExecutionTestPorts

function createMinimalBridge() {
  const config = { workspace_root: '/tmp/test-ws' } as DaemonConfig
  const pluginManager = {
    getPlugins: () => [],
    setOnPluginLoaded: () => {},
  } as any
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any
  actionPorts = createActionExecutionTestPorts()
  return new DaemonActionBridge(config, pluginManager, logger, actionPorts)
}

describe('CP-01: checkpoint_initial handler', () => {
  let bridge: DaemonActionBridge

  beforeEach(() => {
    vi.clearAllMocks()
    bridge = createMinimalBridge()
    bridge.registerCoreExecutors()
  })

  it('is listed in registered actions', () => {
    const actions = bridge.getRegisteredActions()
    expect(actions).toContain('checkpoint_initial')
  })

  it('returns commit_hash from getInitialCommitHash()', async () => {
    vi.mocked(actionPorts.workspaceHistory.checkpoints.initialCommit).mockResolvedValue('root-hash-000')
    const handler = (bridge as any).handlers.get('checkpoint_initial')
    expect(handler).toBeDefined()
    const result = await handler({ project_path: '/tmp/test-ws/my-proj' })
    expect(result).toEqual({ success: true, data: { commit_hash: 'root-hash-000' } })
    expect(actionPorts.workspaceHistory.checkpoints.initialCommit).toHaveBeenCalledWith('/tmp/test-ws/my-proj')
  })

  it('rejects missing project_path', async () => {
    const handler = (bridge as any).handlers.get('checkpoint_initial')
    const result = await handler({})
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/project_path/)
  })

  it('rejects project_path outside allowed directories', async () => {
    const handler = (bridge as any).handlers.get('checkpoint_initial')
    const result = await handler({ project_path: '/etc/shadow' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/outside allowed/)
  })
})

describe('CP-04: checkpoint_gc handler', () => {
  let bridge: DaemonActionBridge

  beforeEach(() => {
    vi.clearAllMocks()
    bridge = createMinimalBridge()
    bridge.registerCoreExecutors()
  })

  it('is listed in registered actions', () => {
    const actions = bridge.getRegisteredActions()
    expect(actions).toContain('checkpoint_gc')
  })

  it('calls service.gc() and returns success', async () => {
    const handler = (bridge as any).handlers.get('checkpoint_gc')
    expect(handler).toBeDefined()
    const result = await handler({ project_path: '/tmp/test-ws/my-proj' })
    expect(result).toEqual({ success: true })
    expect(actionPorts.workspaceHistory.checkpoints.gc).toHaveBeenCalledWith('/tmp/test-ws/my-proj')
  })

  it('rejects missing project_path', async () => {
    const handler = (bridge as any).handlers.get('checkpoint_gc')
    const result = await handler({})
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/project_path/)
  })
})

describe('file history semantic port', () => {
  it('previews affected paths through the application port', async () => {
    const bridge = createMinimalBridge()
    bridge.registerCoreExecutors()
    vi.mocked(actionPorts.workspaceHistory.files.affectedPaths).mockResolvedValue([
      '/tmp/test-ws/my-project/readme.md',
    ])

    const handler = (bridge as any).handlers.get('file_history_preview')
    const result = await handler({
      _thread_id: 'thread-1',
      anchor_id: 'anchor-1',
    })

    expect(actionPorts.workspaceHistory.files.affectedPaths).toHaveBeenCalledWith(
      'thread-1',
      'anchor-1',
    )
    expect(result).toEqual({
      success: true,
      data: { affected_paths: ['/tmp/test-ws/my-project/readme.md'] },
    })
  })
})

// ---------------------------------------------------------------------------
// CP-02: Daemon.start() rolls back via stop() on error
// ---------------------------------------------------------------------------
// We cannot easily instantiate TabTinDaemon (heavy dependencies), so we test
// the *behaviour pattern* — a start-like function that wraps try-catch and
// calls stop on failure, then re-throws.
// ---------------------------------------------------------------------------
describe('CP-02: start() error rollback pattern', () => {
  it('calls stop() and rethrows when an inner step fails', async () => {
    const stopFn = vi.fn().mockResolvedValue(undefined)
    let running = false

    async function startWithRollback() {
      if (running) return
      running = true
      try {
        throw new Error('gateway.connect() failed')
      } catch (err) {
        await stopFn()
        running = false
        throw err
      }
    }

    await expect(startWithRollback()).rejects.toThrow('gateway.connect() failed')
    expect(stopFn).toHaveBeenCalledTimes(1)
    expect(running).toBe(false)
  })

  it('the real daemon.ts start() method contains try-catch with this.stop()', async () => {
    const fs = await import('node:fs')
    const daemonSource = fs.readFileSync(
      new URL('../src/bootstrap/daemon.ts', import.meta.url),
      'utf-8',
    )
    expect(daemonSource).toContain('await this.stop()')
    expect(daemonSource).toContain('throw err')
    const startMatch = daemonSource.match(
      /async start\(\)[\s\S]*?catch\s*\(err\)\s*\{[\s\S]*?await this\.stop\(\)/,
    )
    expect(startMatch).not.toBeNull()
  })
})
