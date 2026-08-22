/**
 * BackendSession 接口与配套类型 —— 对应 M1 §3.2.1 / 总控 Part 3.3.2。
 *
 * **职责边界**（详见 M1 §2.3）：
 *   - 做：执行原生操作 + 关卡 1 地板（env-sanitize + 高危命令识别）
 *   - 不做：路径翻译 / 可见性校验 / HITL 审批 / 行为观察 / 幂等保证
 *
 * **设计决策**：
 *   - 定义在 `agent-runtime/capability/` 而非 `terminal-core/backend/`
 *     —— 避免循环依赖（现有 terminal-core 反向依赖 agent-runtime）
 *   - 子类应 extends `BaseBackendSession`（见 base-backend-session.ts）
 *     而非直接 implements，以复用基类提供的 `ls/mkdir/rm/exists/extract/apply_patch`
 *     组合实现
 *   - `BackendType` union 使用产品语义命名 `'local' | 'cloud'`（D2 拍板）
 *     —— LocalVM 在阶段 3 作为 'local' 子配置加，本期不预留独立 'localvm'
 *     顶层值
 */

import type { Manifest } from './manifest.js';

/**
 * Backend 类别 —— 产品语义的两选枚举。
 *
 * **D2（2026-04-27）**：TabTin 产品语义只有"local（用户绑定设备，含
 * 现 Native + 阶段 3 LocalVM）"和"cloud（云端 ACS sandbox）"两选。
 * 不预留独立 'localvm' 顶层值 —— LocalVM 是 'local' 的内部子配置。
 *
 * 类型扩展不通过加 union 项（'docker' / 'ssh' / 'webcontainer' 等）来
 * 解决；而是在 'local' 内通过 `BackendSessionCapabilities` 字段做能力
 * 判断（参见下面的 `supportsHibernate / supportsCheckpoint / supportsMount`）。
 * 这样上层 Capability 代码用 `if (session.capabilities.supportsX) ...`
 * 判断，**不依赖 backendType 字符串硬编码**，未来加新 Backend 零改动。
 */
export type BackendType = 'local' | 'cloud';

/**
 * Backend 能力标记 —— 扩展现有 `packages/terminal-core/src/backend/types.ts`
 * 的 `BackendCapabilities`。
 *
 * Capability 必须用 `if (session.capabilities.supportsInteractive) ...`
 * 做能力判断，**禁止**用 `if (session.backendType === 'local') ...`
 * 硬编码枚举（详见上文 BackendType 注释）。
 */
export interface BackendSessionCapabilities {
  // ── 现有（对齐 terminal-core/BackendCapabilities）──────────────────
  /** 支持 PTY 交互式 session（影响 execInteractive 是否可用） */
  supportsInteractive: boolean;
  /** 支持 OS 级沙箱（macOS sandbox-exec / linux landlock 等） */
  supportsSandbox: boolean;
  /** 支持网络隔离（namespace / VPC） */
  supportsNetworkIsolation: boolean;
  /** 支持文件系统隔离（namespace / chroot / bind-mount workspace） */
  supportsFileSystemIsolation: boolean;
  /** 延迟分级 —— 影响 Capability 是否做批量优化 */
  latencyClass: 'local' | 'remote';
  /** 平台分布；'cloud' 用于云端 sandbox（与 backendType='cloud' 配套） */
  platforms: ('darwin' | 'linux' | 'win32' | 'cloud')[];

  // ── M1 新增（总控 Part 3.3.2）─────────────────────────────────────
  /** 支持跨 Run 持久化 workspace（LocalVM / Cloud 子能力） */
  supportsPersistence: boolean;
  /** 支持 hibernate 零费休眠（Cloud 独有 / ACS 特性） */
  supportsHibernate: boolean;
  /** 支持 checkpoint 克隆（Cloud 子 Agent 并行场景） */
  supportsCheckpoint: boolean;
  /** 支持挂载外部存储（LocalVM 授权挂载 / Cloud NAS） */
  supportsMount: boolean;
  /** 支持后台任务执行（M2+ 可选：tmux / detached / ACS async） */
  supportsBackground: boolean;
}

/**
 * Agent 家目录的四分区路径（已收敛，仅保留接口兼容）。
 *
 * 实际 Agent 工作目录已统一到 Space Sandbox（`agent-spaces/{spaceId}/`），
 * 该目录按 Space 维度管理 skills / downloads / sites 等。
 *
 * AgentHomeLayout 仅在 NativeBackendSession 中计算路径（不再创建目录），
 * 保留以满足 BackendSession 接口约束。未来在接口重构时可移除。
 */
export interface AgentHomeLayout {
  /** 临时草稿区，session 结束 7 天后清理 */
  readonly scratchpad: string;
  /** 交付物目录，永久（用户在 UI"产出"视图能看到） */
  readonly output: string;
  /** session 历史目录（messages.jsonl / events.jsonl 等） */
  readonly sessions: string;
  /** Agent 可用 skill 库 */
  readonly skills: string;
}

/**
 * exec 命令的参数。除 `command` 外全部 optional —— 调用者按需提供。
 *
 * **关卡 1 地板要求**（M1 §3.2.1）：Backend 实现内部必须：
 *   1. 用 env-sanitize 过滤 30+ 个危险环境变量（复用 packages/env-sanitize）
 *   2. 通过 CommandValidator + denylist 做高危命令识别
 *   命中降级时 ExecResult.degraded = true。
 */
export interface ExecOptions {
  /** 默认 agentHome.scratchpad；Native 全盘可见时可指定任意路径 */
  cwd?: string;
  /** 环境变量（关卡 1 env-sanitize 后合并到子进程） */
  env?: Record<string, string>;
  /** 超时毫秒数 */
  timeout?: number;
  /** 取消信号；超时与外部 kill 都通过此触发 */
  signal?: AbortSignal;
  /** 流式 stdout 回调（每 chunk 触发一次） */
  onStdout?: (chunk: string) => void;
  /** 流式 stderr 回调 */
  onStderr?: (chunk: string) => void;
  /** 输出字节上限；超出则截断并 ExecResult.truncated = true */
  maxOutputBytes?: number;
}

/**
 * exec 命令的返回值。
 *
 * **stdout / stderr 字段语义**：截断后的最终缓冲，与 onStdout/onStderr
 * 流式回调"已收到全部"等价（截断也是"全部已知"）。Capability 应用
 * truncated 字段判定是否需要追问"剩余输出在哪"。
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  /** 输出超 maxOutputBytes 被截断 */
  truncated?: boolean;
  /**
   * Native 特有：高危命令降级标记（例如 `rm -rf /` 被 sandbox 拒绝转
   * 普通子进程，或 sandbox-exec 不可用导致回退到 unconfined 子进程）。
   * 其他 Backend 通常恒为 undefined。
   */
  degraded?: boolean;
  /**
   * Optional（M1 延期）：workspace snapshot 指纹，用于 resume 时判断
   * 是否可跳过 restore。
   * Native Backend 不用；LocalVM / Cloud 按需实现（M3/M4 范围）。
   */
  fingerprint?: string;
}

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

/**
 * PTY 交互式会话 —— Backend 按 capabilities.supportsInteractive 决定
 * 是否提供 execInteractive 实现（optional method）。
 *
 * 语义对齐现有 `packages/terminal-core/src/backend/types.ts::InteractiveSession`，
 * **保留 sessionId 字段名**（对齐 W0-A 子 Agent 1 发现 —— 现有 26 个
 * terminal-core 测试与 PtyManager 调用点都依赖此命名）。
 */
export interface InteractiveSession {
  readonly sessionId: string;
  /** 写入键盘输入；常用于 vim / interactive prompt */
  write(data: string): void;
  /** 调整 PTY 窗口大小 */
  resize(cols: number, rows: number): void;
  /** 注册 stdout/stderr 输出回调；多次调用追加多个监听 */
  onData(cb: (chunk: string) => void): void;
  /** 发送信号杀掉子进程 */
  kill(signal?: string): void;
  /** 等待退出，返回退出码 */
  waitForExit(): Promise<{ exitCode: number }>;
}

/**
 * Backend 暴露给 Capability 的统一会话抽象（接口契约）。
 *
 * **使用约定**：
 *   - 子类应 `extends BaseBackendSession`（见 base-backend-session.ts），
 *     而不是直接 implements 本接口 —— 基类提供 `ls/mkdir/rm/exists`
 *     的 exec 组合实现，子类只需 6 个抽象方法。
 *   - **`apply_patch` / `extract` 是 BaseBackendSession 的便利方法，
 *     不在本接口契约中** —— Capability tool handler 不能假设 `session.apply_patch`
 *     存在；如需 apply_patch 工具，handler 应自己组合 `read + diff + write`，
 *     或在内部断言 session 是 BaseBackendSession 实例后调用便利方法。
 *     之所以不放进 interface：Cloud Backend 可能用 ACS patch API 而非
 *     本地 diff，强行约束接口会造成"假实现"。
 *
 * **职责边界**（详见 M1 §2.3）：
 *   - 做：执行原生操作 + 关卡 1 地板（env-sanitize + 高危命令识别）
 *   - 不做：路径翻译 / 可见性校验 / HITL 审批 / 行为观察 / 幂等保证
 *
 * **不持有的字段（重要）**：
 *   - **不持** `effectivePolicy` / `operation_switches` 等策略快照 —— 这些是
 *     外层 v3 judge() 的输入，由宿主在 EngineConfig 装配时单独注入，
 *     **不通过 session 流转**。
 *   - **不持** RunState / 行为指标 —— 这些归 Harness 层（M6 后续专题）。
 *
 * **生命周期**：
 *   - `shutdown()` 之前会先触发各 Capability 的 `on_session_stop(session)`
 *     —— Capability 可在 shutdown 前做最后一次读写（如 TabMemoCap 蒸馏）。
 *   - 单 cap on_session_stop 抛错的行为：宿主层应"记录并继续"（catch
 *     单 cap 异常不阻塞其他 cap 的清理） —— 由 W2 宿主装配代码保证，
 *     M1 不强制（避免误导 cap 实现者写"靠抛错回滚"的反模式）。
 */
export interface BackendSession {
  // ── 身份 ─────────────────────────────────────────────────────────
  readonly sessionId: string;
  readonly backendType: BackendType;
  readonly capabilities: BackendSessionCapabilities;
  readonly agentHome: AgentHomeLayout;
  /** LocalVM / Cloud 有值；Native 为 undefined（M2 NativeBackendSession 不接 manifest） */
  readonly manifest?: Manifest;

  // ── 文件操作（基类提供组合实现，子类可 override 优化）────────────
  read(path: string): Promise<Buffer>;
  write(path: string, data: Buffer | string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  ls(path: string): Promise<string[]>;

  // ── 命令执行（必须实现）──────────────────────────────────────────
  /**
   * 执行命令并等待退出。
   *
   * **关卡 1 地板**（各 Backend 必须在此方法内部完成）：
   *   1. env-sanitize 过滤 30+ 危险环境变量（复用 `packages/env-sanitize`）
   *   2. 高危命令识别（CommandValidator + denylist；Native 直接调
   *      `CommandExecutor.executeStreaming`，env-sanitize + 高危识别 + policy
   *      evaluation 都已经在 CommandExecutor 里）
   *   降级识别命中时 `ExecResult.degraded = true`。
   */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;

  // ── Optional：按 Backend 能力实现 ────────────────────────────────
  stat?(path: string): Promise<FileStat>;
  execInteractive?(command: string, opts?: ExecOptions): Promise<InteractiveSession>;

  // ── 生命周期 ─────────────────────────────────────────────────────
  /** session 是否仍在运行（Cloud 可能因 hibernate / VM crash 等返回 false） */
  running(): Promise<boolean>;
  /** 主动关闭并释放资源；可幂等多次调用 */
  shutdown(): Promise<void>;
}

// ─── 能力标记接口（M3/M4 按需 implements，M1 只占位）────────────────

/**
 * Backend 支持跨 Run 持久化 workspace —— LocalVM / Cloud 实现。
 *
 * Native 不需要（家目录就是宿主磁盘，本身就持久化），M2 NativeBackendSession
 * 不 implements 本接口；TypeScript 类型层面通过 `session.capabilities.supportsPersistence`
 * 判断。
 */
export interface PersistableSession {
  /** 把 workspace 序列化成可重建的状态 */
  persistWorkspace(): Promise<SessionPersistState>;
  /** 从持久化状态恢复 workspace */
  hydrateWorkspace(state: SessionPersistState): Promise<void>;
}

/**
 * Backend 支持 hibernate（零费休眠） —— Cloud 独有，对应 ACS 的"挂起付存储费"。
 */
export interface HibernatableSession {
  /** 进入休眠（释放 CPU / 内存，保留磁盘） */
  hibernate(): Promise<void>;
  /** 唤醒并恢复运行 */
  wake(): Promise<void>;
}

/**
 * Backend 支持 checkpoint 克隆 —— Cloud 独有，用于子 Agent 并行场景。
 */
export interface CloneableSession {
  /** 从快照克隆出新 session（共享 base 镜像 + 独立增量） */
  cloneFromCheckpoint(checkpointId: string): Promise<BackendSession>;
}

/**
 * 跨 Run 持久化的 workspace 状态。
 *
 * **schemaVersion 硬 fail-fast**：反序列化时 schemaVersion !== 1 直接抛
 * `SessionPersistStateVersionError`（见 errors.ts），不做自动迁移
 * （`$schemaVersion` 模式）。
 *
 * **payload 内容**：Backend 私有，由 M3 LocalVMBackendSession / M4
 * CloudBackendSession 自己定义结构（M1 不约束，避免提前耦合）。
 */
export interface SessionPersistState {
  /** 硬版本号，未来破坏性修改必升 */
  readonly schemaVersion: 1;
  readonly backendType: BackendType;
  /** Backend 私有的序列化内容 */
  readonly payload: Record<string, unknown>;
  /** 可选：fingerprint 用于 resume 时判断是否可跳过 restore */
  readonly fingerprint?: string;
}
