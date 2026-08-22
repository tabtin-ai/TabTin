/**
 * Sprint 4 — Daemon 端降级执行适配测试
 *
 * 验证 DaemonActionBridge 在 PTY 不可用时：
 * 1. route=sandbox 命令降级到 CommandExecutor 执行
 * 2. 交互式命令被正确拒绝
 * 3. route=regular 和 route=blocked 不受影响
 * 4. PTY 可用时保持原有流程（通过 adapter pipeline）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockExecuteDegraded,
  mockEvaluateTerminalPolicyDegradation,
  mockGetInteractiveTerminalPolicySupportError,
  mockNormalizeTerminalExecutionPolicy,
  mockAdapterExecuteAction,
} = vi.hoisted(() => ({
  mockExecuteDegraded: vi.fn(),
  mockEvaluateTerminalPolicyDegradation: vi.fn(),
  mockGetInteractiveTerminalPolicySupportError: vi.fn(),
  mockNormalizeTerminalExecutionPolicy: vi.fn((p: any) => p),
  mockAdapterExecuteAction: vi.fn(),
}))

vi.mock('@tabtin/ws-gateway-client', () => ({}))
vi.mock('@tabtin/terminal-core', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    evaluateLocalTerminalPolicy: vi.fn(() => ({ blocked: false, approvalRequired: false })),
    evaluateLocalFilePolicy: vi.fn(() => ({ blocked: false, approvalRequired: false })),
    isAutoApprovedTerminalWrite: vi.fn(() => true),
    containsCommandSubstitution: vi.fn(() => false),
    getInteractiveTerminalPolicySupportError: mockGetInteractiveTerminalPolicySupportError,
    normalizeTerminalExecutionPolicy: mockNormalizeTerminalExecutionPolicy,
    evaluateTerminalPolicyDegradation: mockEvaluateTerminalPolicyDegradation,
    executeDegraded: mockExecuteDegraded,
    resolvePlatformDataRoot: vi.fn(() => "/tmp/tabtin-platform-data"),
  }
})
vi.mock('@tabtin/security-policy', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    CHECKPOINT_MUTATING_ACTIONS: new Set<string>(),
  }
})

vi.mock('@tabtin/action-tools/headless', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    createHeadlessAdapter: vi.fn(() => ({
      getRegisteredTools: vi.fn(() => ['execute_in_terminal']),
      hasToolForAction: vi.fn((action: string) => action === 'execute_in_terminal'),
      registerTools: vi.fn(),
      executeAction: mockAdapterExecuteAction,
    })),
    tabNavigationTools: [],
    tabManagementTools: [],
  }
})
vi.mock('../src/platform/browser/DaemonBrowserService.js', () => ({
  getDaemonBrowserService: vi.fn(() => null),
}))
vi.mock('../src/platform/workspace/checkpoint/CheckpointService.js', () => ({
  getCheckpointService: vi.fn(),
  destroyCheckpointService: vi.fn(),
  destroyAllCheckpointServices: vi.fn().mockResolvedValue(undefined),
}))

import { DaemonActionBridge } from '../src/application/execution/action-bridge.js'
import { createActionExecutionTestPorts, type ActionExecutionTestPorts } from './helpers/action-execution-ports.js'
import type { DaemonConfig } from '../src/base/types/daemon-config.js'
import { createHeadlessAdapter } from '@tabtin/action-tools/headless'

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any
}

function createPluginManager() {
  return {
    getPlugins: () => [],
    setOnPluginLoaded: () => {},
  } as any
}

function createConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
  return {
    server_url: 'http://localhost',
    ws_url: 'ws://localhost',
    device_id: 'test-device',
    fingerprint: 'daemon-test',
    credential: 'test',
    organization_id: 'wt-1',
    device_name: 'test',
    plugins: [],
    capabilities: [],
    log_level: 'info',
    log_file: null,
    heartbeat_interval_ms: 15_000,
    proxy: null,
    workspace_root: '/tmp/test-workspace',
    ...overrides,
  }
}

function createEnvelope(action: string, command: string, sandboxPolicy?: Record<string, any>) {
  return {
    type: 'action' as const,
    thread_id: 'thread-1',
    trace_id: 'trace-1',
    payload: {
      task_id: 'task-1',
      action,
      params: { command },
      sandbox_policy: sandboxPolicy,
    },
  }
}

describe('Sprint 4: Daemon 端降级执行适配', () => {
  let bridge: DaemonActionBridge
  let logger: ReturnType<typeof createLogger>
  let ports: ActionExecutionTestPorts
  let sentResults: Array<{ threadId: string; taskId: string; result: Record<string, any> }>

  beforeEach(() => {
    vi.clearAllMocks()
    logger = createLogger()
    sentResults = []
    ports = createActionExecutionTestPorts()
    ports.resultHandler = async (threadId, taskId, result) => {
      sentResults.push({ threadId, taskId, result })
    }
    bridge = new DaemonActionBridge(createConfig(), createPluginManager(), logger, ports)
    bridge.registerCoreExecutors()
  })

  describe('终态投递契约', () => {
    it('投递失败不会把成功执行重跑成第二个失败结果', async () => {
      const sendResult = vi.fn().mockRejectedValue(new Error('gateway unavailable'))
      ports.resultHandler = sendResult
      const handler = vi.fn().mockResolvedValue({ success: true, data: { value: 1 } })
      bridge.registerHandler('contract_test_action', handler)

      await expect(bridge.handleAction(createEnvelope('contract_test_action', '') as any)).resolves.toBeUndefined()

      expect(handler).toHaveBeenCalledOnce()
      expect(sendResult).toHaveBeenCalledOnce()
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to deliver terminal result'),
      )
    })
  })

  describe('运行能力端口', () => {
    it('Browser 运行时就绪时通过显式端口启用 browser capability', () => {
      const browserPorts = createActionExecutionTestPorts()
      browserPorts.browserAvailable = true

      new DaemonActionBridge(createConfig(), createPluginManager(), logger, browserPorts)

      expect(vi.mocked(createHeadlessAdapter)).toHaveBeenLastCalledWith(
        expect.objectContaining({ capabilities: expect.any(Set) }),
      )
      const options = vi.mocked(createHeadlessAdapter).mock.lastCall?.[0] as any
      expect(options.capabilities.has('browser')).toBe(true)
    })
  })

  describe('PTY 不可用时的降级执行', () => {
    // ptyAvailable 默认为 false，模拟 PTY 不可用

    it('route=sandbox 命令降级到 CommandExecutor 执行', async () => {
      mockGetInteractiveTerminalPolicySupportError.mockReturnValue(
        'PTY cannot enforce sandbox policy',
      )
      mockEvaluateTerminalPolicyDegradation.mockReturnValue({
        canDegrade: true,
        reason: 'route=sandbox → spawn+sandbox',
        sandboxConfig: { route: 'sandbox', sandboxLevel: 'standard', networkMode: 'host' },
      })
      mockExecuteDegraded.mockResolvedValue({
        stdout: 'hello world\n',
        stderr: '',
        exitCode: 0,
        cwd: '/tmp/test-workspace',
        durationMs: 100,
        timedOut: false,
        sandboxApplied: true,
        warnings: [],
      })

      const envelope = createEnvelope('execute_in_terminal', 'echo hello', { route: 'sandbox' })
      await bridge.handleAction(envelope as any)

      expect(mockExecuteDegraded).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'echo hello',
          cwd: '/tmp/test-workspace',
          timeout: 120_000,
        }),
      )

      expect(sentResults).toHaveLength(1)
      const result = sentResults[0].result
      expect(result.success).toBe(true)
      expect(result.data?.exit_code).toBe(0)
      expect(result.data?.command_succeeded).toBe(true)
      expect(result.data?.output).toBe('hello world\n')
      expect(result.data?.policy_degraded).toBe(true)
      expect(result.data?.mode).toBe('sandbox')
    })

    it('交互式命令被正确拒绝', async () => {
      mockGetInteractiveTerminalPolicySupportError.mockReturnValue(
        'PTY cannot enforce sandbox policy',
      )
      mockEvaluateTerminalPolicyDegradation.mockReturnValue({
        canDegrade: true,
        reason: 'route=sandbox → spawn+sandbox',
        sandboxConfig: { route: 'sandbox', sandboxLevel: 'standard', networkMode: 'host' },
      })
      mockExecuteDegraded.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: -1,
        cwd: '/tmp/test-workspace',
        durationMs: 0,
        timedOut: false,
        sandboxApplied: false,
        warnings: [],
        interactiveBlocked: true,
        interactiveReason: 'vim 是交互式编辑器，需要 TTY',
        matchedCommand: 'vim',
      })

      const envelope = createEnvelope('execute_in_terminal', 'vim file.txt', { route: 'sandbox' })
      await bridge.handleAction(envelope as any)

      expect(sentResults).toHaveLength(1)
      const result = sentResults[0].result
      expect(result.success).toBe(false)
      expect(result.error_code).toBe('INTERACTIVE_BLOCKED')
      expect(result.data?.interactive_blocked).toBe(true)
      expect(result.data?.matched_command).toBe('vim')
    })

    it('非零退出码的命令正确返回', async () => {
      mockGetInteractiveTerminalPolicySupportError.mockReturnValue(
        'PTY cannot enforce sandbox policy',
      )
      mockEvaluateTerminalPolicyDegradation.mockReturnValue({
        canDegrade: true,
        reason: 'route=sandbox → spawn+sandbox',
        sandboxConfig: { route: 'sandbox', sandboxLevel: 'standard', networkMode: 'host' },
      })
      mockExecuteDegraded.mockResolvedValue({
        stdout: '',
        stderr: 'command not found: foo\n',
        exitCode: 127,
        cwd: '/tmp/test-workspace',
        durationMs: 50,
        timedOut: false,
        sandboxApplied: true,
        warnings: [],
      })

      const envelope = createEnvelope('execute_in_terminal', 'foo', { route: 'sandbox' })
      await bridge.handleAction(envelope as any)

      expect(sentResults).toHaveLength(1)
      const result = sentResults[0].result
      expect(result.success).toBe(true)
      expect(result.data?.exit_code).toBe(127)
      expect(result.data?.command_succeeded).toBe(false)
      expect(result.data?.output).toBe('command not found: foo\n')
    })

    it('executeDegraded 抛出异常时返回错误', async () => {
      mockGetInteractiveTerminalPolicySupportError.mockReturnValue(
        'PTY cannot enforce sandbox policy',
      )
      mockEvaluateTerminalPolicyDegradation.mockReturnValue({
        canDegrade: true,
        reason: 'route=sandbox → spawn+sandbox',
        sandboxConfig: { route: 'sandbox', sandboxLevel: 'standard', networkMode: 'host' },
      })
      mockExecuteDegraded.mockRejectedValue(new Error('sandbox binary not found'))

      const envelope = createEnvelope('execute_in_terminal', 'echo test', { route: 'sandbox' })
      await bridge.handleAction(envelope as any)

      expect(sentResults).toHaveLength(1)
      const result = sentResults[0].result
      expect(result.success).toBe(false)
      expect(result.error).toContain('sandbox binary not found')
      expect(result.data?.policy_degraded).toBe(true)
    })

    it('不可降级的策略仍返回 POLICY_BLOCKED', async () => {
      mockGetInteractiveTerminalPolicySupportError.mockReturnValue(
        'PTY cannot enforce network blocking',
      )
      mockEvaluateTerminalPolicyDegradation.mockReturnValue(null)

      const envelope = createEnvelope('execute_in_terminal', 'curl evil.com', {
        route: 'sandbox',
        network_mode: 'blocked',
      })
      await bridge.handleAction(envelope as any)

      expect(mockExecuteDegraded).not.toHaveBeenCalled()
      expect(sentResults).toHaveLength(1)
      expect(sentResults[0].result.error_code).toBe('POLICY_BLOCKED')
    })
  })

  describe('PTY 可用时保持原有流程', () => {
    beforeEach(() => {
      ports.ptyAvailable = true
    })

    it('route=sandbox 通过 adapter pipeline 传递降级决策', async () => {
      mockGetInteractiveTerminalPolicySupportError.mockReturnValue(
        'PTY cannot enforce sandbox policy',
      )
      mockEvaluateTerminalPolicyDegradation.mockReturnValue({
        canDegrade: true,
        reason: 'route=sandbox → spawn+sandbox',
        sandboxConfig: { route: 'sandbox', sandboxLevel: 'standard', networkMode: 'host' },
      })
      mockAdapterExecuteAction.mockResolvedValue({
        success: true,
        data: { output: 'ok', exit_code: 0, command_succeeded: true },
      })

      const envelope = createEnvelope('execute_in_terminal', 'echo hello', { route: 'sandbox' })
      await bridge.handleAction(envelope as any)

      // 不应直接调用 executeDegraded（由 adapter pipeline 内部处理）
      expect(mockExecuteDegraded).not.toHaveBeenCalled()
      // 应通过 adapter pipeline 执行
      expect(mockAdapterExecuteAction).toHaveBeenCalled()
      const callArgs = mockAdapterExecuteAction.mock.calls[0][0]
      expect(callArgs.params._degradation_decision).toBeDefined()
      expect(callArgs.params._policy_degraded).toBe(true)
    })
  })

  describe('route=regular 和 route=blocked 不受影响', () => {
    it('route=regular 不触发降级', async () => {
      mockGetInteractiveTerminalPolicySupportError.mockReturnValue(null)
      mockAdapterExecuteAction.mockResolvedValue({
        success: true,
        data: { output: 'ok', exit_code: 0 },
      })

      const envelope = createEnvelope('execute_in_terminal', 'ls', { route: 'regular' })
      await bridge.handleAction(envelope as any)

      expect(mockExecuteDegraded).not.toHaveBeenCalled()
      expect(mockEvaluateTerminalPolicyDegradation).not.toHaveBeenCalled()
      expect(mockAdapterExecuteAction).toHaveBeenCalled()
    })

  })

  describe('审计日志', () => {
    it('直接降级执行的审计日志包含 policy_degraded 标记', async () => {
      mockGetInteractiveTerminalPolicySupportError.mockReturnValue(
        'PTY cannot enforce sandbox policy',
      )
      mockEvaluateTerminalPolicyDegradation.mockReturnValue({
        canDegrade: true,
        reason: 'route=sandbox → spawn+sandbox',
        sandboxConfig: { route: 'sandbox', sandboxLevel: 'standard', networkMode: 'host' },
      })
      mockExecuteDegraded.mockResolvedValue({
        stdout: 'ok\n',
        stderr: '',
        exitCode: 0,
        cwd: '/tmp/test-workspace',
        durationMs: 50,
        timedOut: false,
        sandboxApplied: true,
        warnings: [],
      })

      const envelope = createEnvelope('execute_in_terminal', 'echo test', { route: 'sandbox' })
      await bridge.handleAction(envelope as any)

      const auditCalls = logger.info.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('[AUDIT]'),
      )
      expect(auditCalls.length).toBeGreaterThanOrEqual(1)
      const auditJson = auditCalls[0][0] as string
      expect(auditJson).toContain('policy_degraded')
    })
  })

  describe('OS sandbox 降级警告', () => {
    it('sandbox 未实际应用时标记 os_sandbox_degraded', async () => {
      mockGetInteractiveTerminalPolicySupportError.mockReturnValue(
        'PTY cannot enforce sandbox policy',
      )
      mockEvaluateTerminalPolicyDegradation.mockReturnValue({
        canDegrade: true,
        reason: 'route=sandbox → spawn+sandbox',
        sandboxConfig: { route: 'sandbox', sandboxLevel: 'standard', networkMode: 'host' },
      })
      mockExecuteDegraded.mockResolvedValue({
        stdout: 'ok\n',
        stderr: '',
        exitCode: 0,
        cwd: '/tmp/test-workspace',
        durationMs: 50,
        timedOut: false,
        sandboxApplied: false,
        warnings: ['bwrap not available'],
      })

      const envelope = createEnvelope('execute_in_terminal', 'echo test', { route: 'sandbox' })
      await bridge.handleAction(envelope as any)

      expect(sentResults).toHaveLength(1)
      const data = sentResults[0].result.data
      expect(data?.os_sandbox_degraded).toBe(true)
      expect(data?.os_sandbox_degraded_reason).toBe('sandbox binary unavailable')
    })
  })
})
