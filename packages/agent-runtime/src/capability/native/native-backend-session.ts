/**
 * NativeBackendSession —— 用户绑定设备（Electron / Daemon）的 BackendSession
 * 实装。对应总控 Part 3.3 / M1 §3.2.1 / M2 范围。
 *
 * **职责边界**（M1 §2.3 / 总控 Part 3.4）：
 *   - 做：执行原生操作 + 关卡 1 地板（env-sanitize + 高危命令识别）
 *   - 不做：路径翻译 / 可见性校验 / HITL 审批 / 行为观察 / 幂等保证
 *
 * **关卡 1 地板的"原地复用"**（不复制现有代码）：
 *   - exec → SpawnSandboxBackend（terminal-core）→ CommandExecutor.executeStreaming
 *     → sanitizeEnv + CommandValidator denylist + policy evaluation
 *   - 选择"扩 CommandExecutor 加 env/signal"作为 W1.2 P0 解决路径（选项 A），
 *     而非"NativeBackend 直接 spawn 复制 env-sanitize"（选项 B）—— 选项 A
 *     符合 M1 §2.1 关卡分工原则（"NativeBackend 内嵌关卡 1，原地复用现有
 *     SpawnSandboxBackend / CommandExecutor"）。
 *
 * **read / write 性能 override + 结构化 OS 错误**：
 *   - 默认基类基于 exec 的组合实现，每次 `cat` 一次 spawn ~5-20ms
 *   - Native 走 `@tabtin/safe-fs::safeReadFile / safeWriteFile / safeReadDir
 *     / safeMkdir / safeRm / safeStat / safeAccess`，绕过 spawn 成本
 *     的同时把 macOS TCC 拒绝 / Windows 杀软拦截 / 云盘占位等 OS 级
 *     错误归一成 `OSAccessError`（含 osError 字段）
 *   - 调用链：safe-fs → OSAccessError throw → 现行文件工具 / 目录工具的
 *     handler 用 `isOSError(err) → throw err` 透传 →
 *     `tool-orchestration.maybeBlockToolOnOSError` 写黑名单 + 转结构化
 *     `llm_message`（含中文 user_guidance）给 Agent
 *   - 大文件读写仍由调用方负责流式（M1 不约束，跟基类语义一致）
 *
 * **agentHome 路径计算**（已收敛，不再创建目录）：
 *   - 路径格式 `~/.tabtin/agents/{agentId}/{scratchpad,output,sessions,skills}/`
 *   - 实际工作目录已统一到 Space Sandbox（`agent-spaces/{spaceId}/`）
 *   - agentHome 四分区仅保留路径计算以满足 BackendSession 接口；4 个子目录路径
 *     算出来，**不在构造时全部 mkdir** —— 用户可能创建 1000 个 Agent 但只用
 *     5 个，避免无谓的 inode 浪费
 *   - 4 子目录的 mkdir 推迟到首次 read/write 触碰时由调用方按需做（基类的
 *     `mkdir({ recursive: true })` 通过 exec 路径调用方负责）
 *
 * **不实现持久化（capabilities.supportsPersistence = false）**：
 *   - persistWorkspace / hydrateWorkspace 抛 not supported
 *   - Native 家目录 = 宿主磁盘，本身就持久；W3/W4 的 LocalVM/Cloud Backend
 *     才需要序列化 workspace
 *
 * ─── BackendSession 字段映射表（W1.2 P1 强制要求）────────────────────
 *
 * | BackendSession.ExecOptions       | terminal-core.ExecuteOptions / StreamingExecuteOptions |
 * |----------------------------------|---------------------------------------------------------|
 * | cwd                              | workingDirectory                                        |
 * | env                              | env（W1.2 新增字段）                                     |
 * | timeout                          | timeoutMs（也可用 streaming-only `timeout` 覆盖）        |
 * | signal                           | signal（W2.2.1 P1 (b) 升级为公共字段）                   |
 * | onStdout / onStderr              | onStdout / onStderr（同名同语义）                         |
 * | maxOutputBytes                   | maxOutputBytes（W2.2.1 P1 (b) 端到端透传）               |
 *
 * **W2.2.1 P1 (b) 字段提升说明**：
 *   - signal / maxOutputBytes 已写入 `terminal-core/backend/types.ts::ExecuteParams`
 *     公共接口（不再走 SpawnExecuteParams widening）
 *   - `bootstrapNativeBackend` → `SpawnSandboxBackend.execute` →
 *     `CommandExecutor.executeStreaming` 链路中两字段都端到端透传
 *   - Capability 层可按 tool 调用粒度自己定 maxOutputBytes（如 ShellCap
 *     默认 256KB，比 CommandExecutor 全局 100KB 默认更宽）
 *
 * | BackendSession.ExecResult        | terminal-core.ExecuteResult / BackendExecutionResult    |
 * |----------------------------------|---------------------------------------------------------|
 * | stdout / stderr / exitCode       | 同名同语义                                                |
 * | durationMs                       | 同名同语义                                                |
 * | truncated                        | truncated（W2.2.1 P1 修订：透传，见下文）                |
 * | degraded                         | degraded（osSandboxDegraded / interactiveBlocked 等）     |
 * | fingerprint                      | 不映射（Native 不需要；M3/M4 LocalVM/Cloud 用）          |
 *
 * **W2.2.1 truncated 透传修订**：
 *   - `BackendExecutionResult`（terminal-core/backend/types.ts）已加
 *     可选 `truncated` 字段（与 ExecuteResult.truncated 同义）
 *   - `SpawnSandboxBackend.execute` 把 `executeStreaming` 返回的
 *     `truncated` 字段透传到 `BackendExecutionResult`
 *   - `bootstrapNativeBackend.execImpl` 把它映射到 `ExecResult.truncated`
 *     —— ShellCap.run_terminal_command 等 Capability 真正感知到截断事件，
 *     不再恒 false（与 Review 3 P1 修订一致）
 *
 * | BackendSession 字段名            | terminal-core 字段名（命名差异）                         |
 * |----------------------------------|---------------------------------------------------------|
 * | cwd → workingDirectory           | terminal-core 用 workingDirectory（更长、更显式）         |
 * | timeout → timeoutMs              | terminal-core 用 timeoutMs（带单位前缀）                  |
 *
 * ExecuteResult 的 `timedOut` 字段：BackendSession 不暴露 timedOut，超时
 * 通过 exitCode != 0 + signal abort 路径同构表达。本实装将 `timedOut`
 * **不传染** 到 ExecResult（避免引入新字段）—— 调用方若需要超时识别，
 * 应通过 AbortController + signal.aborted 检查（与 Node fetch / fs 一致）。
 *
 * ─── SpawnSandboxBackend vs BaseBackendSession 抽象映射表（W1.2 P1）─────
 *
 * | SpawnSandboxBackend (terminal-core)         | BaseBackendSession (capability/) | 备注 |
 * |---------------------------------------------|-----------------------------------|------|
 * | execute(params: ExecuteParams)              | exec(command, opts: ExecOptions)  | 字段名映射见上表；返回 BackendExecutionResult ↔ ExecResult |
 * | executeInteractive?(params)                 | execInteractive?(command, opts)   | NativeBackendSession 暂不实现（M2+ 接通） |
 * | cleanup()                                   | shutdown()                         | shutdown 触发 cleanup；多次幂等 |
 * | id: 'local-spawn'                           | sessionId（每 session 独立）        | id 是 backend 类型标识；sessionId 是 session 实例标识 |
 * | capabilities: BackendCapabilities (6 字段)   | capabilities: BackendSessionCapabilities (11 字段) | session 多 5 个：persistence/hibernate/checkpoint/mount/background |
 * | （无对应）                                   | read / write                       | 走 fs.promises 直接调，绕过 spawn |
 * | （无对应）                                   | ls / mkdir / rm / exists / extract / apply_patch | 基类基于 exec 组合实现 |
 * | （无对应）                                   | persistWorkspace / hydrateWorkspace | Native 抛 not supported |
 * | （无对应）                                   | agentHome: AgentHomeLayout         | session 持有四分区路径 |
 * | （无对应）                                   | manifest?: Manifest                | LocalVM / Cloud 持有；Native undefined |
 * | （无对应）                                   | running()                           | 默认 true（Native 进程恒可用） |
 *
 * **不映射的方法**：W2 / W3 实施 Capability 时如果发现需要新的能力，应：
 *   1. 通过 capability/ 模块加新方法（M5 / M8 范围）
 *   2. 不要"复制 SpawnSandboxBackend 接口"——它们是两套独立抽象，重叠是
 *      接口设计的偶合，不是契约
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getHomeTabtinPath } from '../../paths/index.js';

import { isOSError } from '../../engine/errors/os-error-contract.js';
import { BaseBackendSession } from '../base-backend-session.js';
import type {
  AgentHomeLayout,
  BackendSessionCapabilities,
  BackendType,
  ExecOptions,
  ExecResult,
  FileStat,
  SessionPersistState,
} from '../backend-session.js';
import { SessionPersistStateVersionError } from '../errors.js';
import type { SafeFsPort } from './safe-fs-port.js';

/**
 * Native 形态的 BackendSession 能力标记。
 *
 * - supportsInteractive: true —— PTY 可用（execInteractive M2+ 实施）
 * - supportsSandbox: true —— bwrap / sandbox-exec 可选；degraded 标记降级
 * - supportsNetworkIsolation: true —— 网络 namespace 可选
 * - supportsFileSystemIsolation: true —— bind-mount / chroot 可选
 * - latencyClass: 'local' —— 本地 spawn，亚毫秒级
 * - platforms: 三大平台，windowsSandbox 是 fallback
 *
 * - supportsPersistence: false —— 家目录就是宿主磁盘
 * - supportsHibernate: false —— Native 不能挂起付费
 * - supportsCheckpoint: false —— Cloud 独有
 * - supportsMount: false —— LocalVM/Cloud 才需要"挂载外部 NAS"
 * - supportsBackground: false —— M2+ 视 tmux/detached 接入再说
 */
const NATIVE_CAPABILITIES: BackendSessionCapabilities = {
  supportsInteractive: true,
  supportsSandbox: true,
  supportsNetworkIsolation: true,
  supportsFileSystemIsolation: true,
  latencyClass: 'local',
  platforms: ['darwin', 'linux', 'win32'],

  supportsPersistence: false,
  supportsHibernate: false,
  supportsCheckpoint: false,
  supportsMount: false,
  supportsBackground: false,
};

/**
 * NativeBackendSession 构造参数。
 *
 * **execImpl 注入而非硬绑 SpawnSandboxBackend**：
 *   - 解耦测试 —— 测试可注入 mock execImpl，不需要真 spawn
 *   - 解耦未来扩展 —— 关卡 1 地板的实装可换（如未来加 tree-sitter
 *     AST validator），NativeBackendSession 不动
 *   - 类型边界 —— execImpl 返回 BackendSession.ExecResult 形态而非
 *     terminal-core BackendExecutionResult，让映射表显式发生在装配点
 */
export interface NativeBackendSessionInit {
  readonly sessionId: string;
  readonly agentId: string;
  /**
   * agentHome 根目录覆盖。仅供测试 / 容器路径覆盖使用；生产用 default
   * `~/.tabtin/agents/{agentId}/`。
   */
  readonly agentHomeRoot?: string;
  /**
   * 关卡 1 地板的 exec 入口（W1.2 P0 选项 A：扩 CommandExecutor）。
   *
   * 调用方传入 `(cmd, opts) => SpawnSandboxBackend.execute(...)`
   * 的薄 wrapper，把 BackendSession.ExecOptions 字段转成 terminal-core
   * 的 ExecuteParams 并返回 ExecResult 形态。映射表见文件头注释。
   */
  readonly execImpl: (command: string, opts?: ExecOptions) => Promise<ExecResult>;
  /**
   * 文件系统端口（宿主注入 `@tabtin/safe-fs` 或测试 mock）。
   * 生产路径不再硬依赖 safe-fs（ Stage 7a）。
   */
  readonly fs: SafeFsPort;
  /**
   * Optional：自定义 cleanup 钩子（W2 装配 Capability 时可注入"释放
   * SpawnSandboxBackend / 退出 PTY 池"等清理逻辑）。多次幂等。
   */
  readonly onShutdown?: () => Promise<void>;
}

/**
 * agentHome 路径计算（不再创建目录）。
 *
 * 实际 Agent 工作目录已收敛为 Space Sandbox（`agent-spaces/{spaceId}/`），
 * 此函数仅为满足 BackendSession.agentHome 接口约束保留。
 *
 * **路径策略**：
 *   - 默认 `~/.tabtin/agents/{agentId}/{scratchpad,output,sessions,skills}/`
 *   - `agentHomeRoot` 覆盖时使用 `{agentHomeRoot}/{scratchpad,...}`
 *
 * **跨平台兼容**：
 *   - macOS/Linux：`os.homedir()` → `/Users/x` 或 `/home/x`
 *   - Windows：`os.homedir()` → `C:\Users\x`，path.join 自动用 `\`
 *
 * **agentId 校验**：禁止 `..` / `/` / `\` / 空字符串等路径注入字符——
 * 防止恶意 agentId 跳出 agentHome 边界。fail-fast 抛 Error。
 */
function buildAgentHome(
  agentId: string,
  agentHomeRoot?: string,
): AgentHomeLayout {
  if (!agentId || agentId.length === 0) {
    throw new Error('NativeBackendSession: agentId is required');
  }
  // 白名单：字母数字 / `-` / `_` / `.`（与 UUID / hex / nanoid / 形如
  // `agent.v1.user-123` 的产品 id 兼容）。
  //
  // **拒绝**：`/` `\` `..`（独立 `.` 是合法的，但 `..` 路径遍历必须
  // 显式拒绝）+ 空字符 / 控制字符 / 空白。
  //
  // **W1.2 review#1 P2-1 修订**：之前白名单不接受 `.`，与产品中可能
  // 出现的 dotted 命名（如 nanoid + namespace）不兼容。修订后接受 `.`
  // 单字符但显式拒绝 `..` 序列，覆盖路径遍历同时不限制合法 id。
  if (agentId.includes('..')) {
    throw new Error(
      `NativeBackendSession: invalid agentId "${agentId}" — ` +
        `must not contain ".." sequence (path-traversal protection)`,
    );
  }
  if (!/^[A-Za-z0-9_.\-]+$/.test(agentId)) {
    throw new Error(
      `NativeBackendSession: invalid agentId "${agentId}" — ` +
        `must match /^[A-Za-z0-9_.\\-]+$/ (path-traversal protection)`,
    );
  }

  const root = agentHomeRoot ?? getHomeTabtinPath('agents', agentId);

  // 不再创建 Agent Home 根目录。实际工作目录已收敛为
  // Space Sandbox（agent-spaces/{spaceId}/），Agent Home 四分区
  // 只保留路径计算以满足 BackendSession 接口约束。

  return Object.freeze({
    scratchpad: path.join(root, 'scratchpad'),
    output: path.join(root, 'output'),
    sessions: path.join(root, 'sessions'),
    skills: path.join(root, 'skills'),
  });
}

/**
 * NativeBackendSession：用户绑定设备（Electron / Daemon）的实装。
 *
 * 装配示例（宿主 createSession 时）：
 *
 * ```ts
 * const sandbox = new SpawnSandboxBackend(commandExecutor);
 * const session = new NativeBackendSession({
 *   sessionId,
 *   agentId,
 *   execImpl: async (command, opts) => {
 *     const r = await sandbox.execute({
 *       command,
 *       cwd: opts?.cwd ?? session.agentHome.scratchpad,
 *       env: opts?.env,
 *       timeout: opts?.timeout,
 *       signal: opts?.signal,
 *       onStdout: opts?.onStdout,
 *       onStderr: opts?.onStderr,
 *     });
 *     return {
 *       stdout: r.stdout, stderr: r.stderr,
 *       exitCode: r.exitCode, durationMs: r.durationMs,
 *       degraded: r.degraded || undefined,
 *     };
 *   },
 * });
 * ```
 */
export class NativeBackendSession extends BaseBackendSession {
  readonly sessionId: string;
  readonly backendType: BackendType = 'local' as const;
  readonly capabilities: BackendSessionCapabilities = NATIVE_CAPABILITIES;
  readonly agentHome: AgentHomeLayout;

  private readonly execImpl: NativeBackendSessionInit['execImpl'];
  private readonly fs: SafeFsPort;
  private readonly onShutdown?: () => Promise<void>;
  private shutdownCalled = false;

  constructor(init: NativeBackendSessionInit) {
    super();
    this.sessionId = init.sessionId;
    this.agentHome = buildAgentHome(init.agentId, init.agentHomeRoot);
    this.execImpl = init.execImpl;
    this.fs = init.fs;
    this.onShutdown = init.onShutdown;
  }

  // ── 6 个抽象方法实装 ─────────────────────────────────────────────

  /**
   * 执行命令 —— 直接转交 execImpl（关卡 1 地板的薄 wrapper）。
   *
   * 不在此处做任何字段重命名 / 默认值 fallback —— 那都是装配点
   * （execImpl wrapper）的职责。session 层语义是"接口契约的薄层
   * 适配器"，不持任何业务策略。
   */
  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    return await this.execImpl(command, opts);
  }

  /**
   * 读文件 —— 走注入的 `SafeFsPort.readFile`（宿主通常接 safe-fs），
   * 让 macOS TCC / Windows 杀软 / 云盘占位等归一为带 `osError` 的错误。
   * 上层经 `isOSError` 写黑名单并渲染 `llm_message`。
   */
  async read(path: string): Promise<Buffer> {
    return await this.fs.readFile(path);
  }

  /**
   * 写文件 —— 覆盖语义；父目录不存在 / 权限不足等由 fs 端口归一抛错。
   */
  async write(filePath: string, data: Buffer | string): Promise<void> {
    await this.fs.writeFile(filePath, data);
  }

  /**
   * Native session 是否仍可用于 exec —— 与 shutdown 状态联动。
   *
   * - 未 shutdown / shutdown 进行中 → true
   * - 已完成 shutdown → false
   *
   * **W1.2 review#1 P1-1 修订**：之前实现 shutdown 后仍恒返 true，与
   * 接口契约「`running()` 表示 session 是否仍能接受 exec」不一致 ——
   * Capability 用 `if (!session.running()) skip()` 做门闸时会误判。
   * 修订后语义与 BaseBackendSession 接口约定（shutdown 后不应再 exec）
   * 显式联动；Capability 可以安全地用 running() 做"会话存活"判断。
   */
  async running(): Promise<boolean> {
    return !this.shutdownCalled;
  }

  /**
   * Native 不需要持久化 —— 家目录就是宿主磁盘，本身就是持久化的。
   *
   * 与 capabilities.supportsPersistence === false 配套：调用方应用
   * 能力标记决策"是否调用"，不应该走到这里。万一调用就抛
   * SessionPersistStateVersionError 的子类（独立 not-supported 错误，
   * 跟版本错误显式区分语义）。
   */
  async persistWorkspace(): Promise<SessionPersistState> {
    throw new NativeBackendSessionUnsupportedError(
      'persistWorkspace not supported on native backend (use capabilities.supportsPersistence to gate)',
    );
  }

  async hydrateWorkspace(_state: SessionPersistState): Promise<void> {
    throw new NativeBackendSessionUnsupportedError(
      'hydrateWorkspace not supported on native backend (use capabilities.supportsPersistence to gate)',
    );
  }

  // ── 性能 override：fs.promises 替代基类 exec 组合 ─────────────────

  /**
   * 列目录 —— 走 `safeReadDir`，避免 `ls -1a` spawn ~5-20ms 同时把
   * EPERM/EACCES 归一成 OSAccessError（macOS Desktop / Documents 未
   * 授权时 readdir 直接抛 EPERM，归类后 Agent 拿到结构化 user_guidance）。
   *
   * 与基类组合实现的语义对齐：
   *   - **不含** `.` 与 `..`（fs.readdir 默认行为）
   *   - 路径不存在 → OSError(TARGET_NOT_FOUND)
   *   - 权限不足 → OSError(OS_PERMISSION_DENIED)
   */
  async ls(filePath: string): Promise<string[]> {
    return await this.fs.readDir(filePath);
  }

  /**
   * 创建目录 —— recursive 透传；权限错由 fs 端口归一。
   */
  async mkdir(dirPath: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.fs.mkdir(dirPath, { recursive: opts?.recursive ?? false });
  }

  /**
   * 删除文件 / 目录 —— recursive / force 透传；真实权限错不得被 force 掩盖。
   */
  async rm(
    filePath: string,
    opts?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    await this.fs.rm(filePath, {
      recursive: opts?.recursive ?? false,
      force: opts?.force ?? false,
    });
  }

  /**
   * 路径是否存在 —— 走 `safeAccess`。
   *
   * **与基类语义偏差（Wave 1 第二轮 Review M-4 修订）**：
   *   基类 `BaseBackendSession.exists` 走 `test -e`，权限拒绝 (EACCES) 时
   *   exit code 也是 1，被视为"不存在"。这条 POSIX 契约**对 LLM 不友好**：
   *   - LLM 调 `exists('/Users/foo/Desktop')` 因 TCC 拒绝拿到 false → 推断
   *     "Desktop 不存在" → 调 `mkdir('/Users/foo/Desktop')` 想创建 →
   *     mkdir 才真抛 OSError 进黑名单 → 中间多一步歧途，LLM 给用户的
   *     解释会变成"我以为 Desktop 不存在……"
   *
   *   NativeBackendSession 比基类**信息量更大**（safe-fs 能区分 ENOENT
   *   vs EPERM/EACCES），应当传递这一信息，而不是被 POSIX `test -e` 的
   *   损失语义拖累。
   *
   * **修订语义**：
   *   - `TARGET_NOT_FOUND`（路径真的不存在）→ false（与"我没找到"对齐）
   *   - 任何其他 OSError（OS_PERMISSION_DENIED / OS_AV_BLOCKED 等）→ 抛
   *     OSAccessError 透传，让上层（FileSystemCap / 业务代码）按结构化错误处理
   *   - 非 OSError 异常 → false 兜底（与原行为兼容）
   *
   * **当前调用方**：Wave 1 第二轮时，agent-runtime 内仅 native-backend-session
   * 测试用本方法。FileSystemCap 不暴露 exists 工具。改动不破坏现有生产路径。
   */
  async exists(filePath: string): Promise<boolean> {
    try {
      await this.fs.access(filePath, fs.constants.F_OK);
      return true;
    } catch (err) {
      if (isOSError(err)) {
        if (err.osError.code === 'TARGET_NOT_FOUND') {
          return false;
        }
        throw err;
      }
      return false;
    }
  }

  /**
   * 文件元信息 —— 仅暴露 isFile / isDirectory / size / mtimeMs。
   */
  async stat(filePath: string): Promise<FileStat> {
    const s = await this.fs.stat(filePath);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  }

  /**
   * 主动关闭并释放资源 —— 多次幂等。
   *
   * 调用 onShutdown 钩子（W2 装配点可注入清理逻辑），不抛错（best-effort
   * 清理；个别钩子失败记录但不阻断）。
   */
  override async shutdown(): Promise<void> {
    if (this.shutdownCalled) return;
    this.shutdownCalled = true;
    if (this.onShutdown) {
      try {
        await this.onShutdown();
      } catch {
        // Best-effort：shutdown 由 finally / GC / hot-reload 触发，
        // 抛错会破坏调用方上层的清理流程。失败时不抛，让调用方
        // 通过 telemetry 自行观察（M6 Harness 范围）。
      }
    }
  }
}

/**
 * NativeBackendSession 不支持的操作（持久化 / 休眠 / 克隆等）。
 *
 * 与 SessionPersistStateVersionError 的语义区分：
 *   - 版本错误 → 数据格式问题（schemaVersion mismatch）
 *   - Unsupported → 该 Backend 形态根本不实现这个能力（结构性边界）
 *
 * 之所以不复用 SessionPersistStateVersionError：测试 / 调用方做"is it a
 * version mismatch?"判定时希望严格区分两类错误。统一一个 Error 子类
 * 会让 catch 逻辑 fragile。
 */
export class NativeBackendSessionUnsupportedError extends Error {
  override readonly name = 'NativeBackendSessionUnsupportedError';
  constructor(message: string) {
    super(message);
  }
}

// 显式 re-export：W2 实施 Capability 时方便 catch 准确类型。
export { SessionPersistStateVersionError };
