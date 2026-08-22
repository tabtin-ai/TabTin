export type TerminalMode = 'regular' | 'sandbox';
export type TerminalRoute = TerminalMode | 'blocked';
export type TerminalNetworkMode = 'allowed' | 'blocked' | 'custom';
export type TerminalCapability =
  | 'execute'
  | 'session_read'
  | 'session_write'
  | 'session_list'
  | 'interactive';

/**
 * OS 沙箱级别
 * - filesystem: 文件系统隔离，网络放行（workspace 模式）
 * - complete:   文件系统 + 网络隔离（strict 模式）
 */
export type SandboxLevel = 'filesystem' | 'complete';

export interface TerminalExecutionPolicy {
  /** Override execution route: "sandbox" | "regular" | "blocked" */
  route?: TerminalRoute;
  /** Override sandbox level */
  sandboxLevel?: SandboxLevel;
  /** Network policy: "allowed" | "blocked" | "custom" */
  networkMode?: TerminalNetworkMode;
  /** Whether to require approval for this specific execution */
  approvalRequired?: boolean;
  /** Reason for blocking (from server-side policy) */
  denyReason?: string;
  /** Named allow-rule sets to activate (resolved via RELAXABLE_ALLOW_RULES) */
  relaxedRules?: string[];
}

/**
 * Wire payload shape used by Django / Electron / Daemon action dispatch.
 * We keep this alongside the camelCase policy contract so runtimes can
 * normalize external payloads without duplicating field mapping logic.
 */
export interface TerminalExecutionPolicyPayload {
  route?: string | null;
  sandbox_level?: string | null;
  network_mode?: string | null;
  approval_required?: boolean | null;
  deny_reason?: string | null;
  relaxed_rules?: string[] | null;
}

export interface TerminalExecutionContext {
  workspaceRoot?: string;
  /** Explicit working directory override. Takes precedence over workspaceRoot. */
  workingDirectory?: string;
  threadId?: string;
  spaceId?: string;
  env?: Record<string, string>;
}

export interface TerminalAutoRespondRule {
  pattern: string;
  response: string;
}

export interface TerminalExecuteRequest {
  command: string;
  sessionId?: string;
  context?: TerminalExecutionContext;
  policy?: TerminalExecutionPolicy;
  blockUntilMs?: number;
  autoRespond?: TerminalAutoRespondRule[];
  /** When true (default), sends Ctrl+C to kill the command on timeout. Set false to let it continue in background. */
  killOnTimeout?: boolean;
  /** Pre-computed degradation decision from upstream policy check (action-bridge). Avoids redundant re-evaluation in PTY layer. */
  _degradationDecision?: {
    canDegrade: boolean;
    reason: string;
    sandboxConfig: {
      route: TerminalRoute;
      sandboxLevel: SandboxLevel;
      networkMode?: TerminalNetworkMode;
      denyReadPaths?: string[];
      denyWritePaths?: string[];
      relaxedRules?: string[];
    };
  };
}

export interface TerminalExecuteResponse {
  output: string;
  exitCode: number | null;
  cwd: string;
  backgrounded: boolean;
  timedOut: boolean;
  durationMs: number;
  sessionId?: string;
  /** Rule name when command was blocked by security policy */
  ruleName?: string;
  /** 命令被检测为交互式，降级执行被阻断 */
  interactiveBlocked?: boolean;
  /** 交互式检测的原因描述，用于 HITL 提示 */
  interactiveReason?: string;
  /** 匹配到的交互式命令 */
  matchedCommand?: string;
  /** PTY 输出缓冲区溢出导致截断 */
  outputTruncated?: boolean;
}

export interface TerminalSessionMetadata {
  pid: number | null;
  cwd: string;
  isRunning: boolean;
  lastOutputAt: number;
  lastExitCode: number | null;
  lastCommandCompletedAt: number | null;
  hasPendingCommand: boolean;
}

export interface TerminalReadOutput {
  output: string;
  metadata: TerminalSessionMetadata;
}

export interface TerminalSessionSummary extends TerminalSessionMetadata {
  id: string;
  createdAt: number;
  capabilityFlags?: TerminalCapability[];
}

export interface TerminalRuntimeBridge {
  getCapabilities?: () => TerminalCapability[];
  execute?: (request: TerminalExecuteRequest) => Promise<TerminalExecuteResponse>;
  readOutput?: (
    sessionId: string,
    options?: { tail?: number },
  ) => TerminalReadOutput | null;
  listSessions?: (scope?: { spaceId?: string }) => TerminalSessionSummary[];
  write?: (sessionId: string, data: string) => boolean;
  resolveThreadSession?: (threadId: string) => string | null;
}

export interface PolicyOverrides extends TerminalExecutionPolicy {
  /** Extra deny rules from server-side sandbox policy */
  extraDenyRules?: DenyRule[];
  /** Extra allow rules from server-side sandbox policy */
  extraAllowRules?: AllowRule[];
}

export interface ExecuteOptions {
  command: string;
  mode: TerminalMode;
  sandboxLevel?: SandboxLevel;
  timeoutMs?: number;
  threadId?: string;
  maxOutputBytes?: number;
  /** Explicit working directory override. Takes precedence over workspaceRoot in regular mode. */
  workingDirectory?: string;
  /** Server-side sandbox policy overrides */
  policyOverrides?: PolicyOverrides;
  /**
   * 沙箱逃生舱：当沙箱化命令因沙箱限制失败时，允许返回
   * sandboxFallbackRequested 标记，调用方可据此决定是否在
   * 沙箱外重试（需要用户确认）。不会自动在沙箱外重试。
   */
  fallbackToUnsandboxed?: boolean;
  /**
   * 调用方提供的环境变量。会在 `sanitizeEnv(process.env)` 之后**合并**进
   * 子进程 env —— 调用方传入的同名键覆盖系统继承值，但仍受
   * `DANGEROUS_INJECTION_VARS` / `SENSITIVE_ENV_VARS` 过滤约束（关卡 1
   * 地板要求）。
   *
   * 引入背景：W1.2 接入 BackendSession.exec 的 ExecOptions.env 字段；
   * 此前 SpawnSandboxBackend 已在 ExecuteParams.env 上声明字段但
   * CommandExecutor 不消费——属于 hidden 透传断点。
   *
   * 仅 P0 需要的字段（NativeBackendSession 用）；其余调用点不传，
   * 行为完全等价于原状态（仅 sanitizeEnv(process.env) + 可选 TMPDIR）。
   */
  env?: Record<string, string>;
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  durationMs: number;
  truncated: boolean;
  mode: TerminalMode;
  timedOut: boolean;
  sandboxLevel?: SandboxLevel;
  osSandbox?: boolean;
  /** true when sandbox mode was requested but OS sandbox was unavailable */
  osSandboxDegraded?: boolean;
  /** reason OS sandbox was not available (e.g. bwrap user namespace failure) */
  osSandboxDegradedReason?: string;
  /**
   * 沙箱逃生舱标记：true 表示命令因沙箱限制而失败，
   * 且调用方请求了 fallbackToUnsandboxed，调用方可据此
   * 决定是否在沙箱外重试（需要用户确认）。
   */
  sandboxFallbackRequested?: boolean;
  /** true 表示命令执行受到了沙箱限制（如文件访问被拒、网络不可用） */
  sandboxRestricted?: boolean;
  /** Structured warnings for upstream reporting (e.g. sandbox degradation, unknown relaxed rules) */
  warnings?: string[];
  /** true 表示本应在 PTY 中执行但降级到 CommandExecutor spawn 执行 */
  degraded?: boolean;
  /** 降级原因 */
  degradeReason?: string;
}

export interface StreamingExecuteOptions extends ExecuteOptions {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Streaming-specific timeout override (ms). Falls back to ExecuteOptions.timeoutMs. */
  timeout?: number;
  /**
   * 取消信号 —— 当 `signal.aborted === true` 或后续触发 'abort' 事件，
   * CommandExecutor 立即 SIGTERM（3 秒后 SIGKILL）已 spawn 的子进程；
   * 若在 spawn 前已 abort 则**不**启动子进程，直接返回 timedOut/exitCode != 0
   * 的 ExecuteResult（与 timeout 路径同构）。
   *
   * 引入背景：W1.2 接入 BackendSession.exec 的 ExecOptions.signal 字段；
   * 此前外部唯一取消手段是 `StreamingHandle.kill()`，跨 await 边界使用不便。
   * 添加 signal 后两条路径并存：
   *   - 既有 `handle.kill()` 仍可用于命令式取消（不动现存 26 测试）
   *   - 新 `signal` 用于声明式取消（AbortController.abort()）
   *
   * 已 aborted 的 signal 与 timeout 走同一 SIGKILL + timedOut=true 路径，
   * 字段语义与超时一致，不引入新的 result 字段。
   */
  signal?: AbortSignal;
}

export interface StreamingHandle {
  /** Resolves to ExecuteResult when the command completes. */
  result: Promise<ExecuteResult>;
  /** Sends SIGKILL to the spawned process. */
  kill: () => void;
  /** PID of the spawned process (undefined if spawn failed before assignment). */
  pid: number | undefined;
}

export type CommandDecision = 'allow' | 'deny' | 'ask';

export interface CommandValidationResult {
  allowed: boolean;
  decision: CommandDecision;
  reason?: string;
  ruleName?: string;
}

export interface DenyRule {
  name: string;
  pattern: RegExp;
  reason?: string;
  reasonKey?: string;
}

export interface AllowRule {
  name: string;
  pattern: RegExp;
}

export interface SandboxContext {
  sandboxDir: string;
  projectDir: string;
  tmpDir: string;
}

export interface ExecutorConfig {
  workspaceRoot?: string;
  sandboxRoot?: string;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  /** When true, commands not in allowlist or denylist require user approval */
  requireApproval?: boolean;
}
