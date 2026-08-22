/**
 * NotificationQueue —— TabTin host 内部 "系统主动 push 给 LLM" 的统一调度队列。
 *
 * **业务定位**（北极星）：消除"反复 await 死循环"——以前 LLM 必须主动 polling 等
 * 后台命令完成，因为 host 没有 push 能力；现在 producer 把"事件"入队，consumer
 * （host idle drain 触发器）按优先级取出来，构造成 user message 触发新一轮 turn。
 *
 * §5 D5（统一优先级队列决策）+ §6.1（数据结构与接口）+ §6.3（消费者）+
 * §12.4（与统一 commandQueue 的关系）。
 *
 * **设计原则**：统一优先级队列 —— 不另起炉灶。
 *
 * ## 优先级语义
 *
 * `'now' > 'next' > 'later'`，同优先级 FIFO。
 *
 * - `'later'`（默认）：后台命令正常完成等"系统消息"——绝不能饿死用户输入
 * - `'next'`：紧急但可接受跟用户输入排队（例：hard_timeout kill 触发的通知）
 * - `'now'`：抢占式（本次实施暂无 producer 用 `'now'`，保留给未来可能的"系统强制
 *   中断"场景——预留接口不写死）
 *
 * 部分实现把"用户输入"也走同一队列（`'next'`），TabTin 本次**不动用户
 * 输入路径**——但 priority 排序已经预留，未来要扩"主动注入 user message"等场景
 * 不需要改接口。详见 PRD §6.3 末尾边界确认。
 *
 * ## Dedup
 *
 * Dedup 语义 = **"未被消费的事件唯一性"**。同 `target.threadId + kind + dedupKey`
 * 组合在 dedup 窗口内只入一次。本次 producer 的 `dedupKey = agent_session_id`——
 * 防止 `handle.result.then` 跟 spawn catch 块都触发 producer 这种边角 race 重复入队。
 *
 * **关键设计**：`drainByThreadId` 取出事件时**同步释放对应的 dedupIndex 项**——
 * "drain = 事件已交付 consumer"，dedup 状态随之释放。这是 PRD §6.3 race 防御 3
 * "失败退回，不丢弃"的正确性前提——consumer 退回 `enqueue(env)` 必须不撞 dedup，
 * 否则通知会静默丢失。`gcTick` 仍负责清理"长期未消费"的 dedupIndex 项（双保险）。
 *
 * ## GC
 *
 * 超过 TTL（默认 24h）未 drain 的通知被 GC。理由：通知是临时事件，不该长期占内存；
 * 也避免"用户关掉 chat session 后通知还堆在那"。
 */

import { createHash } from 'node:crypto';

import type { ManagedTaskOwner, KilledReason } from './managed-task-store.js';

// ─── 常量 ────────────────────────────────────────────────────────────

/** 通知 TTL（毫秒）。超过未 drain 走 GC 删掉。24h 与 dedup 窗口对齐。 */
export const NOTIFICATION_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

/** dedup 窗口（毫秒）。同 threadId+kind+dedupKey 24h 内只入一次。 */
export const NOTIFICATION_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** GC 扫描周期（毫秒）。10 分钟一次足够。 */
export const NOTIFICATION_QUEUE_GC_INTERVAL_MS = 10 * 60 * 1000;

// ─── 类型 ────────────────────────────────────────────────────────────

/**
 * 优先级。'now' > 'next' > 'later'，同优先级 FIFO。
 * 详见模块顶部 JSDoc"优先级语义"。
 */
export type NotificationPriority = 'now' | 'next' | 'later';

/**
 * 通知 envelope。**接口完全通用**——按 PRD §5 D5 决策，`payload` 是
 * `unknown`/泛型，本次只接入一个 producer（`background-task-completed`），
 * 未来扩 producer（子 Agent 完成、proactive、teammate 消息等）不改接口。
 */
export interface NotificationEnvelope<TPayload = unknown> {
  /**
   * 通知类型字面量。本次只有 `'background-task-completed'`。
   * 未来扩 producer 时新增 string literal（如 `'subagent-completed'`）。
   * 接口故意宽松到 `string`——让本队列真正通用。
   */
  kind: string;
  /** 路由到哪个对话 thread（不是 PTY agent session）。 */
  target: {
    spaceId: string;
    /**
     * 对话 thread ID（业务对话身份，跨多次 query 共用，是 `host.sessions Map`
     * 的 key）。consumer 用这个 key 触发 drain。
     *
     * §17.6 D4.a：从原 `target.sessionId` 改名 `target.threadId`，与
     * `ToolContext.threadId` / `SessionConfig.threadId` / wire envelope
     * `payload.thread_id` 命名彻底统一。
     */
    threadId: string;
  };
  /**
   * 优先级。本次 producer 默认 `'later'`（不饿死用户输入）；
   * `hard_timeout` kill 触发的紧急通知用 `'next'`。
   */
  priority: NotificationPriority;
  /** kind 相关的载荷。具体类型由 producer / consumer 共同约定。 */
  payload: TPayload;
  /** 入队时间戳（毫秒）。GC 用。 */
  enqueuedAt: number;
  /**
   * Dedup key（可选）。同 `target.threadId + kind + dedupKey` 在 dedup 窗口
   * 内第二次 enqueue 返回 false。`undefined` 时不参与 dedup（允许重复入）。
   *
   * 本次 producer 必传，值 = `agent_session_id`。
   */
  dedupKey?: string;
}

/**
 * 本次唯一 producer（后台命令完成）的 payload 类型契约。
 * 写在 store 模块里方便 consumer 复用——bridge / host 共同 import。
 */
export interface BackgroundTaskCompletedPayload {
  /** PTY/agent session ID（在 ManagedTaskStore 里也是 sessionId）。 */
  agent_session_id: string;
  /**
   * 发起该后台命令的 tool_use id（= ManagedTaskRecord.toolUseId）。
   *
   * 后台命令前台等待超时时，`run_terminal_command` 已经返回过一份
   * `status: "running"` 的快照作为 tool_result（经 reassembler 合并进对应
   * assistant ChatMessage）。命令真正终结（完成/被 kill/hard_timeout）时，host
   * 用此 id 定位那条 running 快照，emit 一条**终态** tool_result 覆盖它——
   * 让重载对话时终端卡片显示真实终态（完成 退出码 / 已终止）而非永远"运行中"。
   * 详见两端 host 的 `relayBackgroundTaskTerminalResult`。
   */
  tool_use_id: string;
  command: string;
  /**
   * LLM 写的命令意图摘要（run_terminal_command description，如「后台计时5秒」）。
   * 完成通知优先用它向用户展示（比裸命令可读）；缺失时 UI 回落 command。
   */
  description?: string;
  /** 正常退出的 exit code；信号杀的为 null。 */
  exit_code: number | null;
  exited_by: 'normal_exit' | 'exec_failure' | 'signal';
  killed_reason?: KilledReason;
  /** 实际跑了多少毫秒。 */
  duration_ms: number;
  /** 完整 output 落盘路径——LLM 用 read_file 读这个文件取 stdout。 */
  output_file_path: string;
  /** 进程 PID（spawn 成功时填）。 */
  pid?: number;
  /** 命令执行时的 cwd。 */
  cwd: string;
  /**
   * owner 固化（终端假运行根治 Layer 1 / 治 F1）。producer（bridge
   * `emitPushNotificationOnExit`）从 `ManagedTaskRecord.owner` 透传给 consumer
   * （host `relayBackgroundTaskTerminalResult`），让终态投递从此取 outbox owner
   * 而非临时 `getCLIOrganizationId()`。缺失时 host 回落 `getCLIOrganizationId()`。
   */
  owner?: ManagedTaskOwner;
  /**
   * 业务对话 thread。`target.threadId` 是 drain 路由键
   *（子 Agent 为 childId）；终端卡片与 Django relay 必须用本字段。
   */
  business_thread_id?: string;
}

/**
 * W4a S0（2026-05-30）：子 Agent 后台完成回调的 payload 契约。
 *
 * 与 `BackgroundTaskCompletedPayload`（shell 后台命令）并列——两者都经同一
 * `NotificationQueue` 入队/出队，consumer（两端 host 的 `_tryDrain`）按
 * `env.kind` 分派拼装（shell vs `'subagent-completed'`），互不污染。
 *
 * **本步（S0）只建类型 + consumer 分派骨架，不接 producer**——真正的 enqueue
 * 发生在 W4a S5「后台子完成回调链」。详见
 *
 * 字段语义（依赖 W1 身份延续：`subagent_run_id` 即子 Agent 的 childId）：
 *   - `subagent_run_id`：子 Agent 稳定标识，主 Agent 据此 resume / 查状态；
 *   - `parent_thread_id`：派发该子的父对话 thread（= `target.threadId`，冗余
 *     落在 payload 便于 producer/consumer 自洽，不依赖 envelope 外壳）；
 *   - `label`：子任务的人类可读描述（agent 工具 description / prompt 摘要）；
 *   - `status`：子终态（与 `recordEnd` / SUBAGENT_FAILED.error_kind 对齐）；
 *   - `summary`：子 Agent 返回的最终摘要（已 microCompact，见 W1）；
 *   - `summary_file_path?`：超大 summary 落盘指针（LLM 用 read_file 取全文）；
 *   - `duration_ms`：子 Agent 本 run 实际耗时；
 *   - `step_count?`：子 Agent ReAct 步数（观测/计费用）；
 *   - `error_kind?`：失败/取消/超时时的细分类（'cancelled' | 'timeout' | 'failed' …）；
 *   - `parent_tool_call_id?`：派发该子的父 LLM tool_use id（关联父 turn）。
 */
export interface SubagentCompletedPayload {
  /** 子 Agent 稳定标识（childId，W1 回传给主 Agent 的 [子 Agent ID]）。 */
  subagent_run_id: string;
  /** 派发该子的父对话 thread（= envelope.target.threadId）。 */
  parent_thread_id: string;
  /** 子任务的人类可读描述。 */
  label: string;
  /** 子 Agent 终态。 */
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  /** 子 Agent 返回的最终摘要（已压缩）。 */
  summary: string;
  /** 超大 summary 落盘路径——LLM 用 read_file 读全文。 */
  summary_file_path?: string;
  /** 子 Agent 本 run 实际耗时（毫秒）。 */
  duration_ms: number;
  /** 子 Agent ReAct 步数（观测 / 计费用）。 */
  step_count?: number;
  /** 失败 / 取消 / 超时时的细分类。 */
  error_kind?: string;
  /**
   * 子 Agent 内部派发孙任务时，派发者子 Agent 的 run id。顶层主 Agent 派发时缺省。
   */
  run_id?: string;
  /** 派发该后台子任务的 agent tool_use id。 */
  tool_call_id?: string;
  /** 派发该子的父 LLM tool_use id（关联父 turn）。 */
  parent_tool_call_id?: string;
  /**
   * ：子 sidechain 净算后的可交付产物列表（结构化）。
   * 可选——旧 producer / 无产物时缺省。
   */
  deliverables?: unknown[];
  /**
   * ：与 wire `SubagentCompletionEnvelope.stats` 对齐；
   * 后台通知至少应有 duration_ms，前台同源字段可含 tokens。
   */
  stats?: {
    duration_ms?: number;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    credits_consumed?: number;
    [key: string]: unknown;
  };
  /** ：是否后台 detach 子（缺省视为否）。 */
  background?: boolean;
}

/**
 * Subscribe 时返回的"取消订阅"函数。
 */
export type NotificationQueueUnsubscribe = () => void;

/**
 * Subscriber 签名。**注意**：listener 在 enqueue 同步路径上被调用——不要在
 * listener 里做耗时操作（用 `queueMicrotask` / `setTimeout` 切异步）。
 */
export type NotificationQueueListener = (env: NotificationEnvelope) => void;

/**
 * Constructor 注入项，全部可选。生产留空走默认；测试通过这些 hook 注入 fake clock。
 */
export interface NotificationQueueOptions {
  /** 测试时注入 fake clock；生产留空走 Date.now()。 */
  clock?: () => number;
  /** 测试时注入 fake setInterval；生产留空走全局。 */
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** TTL（毫秒）。测试可改小。 */
  ttlMs?: number;
  /** Dedup 窗口（毫秒）。测试可改小。 */
  dedupWindowMs?: number;
  /** GC 扫描周期。测试可改小。 */
  gcIntervalMs?: number;
  /** Listener 异常 log（默认 console.warn）。 */
  log?: (msg: string, err?: unknown) => void;
}

// ─── 内部 dedup key 构造 ─────────────────────────────────────────────

function makeDedupHashKey(threadId: string, kind: string, dedupKey: string): string {
  const h = createHash('sha256');
  h.update(threadId);
  h.update('|');
  h.update(kind);
  h.update('|');
  h.update(dedupKey);
  return h.digest('hex');
}

// ─── NotificationQueue ───────────────────────────────────────────────

/**
 * Module-level 优先级通知队列（commandQueue）。
 *
 * **生命周期**：
 * 1. host 构造时 `new NotificationQueue({...})` + `startGc()`
 * 2. host 调 `subscribe(listener)` 注册 idle drain 触发器
 * 3. producer（bridge.updateOnExit）调 `enqueue(env)` 入队
 * 4. 队列 notify subscribers（同步路径）
 * 5. listener 排队 `queueMicrotask` 后调 `drainByThreadId(threadId)` 取出
 * 6. host 把取出的通知合成 user message，调 `handleQueryInternal(req, NOOP_STREAM_SINK)`
 * 7. host stop 时 `stopGc()`
 *
 * **不跨进程共享**：Electron / Daemon 各自 `new` 一个实例。命令在哪个 host 起
 * 就在哪个 host 完成时 push——天然不需要跨进程。详见 PRD §6.1 D8。
 */
export class NotificationQueue {
  /**
   * 队列存储。用普通数组——本次场景下队列长度永远是 O(待 drain 的通知数)，
   * 通常 0-10 条，不需要高级数据结构。drain 时做 O(n) 优先级排序也没问题。
   */
  private readonly items: NotificationEnvelope[] = [];

  /**
   * Dedup 索引：sha256(threadId|kind|dedupKey) → enqueuedAt。
   * Enqueue 时查这个表；GC 时清理过期项。
   */
  private readonly dedupIndex = new Map<string, number>();

  /** Subscriber 列表，用 Set 保证 unsubscribe 高效。 */
  private readonly subscribers = new Set<NotificationQueueListener>();

  private readonly clock: () => number;
  private readonly setIntervalFn: (handler: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly ttlMs: number;
  private readonly dedupWindowMs: number;
  private readonly gcIntervalMs: number;
  private readonly log: (msg: string, err?: unknown) => void;
  private gcHandle: unknown = null;

  constructor(opts: NotificationQueueOptions = {}) {
    this.clock = opts.clock ?? (() => Date.now());
    this.setIntervalFn =
      opts.setInterval ?? ((handler, ms) => setInterval(handler, ms));
    this.clearIntervalFn =
      opts.clearInterval ??
      ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.ttlMs = opts.ttlMs ?? NOTIFICATION_QUEUE_TTL_MS;
    this.dedupWindowMs = opts.dedupWindowMs ?? NOTIFICATION_DEDUP_WINDOW_MS;
    this.gcIntervalMs = opts.gcIntervalMs ?? NOTIFICATION_QUEUE_GC_INTERVAL_MS;
    // §17.6 修订 3.1 inline 补丁（§6.1 listener 异常处理契约）：
    // 默认 log 级别用 console.error，包含 envelope dump 信息让排查时能看到丢了什么消息。
    this.log =
      opts.log ??
      ((msg, err) => console.error(`[NotificationQueue] ${msg}`, err ?? ''));
  }

  // ─── enqueue / dedup ────────────────────────────────────────────

  /**
   * 入队。返回 `true` 成功；返回 `false` 表示 dedup 命中（同 sessionId+kind+dedupKey
   * 在 dedup 窗口内已存在）。
   *
   * **同步**：enqueue 同步完成，subscribers 在同一栈被调用（但 listener 不应阻塞，
   * 见 `NotificationQueueListener` JSDoc）。
   */
  enqueue<TPayload = unknown>(env: NotificationEnvelope<TPayload>): boolean {
    // dedup 检查
    if (env.dedupKey !== undefined) {
      const dedupHashKey = makeDedupHashKey(
        env.target.threadId,
        env.kind,
        env.dedupKey,
      );
      const existingAt = this.dedupIndex.get(dedupHashKey);
      if (
        existingAt !== undefined &&
        this.clock() - existingAt <= this.dedupWindowMs
      ) {
        return false;
      }
      this.dedupIndex.set(dedupHashKey, env.enqueuedAt);
    }

    // 入队
    this.items.push(env as NotificationEnvelope);

    // 通知 subscribers。
    //
    // §17.6 修订 3.1 inline 补丁（§6.1 listener 异常处理契约）：
    // - try-catch 包裹每个 listener 调用（不同 listener 抛错相互不影响）
    // - listener 抛错时 log.error 包含 envelope dump（kind / target / dedupKey）
    //   让排查时能看到丢了什么消息
    // - **不退回入队**（对照 §17.5 修复方案 2 哲学：异常稳态丢消息不退回）
    // - 不向 enqueue 调用方暴露异常 —— 调用方 enqueue 返回 true 后职责完成，
    //   listener 内部异常是 NotificationQueue 内部问题
    //
    // snapshot 防 listener 内 unsubscribe 改 Set
    const snapshot = Array.from(this.subscribers);
    for (const listener of snapshot) {
      try {
        listener(env as NotificationEnvelope);
      } catch (err) {
        this.log(
          `subscriber listener threw (kind=${env.kind}, target.threadId=${env.target.threadId.slice(0, 8)}…, dedupKey=${env.dedupKey ?? 'none'})`,
          err,
        );
      }
    }
    return true;
  }

  // ─── drain ──────────────────────────────────────────────────────

  /**
   * 按 `target.threadId` 取出所有匹配的通知，**按优先级 + FIFO 排序**返回。
   * 取出的项从队列移除（atomic 在 JS 单线程语义下天然保证）。
   *
   * **同步释放 dedupIndex**：取出 envelope 时把对应的 dedupIndex 项也删掉——
   * 让 consumer 在 `handleQueryInternal` 失败后调 `enqueue(env)` 退回时不会撞
   * dedup 静默丢失（PRD §6.3 race 防御 3 + commandQueue 的"消息绝不
   * 静默丢"原则）。详见模块顶部 JSDoc "## Dedup" 一节。
   *
   * **排序规则**：
   * - 优先级：'now' > 'next' > 'later'
   * - 同优先级：按 `enqueuedAt` 升序（先入先出）
   *
   * 返回空数组表示该 threadId 没有待 drain 的通知。
   */
  drainByThreadId(threadId: string): NotificationEnvelope[] {
    const matched: NotificationEnvelope[] = [];
    const kept: NotificationEnvelope[] = [];
    for (const item of this.items) {
      if (item.target.threadId === threadId) {
        matched.push(item);
        // 同步释放 dedupIndex（见方法顶部 JSDoc）
        if (item.dedupKey !== undefined) {
          const dedupHashKey = makeDedupHashKey(
            item.target.threadId,
            item.kind,
            item.dedupKey,
          );
          this.dedupIndex.delete(dedupHashKey);
        }
      } else {
        kept.push(item);
      }
    }
    // 替换队列内容（O(n)，可接受）
    this.items.length = 0;
    this.items.push(...kept);
    // 按优先级 + FIFO 排序
    matched.sort(compareEnvelopesForDrain);
    return matched;
  }

  /**
   * 不出队，仅返回 threadId 对应的待 drain 数量。
   * 用于 race-safe 触发器的"先 peek 再 drain"优化（见 PRD §6.3）。
   */
  peekByThreadId(threadId: string): number {
    let count = 0;
    for (const item of this.items) {
      if (item.target.threadId === threadId) count += 1;
    }
    return count;
  }

  // ─── subscribe ──────────────────────────────────────────────────

  /**
   * 订阅"队列有新内容"事件。返回 unsubscribe 函数。
   *
   * **同步调用**：listener 在 enqueue 同步栈中被调用。不要在 listener 里做耗时操作
   * （上层 consumer 应该 `queueMicrotask` 切异步后再 drain）。
   */
  subscribe(listener: NotificationQueueListener): NotificationQueueUnsubscribe {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  // ─── GC ─────────────────────────────────────────────────────────

  /** 启动周期性 GC。重复调 no-op。 */
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
   * 单次 GC 扫描。外部测试也可显式调（fake clock 配合）。
   *
   * 两件事：
   *   1. 删超过 TTL 的队列 item
   *   2. 删超过 dedup 窗口的 dedupIndex 项（防止 map 无限增长）
   */
  gcTick(now?: number): void {
    const t = now ?? this.clock();

    // 1. 删超过 TTL 的队列 item
    if (this.items.length > 0) {
      const kept = this.items.filter((item) => t - item.enqueuedAt <= this.ttlMs);
      if (kept.length !== this.items.length) {
        this.items.length = 0;
        this.items.push(...kept);
      }
    }

    // 2. 删超过 dedup 窗口的 dedupIndex 项
    for (const [key, ts] of this.dedupIndex.entries()) {
      if (t - ts > this.dedupWindowMs) {
        this.dedupIndex.delete(key);
      }
    }
  }

  // ─── 调试 / 监控辅助 ─────────────────────────────────────────────

  /** 当前队列总长度（所有 sessionId）。监控 / 调试用。 */
  size(): number {
    return this.items.length;
  }

  /** 当前 dedup 索引大小。监控 / 调试用。 */
  dedupIndexSize(): number {
    return this.dedupIndex.size;
  }
}

// ─── 内部排序辅助 ────────────────────────────────────────────────────

const PRIORITY_RANK: Record<NotificationPriority, number> = {
  now: 0,
  next: 1,
  later: 2,
};

function compareEnvelopesForDrain(
  a: NotificationEnvelope,
  b: NotificationEnvelope,
): number {
  const pa = PRIORITY_RANK[a.priority];
  const pb = PRIORITY_RANK[b.priority];
  if (pa !== pb) return pa - pb;
  return a.enqueuedAt - b.enqueuedAt;
}
