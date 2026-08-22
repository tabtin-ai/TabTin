import type { CommandExecutor } from '../commandExecutor';
import type { SandboxLevel, TerminalExecutionPolicy } from '../types';
import type {
  BackendCapabilities,
  BackendConfig,
  BackendExecutionResult,
  BackendFactory,
  ExecuteParams,
  ExecutionBackend,
} from './types';

/**
 * SpawnSandboxBackend 的能力声明 —— 单源常量，避免 register 时手抄
 * 与 instance.capabilities 漂移。
 *
 * **W1.2 review#3 P1-2 修订**：之前 `host-bootstrap.ts` 注册到
 * ExecutionBackendRegistry 时复述了一份相同字段，长期维护时改一处
 * 漏改另一处易导致漂移。改为统一从此常量导入。
 */
export const SPAWN_SANDBOX_BACKEND_CAPABILITIES: BackendCapabilities = {
  supportsInteractive: false,
  supportsSandbox: true,
  supportsNetworkIsolation: true,
  supportsFileSystemIsolation: true,
  latencyClass: 'local',
  platforms: ['darwin', 'linux', 'win32'],
};

/**
 * 封装现有 CommandExecutor 的执行后端。
 *
 * - 非交互式（supportsInteractive = false）
 * - 支持 OS 沙箱（bwrap / sandbox-exec）
 * - 本地延迟
 */
export class SpawnSandboxBackend implements ExecutionBackend {
  readonly id = 'local-spawn';
  readonly capabilities: BackendCapabilities = SPAWN_SANDBOX_BACKEND_CAPABILITIES;

  constructor(private executor: CommandExecutor) {}

  async execute(params: ExecuteParams): Promise<BackendExecutionResult> {
    const sandboxLevel = this._resolveSandboxLevel(params.policy);
    const mode = sandboxLevel ? 'sandbox' : 'regular';

    const handle = await this.executor.executeStreaming({
      command: params.command,
      mode,
      sandboxLevel,
      workingDirectory: params.cwd,
      timeoutMs: params.timeout,
      // W1.2 P0：透传 env 到 CommandExecutor —— 此前 SpawnSandboxBackend
      // 在 ExecuteParams.env 上声明字段但 executeStreaming 不消费，属 hidden bug。
      env: params.env,
      // W1.2 P0：透传 signal 到 CommandExecutor 的 AbortSignal 路径，
      // 让 BackendSession.exec(opts.signal) 能真实终止子进程。
      // W2.2.1 P1 (b)：signal 已经是 ExecuteParams 公共字段，不再依赖
      // SpawnExecuteParams widening。
      signal: params.signal,
      // W2.2.1 P1 (b)：透传 maxOutputBytes 到 CommandExecutor.executeStreaming
      // 的 StreamingExecuteOptions（继承自 ExecuteOptions）—— 让 Capability
      // 层能按 tool 调用粒度截断输出，不必依赖 CommandExecutor 100KB 全局
      // 默认值。
      maxOutputBytes: params.maxOutputBytes,
      onStdout: params.onStdout,
      onStderr: params.onStderr,
      policyOverrides: params.policy ? {
        route: params.policy.route,
        sandboxLevel: params.policy.sandboxLevel,
        networkMode: params.policy.networkMode,
        approvalRequired: params.policy.approvalRequired,
        denyReason: params.policy.denyReason,
        relaxedRules: params.policy.relaxedRules,
      } : undefined,
    });
    const result = await handle.result;

    const warnings = result.warnings ?? [];

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      backendId: this.id,
      sandboxApplied: result.osSandbox ?? false,
      degraded: result.osSandboxDegraded ?? false,
      warnings,
      // W2.2.1 修订：透传 ExecuteResult.truncated → BackendExecutionResult.truncated
      // 让 ShellCap 等 Capability 真正感知"输出是否因 maxOutputBytes 截断"。
      truncated: result.truncated || undefined,
    };
  }

  async cleanup(): Promise<void> {
    // CommandExecutor.cleanupSandbox 需要 threadId，
    // 后端层面不持有 threadId，调用方应通过 executor 直接清理
  }

  private _resolveSandboxLevel(policy?: TerminalExecutionPolicy): SandboxLevel | undefined {
    if (!policy) return undefined;
    if (policy.route === 'sandbox') {
      return policy.sandboxLevel ?? 'filesystem';
    }
    return undefined;
  }
}

// ── Factory ─────────────────────────────────────────────────────────

export class SpawnSandboxBackendFactory implements BackendFactory {
  constructor(private executor: CommandExecutor) {}

  async create(_config: BackendConfig): Promise<ExecutionBackend> {
    return new SpawnSandboxBackend(this.executor);
  }
}
