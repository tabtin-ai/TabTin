import type { TerminalExecutionPolicy } from '../types';

// ── Capability descriptors ──────────────────────────────────────────

export type LatencyClass = 'local' | 'remote';
export type PlatformType = 'darwin' | 'linux' | 'win32';

export interface BackendCapabilities {
  supportsInteractive: boolean;
  supportsSandbox: boolean;
  supportsNetworkIsolation: boolean;
  supportsFileSystemIsolation: boolean;
  latencyClass: LatencyClass;
  platforms: PlatformType[];
}

// ── Execute params & result ─────────────────────────────────────────

export interface ExecuteParams {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
  policy?: TerminalExecutionPolicy;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /**
   * 取消信号 —— `signal.aborted === true` 或后续触发 'abort' 事件时，
   * Backend 实现应立即终止已 spawn 的子进程（SIGTERM 后短超时升级 SIGKILL）。
   *
   * **W2.2.1 P1 (b) 修订**：原本通过 `SpawnSandboxBackend` 内部
   * `SpawnExecuteParams` 类型 widening 隐式接受，导致：
   *   - 公共 ExecuteParams 接口看不见 signal，下游消费方（host-bootstrap.ts）
   *     必须用 `as Parameters<...>` 断言才能透传
   *   - 类型层面的"hidden 字段"长期是维护陷阱
   *
   * 提升到公共字段后，所有 ExecutionBackend 实现都"知道有 signal 这回事"，
   * 即使不实现也应在文档中说明（默认行为：signal 被忽略，调用方应通过
   * capabilities 标记判断是否走 cancellation 路径）。
   */
  signal?: AbortSignal;
  /**
   * 输出字节上限 —— 超出时 Backend 应在返回 BackendExecutionResult 前
   * 截断 stdout/stderr，并通过实现私有方式（例如 warnings 或扩展字段）
   * 告知调用方"已截断"。
   *
   * **W2.2.1 P1 (b) 修订**：原本仅 `CommandExecutor` 自身有
   * `defaultMaxOutputBytes` 全局默认（100KB），ExecuteParams 不暴露
   * per-call 字段；W2 ShellCap / SkillsCap 需要按 tool 调用粒度截断
   * 时无法透传，必须在 Capability handler 层手动 slice。
   *
   * 提升到公共字段并在 SpawnSandboxBackend 实装链路里透传到
   * `executeStreaming` 后，Capability 写者可以直接传 `maxOutputBytes`。
   */
  maxOutputBytes?: number;
}

export interface BackendExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  backendId: string;
  sandboxApplied: boolean;
  degraded: boolean;
  warnings: string[];
  /**
   * 输出是否因 maxOutputBytes 被截断 —— 与 ExecuteResult.truncated 同义。
   *
   * **W2.2.1 修订**：W1.2 时期 BackendExecutionResult 没有此字段，
   * `SpawnSandboxBackend` 也不透传 `executeStreaming` 返回的 truncated；
   * Capability 层（ShellCap）声明 `truncated` 字段时永远拿不到 true。
   * 提升为公共字段后所有 ExecutionBackend 实现都可显式声明截断状态，
   * Capability handler 把它写入 tool result JSON 让 LLM 自决是否分页拉取。
   */
  truncated?: boolean;
}

// ── Interactive session ─────────────────────────────────────────────

export interface InteractiveSession {
  readonly sessionId: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(callback: (data: string) => void): void;
  kill(signal?: string): void;
  waitForExit(): Promise<{ exitCode: number }>;
}

// ── Backend contract ────────────────────────────────────────────────

export interface ExecutionBackend {
  readonly id: string;
  readonly capabilities: BackendCapabilities;
  execute(params: ExecuteParams): Promise<BackendExecutionResult>;
  executeInteractive?(params: ExecuteParams): Promise<InteractiveSession>;
  cleanup(): Promise<void>;
}

// ── Factory & config ────────────────────────────────────────────────

export interface BackendConfig {
  sandboxRoot?: string;
  projectRoot?: string;
  workingDirectory?: string;
  [key: string]: unknown;
}

export interface BackendFactory {
  create(config: BackendConfig): Promise<ExecutionBackend>;
}

export interface BackendResolveConfig {
  preferInteractive?: boolean;
  requireSandbox?: boolean;
  requireNetworkIsolation?: boolean;
  platform?: PlatformType;
}
