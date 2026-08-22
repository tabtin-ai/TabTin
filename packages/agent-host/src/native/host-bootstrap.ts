/**
 * NativeBackendSession 宿主装配辅助 —— W1.2 让两宿主真接入
 * `ExecutionBackendRegistry`。
 *
 *  Stage 6d：自 `@tabtin/agent-runtime/capability/native` 迁入
 * agent-host（装配属宿主职责；runtime 不再依赖 `@tabtin/terminal-core`）。
 *
 * **设计目标**：两宿主（ElectronAgentHost / DaemonAgentHost）共享同一份
 * 装配代码，避免"Electron 写一遍、Daemon 写一遍"的飘移。
 *
 * **职责**：
 *   1. 创建并填充 `ExecutionBackendRegistry`（注册 SpawnSandboxBackendFactory）
 *   2. 通过 `registry.resolve(...)` 取出 ExecutionBackend（默认 'local-spawn'）
 *   3. 用 ExecutionBackend 封装出 BackendSession.exec 的 wrapper（关卡 1
 *      地板的薄层 adapter，把 BackendSession.ExecOptions 字段转成
 *      terminal-core ExecuteParams）
 *   4. 实例化 NativeBackendSession 并返回（包括 registry 引用 + cleanup hook）
 *
 * **不做**：
 *   - 不动 EngineConfig / query.ts / middleware（强制底线）
 *   - 不替换两宿主现有的 PtyManager / FrontendActionBridge 路径——它们继续
 *     服务终端 UI / 工具调用旧路径；NativeBackendSession 只是新增的"BackendSession
 *     接口契约的入口"，给 W2 Capability 用，老路径 0 破坏
 *   - 不持有 EngineConfig / engineConfig 字段——session 是装配产物，
 *     query.ts 仍然不知道它的存在
 *
 * **feature flag**（破坏性回退）：宿主可在 createSession 之前检查
 * 环境变量 `TABTIN_NATIVE_BACKEND_SESSION`：
 *   - 默认 / 'enabled' → 装配 NativeBackendSession（W1.2 期望路径）
 *   - 'disabled' → 跳过装配，给 W2 实施期间出现回归提供 escape hatch
 *
 * **不做的 feature flag**：env 变量不影响 query.ts 或 middleware ——
 * runtime 主路径行为完全不变（NativeBackendSession 还没有任何消费者）。
 */

import type {
  ExecutionBackend,
  ExecutionBackendRegistry as _ExecutionBackendRegistry,
} from '@tabtin/terminal-core';
import {
  CommandExecutor,
  ExecutionBackendRegistry,
  SpawnSandboxBackendFactory,
  SPAWN_SANDBOX_BACKEND_CAPABILITIES,
} from '@tabtin/terminal-core';
import {
  safeAccess,
  safeMkdir,
  safeReadDir,
  safeReadFile,
  safeRm,
  safeStat,
  safeWriteFile,
} from '@tabtin/safe-fs';

import { NativeBackendSession } from '@tabtin/agent-runtime/capability/native';
import type { ExecOptions, ExecResult } from '@tabtin/agent-runtime/capability';

/**
 * Native backend 工厂在 Registry 中的固定 id —— 与 SpawnSandboxBackend.id
 * 对齐（terminal-core 的 backend id），让"按 id 查询"路径稳定。
 *
 * 暴露常量而非硬编码字符串：避免下游 tooling 用裸字符串引用导致改名时
 * 找不到所有引用。
 */
export const NATIVE_BACKEND_ID = 'local-spawn';

/**
 * Bootstrap 配置 —— 宿主在 createSession 时按需提供。
 *
 * 关键字段含义：
 *   - sessionId / agentId：从 session 上下文继承
 *   - workspaceRoot：CommandExecutor 的根目录（影响 sandbox path）
 *   - registry?：宿主可选传入已有 registry（一份 registry 服务多 session
 *     时复用同一份 SpawnSandboxBackend 实例 —— ExecutionBackendRegistry
 *     内部已实现"factory 第一次 resolve 时实例化，后续 resolve 复用"）
 *   - agentHomeRoot?：覆盖默认 `~/.tabtin/agents/{agentId}/` 路径（仅测试用）
 *   - sandboxRoot?：CommandExecutor 沙箱根目录（默认 `~/.tabtin/sandbox`）
 */
export interface NativeBackendBootstrapInit {
  readonly sessionId: string;
  readonly agentId: string;
  readonly workspaceRoot?: string;
  readonly sandboxRoot?: string;
  readonly registry?: ExecutionBackendRegistry;
  readonly agentHomeRoot?: string;
}

/**
 * Bootstrap 输出 —— 宿主拿这个对象在 RuntimeBundle 里持有。
 *
 * **registry 暴露**给宿主以便：
 *   - 后续不同形态 backend（cloud / localvm）可被同一 registry 注册
 *   - 测试可注入 fake backend
 *
 * **session.shutdown()** 时由宿主调用 `disposeRegistry()` 清理底层
 * SpawnSandboxBackend / CommandExecutor。
 */
export interface NativeBackendBootstrapResult {
  readonly session: NativeBackendSession;
  readonly registry: ExecutionBackendRegistry;
  readonly backend: ExecutionBackend;
  /** 主动清理 registry（调用方应在 session.shutdown 后调用） */
  readonly disposeRegistry: () => Promise<void>;
}

/**
 * 装配 NativeBackendSession + ExecutionBackendRegistry —— 同步 API
 * 简化两宿主的 await 链路（CommandExecutor / SpawnSandboxBackend 实例
 * 化都是同步的）。
 *
 * 工作流程：
 *   1. 取 / 建 ExecutionBackendRegistry
 *   2. 注册 SpawnSandboxBackendFactory（包装一个 fresh CommandExecutor）
 *   3. resolve 出 ExecutionBackend（兼容：宿主可能已经先注册过相同 id）
 *   4. 用 ExecutionBackend.execute 实现 NativeBackendSession.execImpl 的
 *      字段映射（BackendSession.ExecOptions → terminal-core ExecuteParams）
 *   5. 返回 session / registry / backend / dispose
 *
 * **W1.2 字段映射表**（与 native-backend-session.ts 文件头表对应；
 * 装配点是字段名翻译的唯一发生地）：
 *
 *   BackendSession.ExecOptions    →  terminal-core ExecuteParams
 *   ───────────────────────────────  ─────────────────────────────
 *   cwd                            →  cwd（spawn-sandbox 名称对齐）
 *   env                            →  env
 *   timeout                        →  timeout
 *   signal                         →  signal（公共字段；W2.2.1 P1 (b) 提升）
 *   maxOutputBytes                 →  maxOutputBytes（公共字段；W2.2.1 P1 (b) 提升）
 *   onStdout / onStderr            →  onStdout / onStderr
 *
 * **W2.2.1 P1 (b) 修订**：signal / maxOutputBytes 已是 ExecuteParams
 * 公共字段（非 widening）—— wrapper 直接构造对象传入，不再使用
 * `as Parameters<...>` 断言。两条字段都端到端透传到 CommandExecutor
 * 的 executeStreaming 路径。
 */
export async function bootstrapNativeBackend(
  init: NativeBackendBootstrapInit,
): Promise<NativeBackendBootstrapResult> {
  const registry = init.registry ?? new ExecutionBackendRegistry();

  // 仅在 registry 还没有 'local-spawn' 时注册 —— 让多 session 共用同一份
  // CommandExecutor + SpawnSandboxBackend 池（factory 第一次 resolve 时
  // 才真实例化）。
  const alreadyRegistered = registry.list().some((e) => e.id === NATIVE_BACKEND_ID);
  if (!alreadyRegistered) {
    const executor = new CommandExecutor({
      workspaceRoot: init.workspaceRoot,
      sandboxRoot: init.sandboxRoot,
    });
    const factory = new SpawnSandboxBackendFactory(executor);
    // W1.2 review#3 P1-2 修订：不再复述 capabilities，从 terminal-core
    // 暴露的 SPAWN_SANDBOX_BACKEND_CAPABILITIES 单源常量取，避免改一处
    // 漏改另一处导致 register 与 instance.capabilities 漂移。
    registry.register(NATIVE_BACKEND_ID, factory, SPAWN_SANDBOX_BACKEND_CAPABILITIES);
  }

  const backend = await registry.get(NATIVE_BACKEND_ID);
  if (!backend) {
    // 防御性：register 后立即 get 应该一定命中；这里只是兜底。
    throw new Error(
      `bootstrapNativeBackend: failed to resolve backend "${NATIVE_BACKEND_ID}" — ` +
        `registry contents: ${registry.list().map((e) => e.id).join(', ')}`,
    );
  }

  // W1.2 P1 (d) 修复 / W2.3 收尾：per-session workspaceRoot 闭包捕获。
  //
  // **问题**：上方 `if (!alreadyRegistered)` 让多 session 共用同一个
  // CommandExecutor + SpawnSandboxBackend；但 CommandExecutor 的
  // `workspaceRoot` 是 ctor 一次性写入的——多 Space 并行时第二个 session
  // 注册被跳过 → 它的 init.workspaceRoot 永远不会替换全局 executor 的
  // workspaceRoot → 调 `session.exec(cmd)` 不带 cwd 时全部走第一个 session
  // 的 workspaceRoot，多 Space 串扰（详见 W1.2 独立验证 P1）。
  //
  // **修法**：把 init.workspaceRoot 闭包捕获到 execImpl wrapper，每次调
  // backend.execute 时若 opts.cwd 缺省，用本 session 的 workspaceRoot
  // 兜底——而非依赖 CommandExecutor 的全局值。这让多 session 即便共用
  // 同一个 SpawnSandboxBackend，也各走各的 cwd，不再串扰。
  //
  // 与 ShellCap.run_terminal_command 的 `context.workspaceRoot ?? ''` fallback
  // 在不同链路兜底：Cap 层是"工具上下文优先"，Backend 层是"session 装配
  // 时锁定的根目录"——双层兜底覆盖宿主任意调用点。
  const sessionWorkspaceRoot = init.workspaceRoot;

  // execImpl wrapper —— 字段名映射的唯一发生地。
  const execImpl = async (command: string, opts?: ExecOptions): Promise<ExecResult> => {
    // 把 BackendSession.ExecOptions 翻译成 terminal-core ExecuteParams。
    // W2.2.1 P1 (b)：signal / maxOutputBytes 已经提升到 ExecuteParams 公共
    // 字段，不再走 widening 类型 + `as` 断言路径。所有字段一次性结构化构造。
    //
    // W2.3：cwd 优先级 = `opts.cwd`（Cap 入参）→ `sessionWorkspaceRoot`（per-session
    // 装配期闭包）→ `''`（让 backend / CommandExecutor fallback 用进程 cwd）。
    const r = await backend.execute({
      command,
      cwd: opts?.cwd ?? sessionWorkspaceRoot ?? '',
      env: opts?.env,
      timeout: opts?.timeout,
      signal: opts?.signal,
      maxOutputBytes: opts?.maxOutputBytes,
      onStdout: opts?.onStdout,
      onStderr: opts?.onStderr,
    });

    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      degraded: r.degraded || undefined,
      // W2.2.1 修订：透传 BackendExecutionResult.truncated 到
      // BackendSession.ExecResult.truncated —— Capability 层（ShellCap）
      // 才能在 tool result JSON 里如实暴露 "truncated: true"。
      truncated: r.truncated || undefined,
    };
  };

  const session = new NativeBackendSession({
    sessionId: init.sessionId,
    agentId: init.agentId,
    agentHomeRoot: init.agentHomeRoot,
    execImpl,
    fs: {
      readFile: (p) => safeReadFile(p),
      writeFile: (p, data) => safeWriteFile(p, data),
      readDir: (p) => safeReadDir(p),
      mkdir: (p, opts) => safeMkdir(p, opts),
      rm: (p, opts) => safeRm(p, opts),
      access: (p, mode) => safeAccess(p, mode),
      stat: (p) => safeStat(p),
    },
    onShutdown: async () => {
      // session 关闭时不主动 dispose 整个 registry —— registry 可能服务
      // 多个 session（同 agent / 多 session 并存）。Registry 的清理交给
      // 宿主在 host 退出时调用 disposeRegistry()。
    },
  });

  return {
    session,
    registry,
    backend,
    disposeRegistry: async () => {
      await registry.dispose();
    },
  };
}

/**
 * 检查环境变量是否禁用 NativeBackendSession 装配。
 *
 * 默认开启（W1.2 期望路径）；env 显式取以下值之一时跳过装配 ——
 * 让两宿主在 W2 实施期间出现回归时有 escape hatch：
 *
 *   `disabled` / `0` / `false` / `off` / `no` / `n`
 *
 * **W1.2 review#1 P1-2 修订**：之前只接受 `disabled` / `0` / `false` /
 * `off`；运维口语习惯写 `no` 时会落到"开启"分支，与心智不符。
 * 接受 `no` / `n` + trim 空格之后符合常见环境变量约定。
 */
export function isNativeBackendSessionEnabled(
  envVal: string | undefined = process.env.TABTIN_NATIVE_BACKEND_SESSION,
): boolean {
  if (envVal === undefined) return true;
  const v = envVal.trim().toLowerCase();
  if (v === '') return true;
  return (
    v !== 'disabled' &&
    v !== '0' &&
    v !== 'false' &&
    v !== 'off' &&
    v !== 'no' &&
    v !== 'n'
  );
}
