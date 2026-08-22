/**
 * ManagedTaskStore —— Agent shell 任务的状态权威。
 *
 * **业务定位**（北极星）：把"运行 quota（PtyManager.MAX_SESSIONS）"和
 * "可查询 completed record"两层 lifecycle 解耦。原本两件事压在 PtyManager
 * 的 PtySession 上，导致：
 *
 *   - 命令一退出 5 秒就被删 → 后续读取拿不到终态
 *   - 不删 → 累计 20 个未释放 session 就撞 MAX_SESSIONS（dogfood 2026-05-18
 *     session 16dd07d8 的 call:20 错因）
 *
 * 现在 PtySession 仍按"5 秒延迟释放"快回收（释放 OS 资源 + UI tab 配额），
 * ManagedTaskRecord 单独保留 30 分钟 TTL 供 dedup / push notification producer /
 * UI 任务列表查询 exit_code / exited_by / killed_reason 等终态。
 *
 * §0.5 表 A（状态转移）+ §4.2（schema）+ §4.2.3（lifecycle 与 race 保护）+
 * §6.2（hard_timeout GC 警告）+ §6.6（重启不持久化）。
 *
 * ## 状态机（§0.5 表 A）
 *
 * ```
 *      ┌──────────────────────────────────────────────┐
 *      │                                              │
 * ─→ running ─┬─→ (进程自然 exit)        ─→ completed │
 *             │   (kill_tool 调用)        ─→ killed    │
 *             │   (hard_timeout 触发)     ─→ killed    │  ← terminal states
 *             │   (用户 UI kill)          ─→ killed    │  保留 30min TTL
 *             │   (spawn 后 listener 抛错) ─→ failed    │  ← TTL 后 GC
 *             │                                       │
 *             └───────────────────────────────────────┘
 * ```
 *
 *   - terminal states（completed / killed / failed）一旦达到不可回 running
 *   - `unknown` 不是 record 状态——它是 await 找不到 record 时合成的工具返回
 *   - spawn 失败永不创建 record（避免幽灵记录污染 GC 与 dedup）
 *
 * ## GC（§4.2.3 简化版）
 *
 * 2026-05-23 push 通知重构 commit B：专门的 await 工具下线后，GC race
 * 保护退化为简单形态——cleanup_at 到期直接 deleteAndCleanup。
 *
 * ## hard_timeout GC 警告方案（§6.2）
 *
 * status='running' 持续 ≥ 6h → emit SYSTEM_NOTICE 让 UI/LLM 看到长跑任务
 * status='running' 持续 ≥ 12h → 自动 SIGTERM 杀掉，killed_reason='hard_timeout'
 *
 * 阈值常量化，单测可用 fake clock 注入小阈值快速验证。
 */

import { createHash } from 'node:crypto';
import { unlink as fsUnlink } from 'node:fs/promises';

// ─── 常量 ────────────────────────────────────────────────────────────

/** completed/killed/failed 后保留多久才被 GC（毫秒）。30 分钟覆盖典型 LLM 对话窗口。 */
export const MANAGED_TASK_RECORD_TTL_MS = 30 * 60 * 1000;

/** GC 扫描周期（毫秒）。5 分钟一次足够，避免 hot loop。 */
export const MANAGED_TASK_GC_INTERVAL_MS = 5 * 60 * 1000;

/** running 持续多久发 6h SYSTEM_NOTICE（毫秒）。 */
export const HARD_TIMEOUT_WARNING_MS = 6 * 60 * 60 * 1000;

/** running 持续多久自动 SIGTERM（毫秒）。 */
export const HARD_TIMEOUT_KILL_MS = 12 * 60 * 60 * 1000;

/** dedup 命中窗口（毫秒）。 */
export const DEDUP_WINDOW_MS = 1000;

// ─── 类型 ────────────────────────────────────────────────────────────

export type ManagedTaskStatus = 'running' | 'completed' | 'killed' | 'failed';
export type ExitedBy = 'normal_exit' | 'exec_failure' | 'signal';
export type ManagedTaskNotificationState = 'foreground_waiting' | 'background_exposed';
/**
 * `app_exit`（终端假运行根治 v3 路线 A / F-EXIT）：客户端整体退出时，退出守卫
 * 枚举所有 running record 杀整组并同步 flush "已终止" 终态，killed_reason 标
 * `app_exit` 与"用户主动 kill / hard_timeout / kill_tool" 区分——前端可显示
 * "应用退出已停止"。
 */
export type KilledReason = 'hard_timeout' | 'kill_tool' | 'user_interrupt' | 'app_exit';

/**
 * 命令归属（账号 / 租户）—— owner 固化（终端假运行根治 Layer 1 / 治 F1）。
 *
 * spawn 时由 bridge 解析当前 `{userId, organizationId}` 写进 record（此刻 auth 一定
 * 有效，因为命令正是在一次活跃 query 内发起的）。终态投递时从 record 取 owner
 * （而非临时 `getCLIOrganizationId()`）—— 即便用户后来切了 organization / token 临时失效，
 * 我们仍知道这条命令属于哪个 outbox 桶，从而能把终态落到正确的持久化队列等
 * recover 重投。字段对齐 `agent-runtime` 的 `PersistedEntryOwner`（userId+organizationId）。
 */
export interface ManagedTaskOwner {
  userId: string;
  organizationId: string;
}

/**
 * Layer 2 落盘的 record 子集（终端假运行根治 v3 / 治 F9：host 崩溃兜底）。
 *
 * `ManagedTaskStore` 纯内存——host 崩溃 / 断电 / `kill -9`（清理链路没机会跑）时整个
 * 内存账本随进程蒸发，在跑的后台命令终态丢失 → 重载假运行。本类型是落盘的最小字段
 * 集，**只持久化启动对账需要的**：
 *   - `pid`        —— `process.kill(pid, 0)` 探活；
 *   - `statusfile_path` —— 读 sidecar 退出码（真相源）；
 *   - `output_file_path` —— 读 stdout tail + pid 重用防护（文件还在 = pid 可信）；
 *   - `owner`      —— 路由到正确 outbox 桶 recover（治 F1）；
 *   - `threadId` + `toolUseId` —— 定位 Django 里那条 running 快照做 supersede；
 *   - `command` / `cwd` / `started_at` —— 构造终态 content + 估算 duration。
 *
 * 落盘端口（`ManagedTaskPersistence`）刻意做成"依赖倒置"：`terminal-core` 保持纯净
 * （不依赖 `agent-runtime` 的 `FilePersistentQueue`），由 host 注入实现。
 */
export interface PersistedManagedTask {
  schema_version: typeof MANAGED_TASK_SCHEMA_VERSION;
  session_id: string;
  pid?: number;
  toolUseId: string;
  threadId?: string;
  /** 通知 drain 路由键；缺省回落 threadId。 */
  notificationThreadId?: string;
  spaceId: string;
  command: string;
  cwd: string;
  output_file_path: string;
  statusfile_path?: string;
  owner?: ManagedTaskOwner;
  /** 落盘时恒为 `running`（terminal 后即从盘上删除，对账只关心 running 残留）。 */
  status: ManagedTaskStatus;
  /** 是否已经对用户/LLM 暴露为后台任务；落盘保留该语义供恢复链路识别。 */
  notification_state: ManagedTaskNotificationState;
  started_at: number;
  hard_timeout_ms?: number;
}

/**
 * Layer 2 落盘端口（依赖倒置）。`terminal-core` 不依赖 `agent-runtime`
 * （`FilePersistentQueue` / `buildSyncAccountDir` 都在那），故由 host 在 start() 时
 * 注入 owner 分桶的 FilePersistentQueue 实现（落到独立文件 `managed-tasks.jsonl`，
 * **不复用** relay-pending / sync pending）。
 *
 * **全部 best-effort fire-and-forget**——绝不能因落盘失败打断 spawn / exit 主路径；
 * 实现内部自行吞错（与 `RelayRetryQueue.persist` 同款"不回灌、不静默崩"语义）。
 */
export interface ManagedTaskPersistence {
  /** `createRecord` / `setPid` 时 upsert（status 恒 running，按 session_id 折叠覆盖）。 */
  upsert(record: PersistedManagedTask): void;
  /** `updateOnExit` 进 terminal 后删除（命令已收尾，无需崩溃兜底）。 */
  delete(sessionId: string, owner: ManagedTaskOwner | undefined): void;
}

/** 从完整 `ManagedTaskRecord` 抽出 Layer 2 落盘子集。 */
export function toPersistedManagedTask(record: ManagedTaskRecord): PersistedManagedTask {
  return {
    schema_version: record.schema_version,
    session_id: record.session_id,
    pid: record.pid,
    toolUseId: record.toolUseId,
    threadId: record.threadId,
    notificationThreadId: record.notificationThreadId,
    spaceId: record.spaceId,
    command: record.command,
    cwd: record.cwd,
    output_file_path: record.output_file_path,
    statusfile_path: record.statusfile_path,
    owner: record.owner,
    status: record.status,
    notification_state: record.notification_state,
    started_at: record.started_at,
    hard_timeout_ms: record.hard_timeout_ms,
  };
}

/**
 * 单条任务记录。所有字段语义见 PRD §4.2.1。
 *
 * **环境变量 hash**：`env_hash` 是排序后 env 的 sha256，进 dedup key（§6.5）。
 * 不含敏感原值，仅作内存指纹用，**不要写日志**（即便是 hash，模式分析可能泄漏）。
 *
 * **stdout_byte_count 由谁累加**：bridge 实现层在 AgentOutputTail 的 write
 * 钩子里调 `incrementOutputBytes()`，不在 hot path 上做 stat 文件 I/O。
 */
/**
 * 2026-05-18 review P0-7：record schema 版本号。
 *
 * 当下值 = 1。未来 schema 演化（加字段 / 改 status 枚举 / 改 KilledReason 等）时
 * bump 到 2，让 Daemon ↔ Electron 跨 release 协议协商有锚点（避免老 daemon
 * 拿到新 record 字段 silent 丢失）。
 *
 * 当下不做 IPC 校验，只在 record 上写一个常量 —— 为未来留口。
 */
export const MANAGED_TASK_SCHEMA_VERSION = 1 as const;

/** 通知入队用的 thread：优先 notificationThreadId，否则业务 threadId。 */
export function resolveNotificationRouteThreadId(record: {
  threadId?: string;
  notificationThreadId?: string;
}): string | undefined {
  const routed = record.notificationThreadId?.trim();
  return routed || record.threadId;
}

/** 终端卡片 / Django relay 用业务对话 thread，不是 drain 路由键。 */
export function resolveBackgroundTaskRelayThreadId(env: {
  target: { threadId: string };
  payload: { business_thread_id?: string };
}): string {
  const business = env.payload.business_thread_id?.trim();
  return business || env.target.threadId;
}

export interface ManagedTaskRecord {
  /** Schema 版本号，永远写常量 MANAGED_TASK_SCHEMA_VERSION。 */
  schema_version: typeof MANAGED_TASK_SCHEMA_VERSION;
  session_id: string;
  command: string;
  /**
   * LLM 在 `run_terminal_command(description)` 写的 5-10 字意图摘要（如「后台计时5秒」）。
   * 后台完成通知优先用它向用户展示（比裸命令更可读）。可选——LLM 未填时 undefined。
   */
  description?: string;
  cwd: string;
  env_hash: string;
  spaceId: string;
  threadId?: string;
  /**
   * 后台完成通知 drain 路由键。
   * 与 `threadId`（父对话 / UI）拆开；缺省时 producer 回落 `threadId`。
   */
  notificationThreadId?: string;
  toolUseId: string;
  /**
   * owner 固化（终端假运行根治 Layer 1 / 治 F1）。spawn 时 bridge 解析当前
   * `{userId, organizationId}` 写入；终态投递（push 通知 / 退出 flush）从此取 owner
   * 构造 outbox，丢 token / 切 organization 后仍可落到正确桶 recover。
   *
   * **可选**：bridge 解析失败（未登录 / 无 organization）或老 record 缺失时 undefined——
   * 此时终态投递回落到 `getCLIOrganizationId()`（行为不劣化于固化前）。
   */
  owner?: ManagedTaskOwner;
  pid?: number;
  started_at: number;
  /**
   * Layer 2 退出码 sidecar 文件路径（终端假运行根治 v3 / 治 F9：host 崩溃兜底）。
   *
   * spawn 时由 bridge 与 `output_file_path` 同目录分配（`<session>.status`，见
   * `tabtinAgentTaskStatusPath`），shell 进程退出前 `echo $? > <path>` 写盘。host
   * 崩溃 / `kill -9` 后启动对账（`reconcileManagedTask`）读它恢复真实退出码；缺失 /
   * 损坏 → 诚实标 `exit_code: unknown`（对齐磁盘 footer）。可选——前台路径 /
   * 老 record 无 sidecar；GC `deleteAndCleanup` 时一并 unlink（与 output_file 对称）。
   */
  statusfile_path?: string;
  status: ManagedTaskStatus;
  exit_code?: number;
  exited_by?: ExitedBy;
  killed_reason?: KilledReason;
  output_file_path: string;
  stdout_byte_count: number;
  last_output_at: number;
  completed_at?: number;
  cleanup_at?: number;
  /**
   * 命令通知语义：
   * - `foreground_waiting`：本轮 tool_call 正在同步等待，若在 wait 窗口内完成，
   *   当前 tool_result 已承载终态，不应触发后台完成通知；
   * - `background_exposed`：ShellCap 已经返回 `status:"running"`，用户/LLM 已被告知
   *   任务在后台继续跑，退出时 producer 才能发 `background-task-completed`。
   */
  notification_state: ManagedTaskNotificationState;
  /** hard_timeout warning 是否已 emit（避免重复 emit）。 */
  hard_timeout_warning_emitted?: boolean;
  /**
   * 2026-05-18 review P0-2：LLM 通过 `run_terminal_command(hard_timeout_ms)`
   * 显式传的命令真死线（毫秒）。GC 用 `record.hard_timeout_ms ?? this.hardTimeoutKillMs`
   * 决定何时强杀——LLM 传值时按值杀，不传时走 12h 默认兜底。详见 PRD §6.2。
   */
  hard_timeout_ms?: number;
  /**
   * 2026-05-23 push 通知重构 commit 2：是否已通过同步 tool_result 告知 LLM。
   * `task.notified` / `markNotified` suppress 语义——
   *
   * - **默认 undefined/false**：updateOnExit 触发时 producer 应 push 通知
   * - **true**：ShellCap 在 sync 完成路径（completed / failed / spawn-error / abort）
   *   显式调 `markNotified(sessionId)` 后变 true；producer 跳过 enqueue
   *
   * 默认 push 的设计选择：万一 ShellCap 没标记，最多多 push 一条；不会漏 push。
   * 详见 PRD §6.1 + §12.4（"task.notified 标志模式"）。
   */
  notified?: boolean;
  /**
   * 同步等待路径的完成通知认领。
   *
   * ShellCap 在 `wait_ms > 0` 时会同步等待命令完成；bridge 创建 record 时先设
   * 这个 claim，让极快命令即便在 ShellCap 首轮 poll 前退出，也不会先入队一条
   * background completion push。之后：
   *
   * - ShellCap 同步返回 completed/failed → `markNotified()` 清掉 claim 并设
   *   `notified=true`
   * - ShellCap 等到 `wait_ms` 用尽返回 running → `releaseSyncNotificationClaim()`
   *   清掉 claim，后续真实后台完成仍会 push
   *
   * 该字段只存在内存 record，不落盘；host 崩溃后恢复的 running 任务必须回到
   * background 通知语义，避免无人释放的 claim 永久 suppress 终态。
   */
  sync_notification_claim?: boolean;
}

/** GC 期间收到 hard_timeout 事件时 store 回调宿主的接口。 */
export interface ManagedTaskHardTimeoutHandlers {
  /** running ≥ 6h → 让宿主 emit SYSTEM_NOTICE 给 UI / LLM。 */
  onWarning?: (record: ManagedTaskRecord) => void;
  /** running ≥ 12h → 让宿主调 bridge.killAgentSession(SIGTERM)。 */
  onKill?: (sessionId: string) => Promise<void> | void;
}

export interface ManagedTaskStoreOptions {
  /** 测试时注入 fake clock；生产留空走 Date.now()。 */
  clock?: () => number;
  /** 测试时注入 fake setInterval / clearInterval；生产留空走全局。 */
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** record TTL。测试可改小。 */
  recordTtlMs?: number;
  /** GC 扫描周期。测试可改小。 */
  gcIntervalMs?: number;
  /** hard_timeout warning 阈值。测试可改小。 */
  hardTimeoutWarningMs?: number;
  /** hard_timeout kill 阈值。测试可改小。 */
  hardTimeoutKillMs?: number;
  /** hard_timeout 事件 handlers（生产由 bridge 注入）。 */
  hardTimeoutHandlers?: ManagedTaskHardTimeoutHandlers;
  /** output_file_path / statusfile_path 删除函数（默认 fs.unlink；测试可注入 spy）。 */
  unlinkFile?: (path: string) => Promise<void>;
  /** 失败时 log（默认 console.warn）。 */
  log?: (msg: string, err?: unknown) => void;
  /**
   * Layer 2 落盘端口（终端假运行根治 v3 / 治 F9）。host 在 start() 拿到
   * `bridge.getManagedTaskStore()` 后注入 FilePersistentQueue 实现；缺省 = 不落盘
   * （纯内存，行为与旧版完全一致）。也可构造后用 `setManagedTaskPersistence` 注入。
   */
  persistence?: ManagedTaskPersistence;
}

// ─── env_hash 工具（导出，让 bridge 在创建 record 时统一计算） ────────

export function hashEnvVars(env: Record<string, string> | undefined): string {
  if (!env || Object.keys(env).length === 0) return 'empty';
  const sorted = Object.keys(env).sort();
  const h = createHash('sha256');
  for (const k of sorted) {
    h.update(k);
    h.update('=');
    h.update(env[k]!);
    h.update('\0');
  }
  return h.digest('hex');
}

// ─── ManagedTaskStore ────────────────────────────────────────────────

/**
 * 2026-05-18 review P0-10：spawn 序列化 mutex。
 * 同 dedup key 同时只允许一个 spawn 链路在 critical section（findDedupCandidate
 * + spawn + createRecord）内执行，避免两个并发 tool_call 都 miss dedup。
 */
function makeDedupKey(input: {
  command: string;
  cwd: string;
  env_hash: string;
  threadId?: string;
}): string {
  return `${input.threadId ?? '_no_thread'}|${input.cwd}|${input.env_hash}|${input.command}`;
}

export class ManagedTaskStore {
  private readonly records = new Map<string, ManagedTaskRecord>();
  /** 前台 poll 循环人工转后台请求（IPC `pty:agent-detach` → ShellCap consume）。 */
  private readonly detachRequests = new Set<string>();
  /** 前台 poll 循环人工停止请求（IPC `pty:agent-kill` → ShellCap consume）。 */
  private readonly killRequests = new Set<string>();
  private readonly clock: () => number;
  /** 2026-05-18 review P0-10：spawn 路径 per-key 序列化。 */
  private readonly spawnMutex = new Map<string, Promise<void>>();
  private readonly setIntervalFn: (handler: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly recordTtlMs: number;
  private readonly gcIntervalMs: number;
  private readonly hardTimeoutWarningMs: number;
  private readonly hardTimeoutKillMs: number;
  private readonly hardTimeoutHandlers: ManagedTaskHardTimeoutHandlers;
  private readonly unlinkFile: (path: string) => Promise<void>;
  private readonly log: (msg: string, err?: unknown) => void;
  private gcHandle: unknown = null;
  /** Layer 2 落盘端口（治 F9）；undefined = 不落盘（纯内存）。 */
  private persistence: ManagedTaskPersistence | undefined;

  constructor(opts: ManagedTaskStoreOptions = {}) {
    this.clock = opts.clock ?? (() => Date.now());
    this.setIntervalFn = opts.setInterval ?? ((handler, ms) => setInterval(handler, ms));
    this.clearIntervalFn = opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.recordTtlMs = opts.recordTtlMs ?? MANAGED_TASK_RECORD_TTL_MS;
    this.gcIntervalMs = opts.gcIntervalMs ?? MANAGED_TASK_GC_INTERVAL_MS;
    this.hardTimeoutWarningMs = opts.hardTimeoutWarningMs ?? HARD_TIMEOUT_WARNING_MS;
    this.hardTimeoutKillMs = opts.hardTimeoutKillMs ?? HARD_TIMEOUT_KILL_MS;
    this.hardTimeoutHandlers = opts.hardTimeoutHandlers ?? {};
    this.unlinkFile = opts.unlinkFile ?? (async (p) => { await fsUnlink(p); });
    this.log = opts.log ?? ((msg, err) => console.warn(`[ManagedTaskStore] ${msg}`, err ?? ''));
    this.persistence = opts.persistence;
  }

  /**
   * 注入 / 替换 Layer 2 落盘端口（治 F9）。host 在 start() 拿到
   * `bridge.getManagedTaskStore()` 后注入 owner 分桶的 FilePersistentQueue 实现；
   * 注入后 `createRecord` / `setPid` 即开始落盘、`updateOnExit` terminal 后删盘。
   * 在第一条命令 spawn 前注入即可（host.start 早于任何 query）。
   */
  setManagedTaskPersistence(persistence: ManagedTaskPersistence | undefined): void {
    this.persistence = persistence;
  }

  // ─── lifecycle ──────────────────────────────────────────────────

  /**
   * 注册新 running 任务。bridge 在 `spawnAgentSessionDetached` /
   * `executeAgentCommand` 成功 spawn 子进程后立刻调。
   *
   * **失败处理**：如果 sessionId 已存在（理论上不该发生，但防御），
   * 同步 throw 让 bridge 知道——避免覆盖已有 record。
   */
  createRecord(input: {
    session_id: string;
    command: string;
    /** LLM 写的命令意图摘要（run_terminal_command description），后台完成通知优先展示。 */
    description?: string;
    cwd: string;
    env: Record<string, string> | undefined;
    spaceId: string;
    /**
     * 业务对话 thread ID（UI / relay）。通知路由见 `notificationThreadId`。
     */
    threadId?: string;
    /** 通知 drain 路由键；子 Agent 后台命令填 childId。 */
    notificationThreadId?: string;
    toolUseId: string;
    /**
     * owner 固化（终端假运行根治 Layer 1 / 治 F1）。bridge 在 spawn 时解析当前
     * `{userId, organizationId}` 传入。可选——解析失败时 undefined，终态投递回落到
     * `getCLIOrganizationId()`。
     */
    owner?: ManagedTaskOwner;
    pid?: number;
    output_file_path: string;
    /**
     * Layer 2 退出码 sidecar 文件路径（治 F9）。bridge 与 output_file 同目录分配
     * （`<session>.status`）。可选——前台路径 / 未启用 sidecar 时 undefined。
     */
    statusfile_path?: string;
    /** LLM 通过 hard_timeout_ms 传的命令真死线（毫秒）。可选；不传走默认 12h 兜底。 */
    hard_timeout_ms?: number;
    /** ShellCap `wait_ms > 0` 同步等待路径先认领完成通知，超时转后台时再释放。 */
    sync_notification_claim?: boolean;
  }): ManagedTaskRecord {
    if (this.records.has(input.session_id)) {
      throw new Error(`ManagedTaskStore.createRecord: session_id already exists: ${input.session_id}`);
    }
    const now = this.clock();
    const record: ManagedTaskRecord = {
      schema_version: MANAGED_TASK_SCHEMA_VERSION,
      session_id: input.session_id,
      command: input.command,
      description: input.description,
      cwd: input.cwd,
      env_hash: hashEnvVars(input.env),
      spaceId: input.spaceId,
      threadId: input.threadId,
      notificationThreadId: input.notificationThreadId,
      toolUseId: input.toolUseId,
      owner: input.owner,
      pid: input.pid,
      started_at: now,
      status: 'running',
      output_file_path: input.output_file_path,
      statusfile_path: input.statusfile_path,
      stdout_byte_count: 0,
      last_output_at: now,
      notification_state: 'foreground_waiting',
      hard_timeout_ms: input.hard_timeout_ms,
      sync_notification_claim: input.sync_notification_claim === true ? true : undefined,
    };
    this.records.set(input.session_id, record);
    // Layer 2 落盘（治 F9）：spawn 即写盘，host 崩溃后启动对账能恢复终态。
    // best-effort，落盘失败不打断 spawn（pid 此刻尚未回填，setPid 会再 upsert 一次）。
    this.persistRecord(record);
    return record;
  }

  /**
   * 2026-05-23 push 通知重构 commit 2：标记 record 已通过同步 tool_result
   * 告知 LLM，updateOnExit 时 producer 跳过 push 通知。
   *
   * **调用时机**（ShellCap 同步出口路径）：
   *   - completed 分支返回前
   *   - failed envelope 返回前
   *   - spawn 失败 envelope 返回前
   *   - abort signal 触发的 REQUEST_TIMEOUT 返回前
   *
   * **绝不**在 "status='running'" 返回前调（dedup 命中 / wait_ms=0 / poll
   * deadline / pattern 命中等路径）——这些路径 LLM 没看到 completed，需要 push。
   *
   * **幂等**：重复调 no-op；record 不存在 no-op（spawn 失败前 record 可能未创建）。
   *
   * 对齐 `markNotified` suppress 语义。
   * 详见 ManagedTaskRecord.notified JSDoc。
   */
  markNotified(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    record.notified = true;
    record.sync_notification_claim = undefined;
  }

  /**
   * 释放 ShellCap 同步等待路径的完成通知认领。
   *
   * 返回当前 record 快照引用，方便调用方区分：
   * - `status === 'running'`：命令仍在跑，后续 exit producer 会正常 push
   * - terminal state：exit 已在 claim 期间发生并被 suppress，调用方应同步交付终态
   *
   * 幂等：record 不存在或没有 claim 时也只返回当前 record / undefined。
   */
  releaseSyncNotificationClaim(sessionId: string): ManagedTaskRecord | undefined {
    const record = this.records.get(sessionId);
    if (!record) return undefined;
    record.sync_notification_claim = undefined;
    return record;
  }

  /** 标记任务已被同步 tool_result 暴露为后台任务，退出时允许 producer 发完成通知。 */
  markBackgroundExposed(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    if (record.notification_state === 'background_exposed') return;
    record.notification_state = 'background_exposed';
    this.persistRecord(record);
  }

  /**
   * 请求将前台同步等待中的 running 任务转入后台（不杀进程）。
   *
   * 由 host bridge（Electron/Daemon IPC）在用户点「转入后台」时调用；
   * ShellCap poll 循环每轮 `consumeDetachRequest` 读后清除，与 wait_ms 超时
   * 走同一转后台出口。
   *
   * @returns true 仅当 record 存在且 status === 'running'
   */
  requestDetach(sessionId: string): boolean {
    const record = this.records.get(sessionId);
    if (!record || record.status !== 'running') return false;
    this.detachRequests.add(sessionId);
    return true;
  }

  /**
   * ShellCap poll 循环查询并消费 detach 请求（读后清除，防复用）。
   */
  consumeDetachRequest(sessionId: string): boolean {
    if (!this.detachRequests.has(sessionId)) return false;
    this.detachRequests.delete(sessionId);
    return true;
  }

  /**
   * 请求终止前台同步等待中的 running 任务（用户点「停止」）。
   *
   * 与 detach 对称的**显式信号**：host bridge（Electron/Daemon IPC）在用户点
   * 「停止」时调用；ShellCap poll 循环每轮 `consumeKillRequest` 读到即确定性
   * 退出等待并返回终止 envelope，不再依赖「杀进程 → isRunning 翻转」的隐式
   * 检测（前台命令 kill 后 pty session 移除与 record.status 翻转之间存在竞态
   * 窗口，隐式检测会让 poll 误读 isRunning=true 而一直空等 → Agent 卡住）。
   *
   * @returns true 仅当 record 存在且 status === 'running'
   */
  requestKill(sessionId: string): boolean {
    const record = this.records.get(sessionId);
    if (!record || record.status !== 'running') return false;
    this.killRequests.add(sessionId);
    return true;
  }

  /**
   * ShellCap poll 循环查询并消费 kill 请求（读后清除，防复用）。
   */
  consumeKillRequest(sessionId: string): boolean {
    if (!this.killRequests.has(sessionId)) return false;
    this.killRequests.delete(sessionId);
    return true;
  }

  /**
   * 2026-05-18 review P2-3：bridge 在 spawn 拿到 child handle 后回填 pid。
   * 让 unknown 分支 hint 真能给 LLM `ps -p <pid>` 的有效命令。
   */
  setPid(sessionId: string, pid: number): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    record.pid = pid;
    // Layer 2 落盘（治 F9）：createRecord 时 pid 尚未回填（spawn 在其后），这里
    // 再 upsert 一次把真实 pid 落盘，让对账能 `process.kill(pid, 0)` 探活。
    this.persistRecord(record);
  }

  /** bridge 在 AgentOutputTail write 钩子里调，累加 stdout byte count。 */
  incrementOutputBytes(sessionId: string, deltaBytes: number): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    record.stdout_byte_count += deltaBytes;
    record.last_output_at = this.clock();
  }

  /**
   * 标记 record 进入 terminal state。bridge 在子进程 exit handler 调。
   *
   * **幂等**：已经是 terminal state 的 record 再调本方法 no-op（防御性，
   * 比如 SIGTERM 后又收到 exit 事件）。
   */
  updateOnExit(
    sessionId: string,
    result: {
      status: 'completed' | 'killed' | 'failed';
      exit_code: number;
      exited_by: ExitedBy;
      killed_reason?: KilledReason;
    },
  ): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    if (record.status !== 'running') return; // 幂等
    this.detachRequests.delete(sessionId);
    this.killRequests.delete(sessionId);
    const now = this.clock();
    record.status = result.status;
    record.exit_code = result.exit_code;
    record.exited_by = result.exited_by;
    record.killed_reason = result.killed_reason;
    record.completed_at = now;
    record.cleanup_at = now + this.recordTtlMs;
    // Layer 2（治 F9）：命令已收尾 → 从盘上删除 running record，下次启动不再对账它。
    // 优雅退出（app_exit）的终态由 Layer 1 relay outbox 负责持久投递；崩溃路径
    // 永远跑不到这里（updateOnExit 没机会调），盘上 record 留给启动对账兜底。
    this.deletePersisted(record);
  }

  // ─── 查询 ───────────────────────────────────────────────────────

  get(sessionId: string): ManagedTaskRecord | undefined {
    return this.records.get(sessionId);
  }

  /** 列出所有记录（GC / 调试用，不在 hot path 上跑）。 */
  list(): ManagedTaskRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * dedup 查询：同 thread / cwd / command 字面 / env_hash 在 1 秒窗口内
   * 有 running record → 返回它的 session_id。详见 PRD §6.5。
   *
   * **不命中 / 不在窗口 / 已 terminal**：返回 undefined。
   */
  findDedupCandidate(input: {
    command: string;
    cwd: string;
    env: Record<string, string> | undefined;
    threadId?: string;
  }): ManagedTaskRecord | undefined {
    const envHash = hashEnvVars(input.env);
    const now = this.clock();
    for (const r of this.records.values()) {
      if (r.status !== 'running') continue;
      if (r.command !== input.command) continue;
      if (r.cwd !== input.cwd) continue;
      if (r.env_hash !== envHash) continue;
      if (r.threadId !== input.threadId) continue;
      if (now - r.started_at > DEDUP_WINDOW_MS) continue;
      return r;
    }
    return undefined;
  }

  // ─── GC ─────────────────────────────────────────────────────────

  startGc(): void {
    if (this.gcHandle !== null) return;
    this.gcHandle = this.setIntervalFn(() => this.gcTick(), this.gcIntervalMs);
  }

  stopGc(): void {
    if (this.gcHandle === null) return;
    this.clearIntervalFn(this.gcHandle);
    this.gcHandle = null;
  }

  /**
   * 单次 GC 扫描——外部测试也可显式调（fake clock 配合）。
   *
   * 三件事：
   *   1. terminal state + cleanup_at 到期：直接 deleteAndCleanup + 删 output_file
   *   2. running 持续 ≥ HARD_TIMEOUT_WARNING_MS：emit warning（只一次）
   *   3. running 持续 ≥ HARD_TIMEOUT_KILL_MS：调 onKill handler
   */
  async gcTick(): Promise<void> {
    const now = this.clock();
    const snapshot = Array.from(this.records.values()); // 拍快照避免迭代时修改
    for (const record of snapshot) {
      try {
        if (record.status === 'running') {
          await this.checkHardTimeout(record, now);
          continue;
        }
        // terminal state
        if (record.cleanup_at !== undefined && now >= record.cleanup_at) {
          await this.deleteAndCleanup(record);
        }
      } catch (err) {
        this.log(`gcTick error for session ${record.session_id}`, err);
      }
    }
  }

  private async checkHardTimeout(record: ManagedTaskRecord, now: number): Promise<void> {
    const runningFor = now - record.started_at;
    // 2026-05-18 review P0-2：LLM 显式传 hard_timeout_ms 时按值杀；不传走默认兜底。
    // warning 阈值同步比例缩放（per-record kill 阈值的 0.5x 触发 warning）。
    const killThreshold = record.hard_timeout_ms ?? this.hardTimeoutKillMs;
    const warningThreshold = record.hard_timeout_ms
      ? Math.floor(record.hard_timeout_ms * 0.5)
      : this.hardTimeoutWarningMs;

    if (runningFor >= killThreshold) {
      // 超 hard_timeout：直接 kill
      if (this.hardTimeoutHandlers.onKill) {
        try {
          await this.hardTimeoutHandlers.onKill(record.session_id);
        } catch (err) {
          this.log(`hard_timeout kill failed for ${record.session_id}`, err);
        }
      }
      return;
    }

    if (runningFor >= warningThreshold && !record.hard_timeout_warning_emitted) {
      record.hard_timeout_warning_emitted = true;
      if (this.hardTimeoutHandlers.onWarning) {
        try {
          this.hardTimeoutHandlers.onWarning(record);
        } catch (err) {
          this.log(`hard_timeout warning emit failed for ${record.session_id}`, err);
        }
      }
    }
  }

  private async deleteAndCleanup(record: ManagedTaskRecord): Promise<void> {
    this.detachRequests.delete(record.session_id);
    this.killRequests.delete(record.session_id);
    this.records.delete(record.session_id);
    if (record.output_file_path) {
      try {
        await this.unlinkFile(record.output_file_path);
      } catch (err) {
        // 文件可能已被外部删了 / 路径无效 / 权限问题，best-effort
        this.log(`unlink output_file failed for ${record.session_id}: ${record.output_file_path}`, err);
      }
    }
    // Layer 2（治 F9）：sidecar 与 output_file 对称清理（GC 到期时），避免 tmpdir 残留
    // .status 文件（agent-output-tail 的 7 天 GC 只扫 .log）。best-effort。
    if (record.statusfile_path) {
      try {
        await this.unlinkFile(record.statusfile_path);
      } catch (err) {
        this.log(`unlink statusfile failed for ${record.session_id}: ${record.statusfile_path}`, err);
      }
    }
  }

  // ─── Layer 2 落盘（治 F9） ───────────────────────────────────────

  /** best-effort upsert 落盘子集（端口未注入 / 抛错均不打断主路径）。 */
  private persistRecord(record: ManagedTaskRecord): void {
    if (!this.persistence) return;
    try {
      this.persistence.upsert(toPersistedManagedTask(record));
    } catch (err) {
      this.log(`persist upsert failed for ${record.session_id}`, err);
    }
  }

  /** best-effort 删盘（端口未注入 / 抛错均不打断主路径）。 */
  private deletePersisted(record: ManagedTaskRecord): void {
    if (!this.persistence) return;
    try {
      this.persistence.delete(record.session_id, record.owner);
    } catch (err) {
      this.log(`persist delete failed for ${record.session_id}`, err);
    }
  }

  /** 测试 / shutdown 用：清空所有 record（不触发 unlink，让宿主自己处理）。 */
  clear(): void {
    this.records.clear();
    this.detachRequests.clear();
    this.killRequests.clear();
    this.spawnMutex.clear();
  }

  /**
   * 2026-05-18 review P0-10：spawn 路径序列化 helper。
   *
   * 让 ShellCap spawn 序列「findDedupCandidate → bridge.spawnAgentSessionDetached →
   * createRecord」整段对同 dedup key **互斥**——同 key 同时只允许一条链路执行。
   * 第二个并发 spawn 会等第一个完成后再跑 findDedupCandidate，此时第一个的 record
   * 已写入 store，dedup 必然命中。
   *
   * 调用方负责：
   *   - 自己组装 dedup key 信息（command / cwd / env / threadId）传给 `buildDedupKeyFor`
   *   - fn 内部按需调 findDedupCandidate + spawn + createRecord
   *
   * **超时保护**：mutex 不死锁——异常路径在 finally 释放；fn 自身长跑（如 spawn 慢）
   * 会让第二个调用等待，但这本来就是 race 修复的预期行为（且 spawn 通常 <1s）。
   */
  async runSpawnSerialized<T>(
    keyInput: { command: string; cwd: string; env: Record<string, string> | undefined; threadId?: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = makeDedupKey({
      command: keyInput.command,
      cwd: keyInput.cwd,
      env_hash: hashEnvVars(keyInput.env),
      threadId: keyInput.threadId,
    });
    // wait for any in-flight spawn on same key
    while (this.spawnMutex.has(key)) {
      try {
        await this.spawnMutex.get(key);
      } catch {
        // 上一个 spawn 失败也继续——不要让 race chain 卡死
      }
    }
    let release: () => void = () => {};
    const ticket = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.spawnMutex.set(key, ticket);
    try {
      return await fn();
    } finally {
      this.spawnMutex.delete(key);
      release();
    }
  }
}
