/**
 * SubagentManager —— **session 维度**的子 Agent 运行登记中心（W4a S1）。
 *
 * ## 为什么需要它
 *
 * 现状（W4a 之前）：子 Agent 的取消登记是 **模块级单例**——`agent-tool.ts` 里的
 * `activeChildren` / `queuedChildren` 两个 Map，key 仅 `childId`、**无 sessionId
 * 维度**。这对「父 query 内一次性 fork、随父 turn 同生命周期」的前台子够用，但
 * 一旦要做 W4a「后台子 + 完成回调」「resume 续跑」，就需要按 session 隔离地：
 *   - 登记 / 列举本会话的运行中子（telemetry、状态查询、UI 聚合）；
 *   - 在 **session 销毁 / host.stop()** 时只取消 *本 session* 的子，不误伤别的；
 *   - 作为第六节「live 依赖重绑定」的入口（后续 PR：emitter / AbortController /
 *     HITL channel / judge policy / budgetTracker 等从当前活体 runtime 重注）。
 *
 * 所以 W4a S1 把 Manager **挂到 `HostState`（每 session 一个）**，让它成为
 * session 维度的登记 SSoT。
 *
 * ## 与模块级 `cancelSubagent` 的关系（W0 取消链路不破坏）
 *
 * 本 PR（PR1）是**双写过渡**：
 *   - `agent-tool.ts` 在 active 子 spawn 时**同时**登记到模块 Map（W0 取消用，
 *     不动）**和**本 Manager（session 隔离视图，新增）；finally 同时注销两边。
 *   - 模块级 `cancelSubagent(childId)` 行为**完全不变**——它仍走 `activeChildren`
 *     / `queuedChildren`，W0（Daemon `cancelSubagentById` / Electron IPC
 *     `cancel-subagent`）取消链路零回归。
 *   - Manager 的 `cancel` / `dispose` 是**新增的 session 隔离取消路径**，PR1 不
 *     接入任何对外 caller（host.stop / session 重建时 dispose）；后续 PR
 *     （S4 后台子、S7 interrupt）才让它承担运行中子的取消。
 *
 * ## 实现范围
 *
 * PR1（S0-S2）：`registerRun` / `cancel` / `getStatus` / `list` / `dispose`。
 * PR2（S3-S5，2026-05-30）：
 *   - **S3 live 依赖重绑定**：`rebindLiveDeps` / `resolveLiveDeps` / `getLiveDeps`
 *     —— 后台子 outlive 父 turn、resume 子撞上 runtime 重建时，从「当前活着的
 *     session runtime」重读 6 类 live 依赖（emitter / HITL channel + waitForUserInput /
 *     judge policy + memoStore / budgetTracker + osErrorBlacklist），
 *     而非沿用 spawn 快照；session 已 dispose / 关键依赖不可重绑 → 显式报错让主
 *     Agent 重新派发（**禁止**静默 fail-closed deny）。详见 plan 第六节。
 *   - **S4 后台 detach**：`spawnBackground`（登记后台子，独立 AbortController）/
 *     `hasBackgroundRuns`（runtime 重建时判断是否有后台子需 carry-forward 而非
 *     dispose）。
 *   - **S5 完成回调链**：`notifyCompleted`（子终态 → host 注入的 `enqueueNotification`
 *     句柄 → NotificationQueue → 跨 turn 唤醒主 Agent）。
 * PR3（S6-S7 + P1，2026-05-30）：
 *   - **P1（PR2 终审）**：排队中的子也登记进 Manager（agent-tool 在排队 await 前
 *     `registerRun`/`spawnBackground` 标 `state='queued'` + `onCancel=cancelQueued`），
 *     让 `dispose()`/`cancel()` 能中断排队 await、`hasBackgroundRuns()` 看得到排队
 *     中的后台子、`getStatus()` 报出 'queued' 态。激活后转 'active' 重登记。
 *   - **S6 状态查询**：`reportProgress`（agent-tool while 循环每步回填 stepCount/
 *     latestTool）+ `getStatus` 扩出 stepCount/latestTool，让 `check_agent_id` 拿到
 *     running 子的实时步数/最近工具。
 *   - **S7 interrupt（中断重定向）**：`waitUntilSettled`（轮询 `!has(childId)` +
 *     超时兜底）—— interrupt 先 `cancelSubagent` 中断当前 run，再等子真正 settle
 *     （finally 跑完、storage flush、recordEnd(cancelled)）才走 W2 resume，避免同
 *     childId 两 run 并发写 messages.jsonl。
 */

import type { BudgetTracker } from '../engine/guards/budget-tracker.js';
import type {
  StreamEvent,
} from '../engine/contracts/wire-protocol.js';
import type {
  EngineConfig,
} from '../engine/contracts/kernel.js';
import type { SubagentCompletionEnvelope } from '../subagent/completion-envelope.js';

/**
 * 子 Agent **调度相位**（BudgetTracker active 槽 / 排队）。
 * ：与 UI 生命周期 `SubagentLifecycleStatus` 刻意区分命名，避免撞名。
 */
export type SubagentSchedulerState = 'active' | 'queued';

/**
 * @deprecated 使用 `SubagentSchedulerState`（ 消歧：本类型不是 UI 生命周期）。
 */
export type SubagentRunState = SubagentSchedulerState;

/**
 * 登记一个 run 时附带的元信息。除 `onCancel` 外都是只读快照（用于 list /
 * getStatus 观测）。
 */
export interface SubagentRunMeta {
  /** 子任务的人类可读描述（agent 工具 description / prompt 摘要）。 */
  label?: string;
  /** 子 Agent 本 run 起算时间戳（毫秒）。 */
  startedAt?: number;
  /** 当前调度相位（缺省 'active'）。 */
  state?: SubagentSchedulerState;
  /** 派发该子的父 LLM tool_use id（关联父 turn）。 */
  parentToolCallId?: string;
  /** 本次是否为 resume 续跑（W2）。 */
  resumed?: boolean;
  /**
   * S4：本次是否为**后台子**（detach、outlive 父 turn）。runtime 重建时据此
   * 判断是否需要 carry-forward Manager 而非 dispose（`hasBackgroundRuns`），
   * 避免误杀后台子。
   */
  background?: boolean;
  /**
   * 取消该 run 时，除 `abort()` 其 AbortController 外的**额外清理**。
   *
   * 典型用途：queued 子取消需要 `budgetTracker.cancelQueued(childId)`
   * 让 `await onActivate` unblock。PR1 只登记 active 子，`onCancel` 通常省略。
   */
  onCancel?: () => void;
}

/** `getStatus` / `list` 返回的只读状态快照。 */
export interface SubagentRunStatus {
  childId: string;
  state: SubagentSchedulerState;
  label?: string;
  startedAt?: number;
  parentToolCallId?: string;
  resumed?: boolean;
  /** S4：是否为后台子。 */
  background?: boolean;
  /**
   * S6（PR3）：本 run 已完成的 ReAct 步数（工具调用次数）。由 agent-tool 的 while
   * 循环经 `reportProgress` 实时回填；排队中 / 刚启动未跑工具时为 undefined / 0。
   */
  stepCount?: number;
  /**
   * S6（PR3）：本 run 最近一次调用的工具名（运行中视图）。由 `reportProgress`
   * 回填——cb_start 时为「正在启动的工具」，tool_completed 时为「刚完成的工具」。
   */
  latestTool?: string;
  /** 该 run 的 AbortController 是否已被 abort（取消 / 超时 / 父 abort）。 */
  cancelled: boolean;
  registeredAt: number;
}

interface SubagentRunEntry {
  childId: string;
  controller: AbortController;
  meta: SubagentRunMeta;
  registeredAt: number;
  /** S6（PR3）：可变进度——`reportProgress` 回填，`toStatus` 读出。 */
  stepCount?: number;
  latestTool?: string;
  /** ：本次登记绑定的 scope release；unregister 仅在本 entry 仍活跃时调用。 */
  scopeRelease?: () => void;
  /**  Wave2：主 Agent mid-flight 插话队列（仅 active run 消费）。 */
  pendingUserMessages?: string[];
}

/**  Wave2：主→子 mid-flight 插话结果。 */
export type InjectUserMessageResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_running' | 'empty' };

/** `registerRun` 返回的注销句柄——agent-tool 在 finally 调用。 */
export type SubagentRunUnregister = () => void;

/**
 * S3（plan 第六节）：子 runtime 的实时依赖。
 *
 * 后台子 outlive 父 turn、resume 子撞上 runtime 重建时，这些依赖必须从「当前活着
 * 的 session runtime」重读，而非沿用 spawn 时烘焙进 `AgentToolConfig` 的快照。
 * host 在每次 `createRuntimeForSession`（含 runtime 重建）后调 `rebindLiveDeps`
 * 把当下 runtime 的依赖灌进来；`agent-tool.ts` 的后台 / resume 分支经
 * `resolveLiveDeps` 取这份「活体」依赖去构造 forkQuery（缺某项时回落 config 同款）。
 *
 * 字段都标可选：host 漏配 / 测试只关心部分依赖时，`agent-tool` 用 `?? config.*`
 * 兜底，不致 crash。
 */
export interface SubagentLiveDeps {
  /**
   * 子 Agent 实时流出口（= host 的 `emitStreamEvent` 闭包，经 HostState 的
   * `subagentStreamSink` 路由）。本身已是「读当下 HostState」的活体闭包，rebind
   * 主要是登记到 Manager 让 resolveLiveDeps 能一并取到（语义完整）。
   */
  emitStreamEvent?: (event: StreamEvent) => void;
  /** 本会话当前的 BudgetTracker（runtime 重建会换新实例）。 */
  budgetTracker?: BudgetTracker;
  /** HITL 审批通道（缺则子 ask 落 fail-closed deny，plan 第六节致命点）。 */
  userInteractiveChannel?: EngineConfig['userInteractiveChannel'];
  /** HITL 等待用户输入闭包（host 级 pendingHitlRequests，跨 turn 稳定）。 */
  waitForUserInput?: EngineConfig['waitForUserInput'];
  /** 工具风险判决端口（读当前 yolo / workspace 快照）。 */
  toolRiskPolicy?: EngineConfig['toolRiskPolicy'];
  /**
   * 当前会话绑定的执行根。runtime 因 worktree 切换而重建后，后台 / resume
   * 子 Agent 必须与 toolRiskPolicy 使用同一代 workspace 根，避免相对路径解析
   * 与授权边界分裂。
   */
  workspaceRoot?: EngineConfig['workspaceRoot'];
  /** Organization 级 OS 错误黑名单（共享引用）。 */
  osErrorBlacklist?: EngineConfig['osErrorBlacklist'];
}

/** `resolveLiveDeps` 的结果：成功带活体依赖；失败带可读原因（给主 Agent）。 */
export type ResolveLiveDepsResult =
  | { ok: true; deps: SubagentLiveDeps | undefined }
  | { ok: false; reason: string };

/**
 * S5：子 Agent 终态信息——`notifyCompleted` 的入参。
 *
 * ：与 `@tabtin/agent-wire` 的 `SubagentCompletionEnvelope` 同构；
 * host 补 `parent_thread_id` 后入 NotificationQueue。deliverables / stats
 * 由 host enrich 或 runtime 终态路径填入，不再靠 `as` 走私字段。
 */
export type SubagentCompletionInfo = SubagentCompletionEnvelope;

export type ArmSubagentCompletionBarrierResult =
  | {
      ok: true;
      waitToolCallId: string;
      childIds: string[];
      pendingChildIds: string[];
      completions: SubagentCompletionInfo[];
    }
  | { ok: false; reason: string };

interface SubagentCompletionBarrier {
  /** 发起等待的父 Agent tool_use id。 */
  waitToolCallId: string;
  /** 规范化后的目标集合，最终通知按稳定顺序释放。 */
  childIds: string[];
  pendingIds: Set<string>;
  /** 屏障生效前已终态的目标 + 生效期间到达的所有后台完成通知。 */
  bufferedCompletions: Map<string, SubagentCompletionInfo>;
}

const MAX_TERMINAL_COMPLETIONS = 256;

/**
 * S5：host 注入的「把子完成事件投进 NotificationQueue」句柄。
 *
 * 跨层契约（plan 5.1「producer 跨层」）：子完成发生在平台无关的 agent-runtime 层，
 * 够不到 host 的 NotificationQueue（队列归 terminal 层）。host 在
 * `createRuntimeForSession` 把「构造 envelope（补 target spaceId/threadId）+ enqueue」
 * 包成本句柄注入 Manager；Manager 的 `notifyCompleted` 只管调它。
 *
 * 返回 `true` 入队成功 / `false` dedup 命中或队列不可用。
 */
export type EnqueueSubagentCompletion = (info: SubagentCompletionInfo) => boolean;

/** 子 Agent 登记时触发 CLI workspace scope lease 的 hook 入参。 */
export interface SubagentChildThreadScopeInput {
  childId: string;
  childThreadId: string;
  parentThreadId: string;
  parentScopeThreadIds: readonly string[];
}

export interface SubagentManagerOptions {
  /** 本 Manager 归属的父对话 thread（= HostState.sessionId）。 */
  parentThreadId: string;
  /**
   * 父会话用于 CLI scope 解析的 thread 候选（businessThreadId / runtimeThreadId /
   * sessionId 等）。缺省仅 parentThreadId。
   */
  parentScopeThreadIds?: readonly string[];
  /**
   * ：子 Agent 登记时绑定父会话 workspace scope lease；返回 release 句柄。
   * Electron host 注入；缺省时 no-op。
   */
  onChildThreadScope?: (input: SubagentChildThreadScopeInput) => (() => void) | void;
  /** 本会话所在 Space（观测 / 后续路由用）。 */
  spaceId?: string;
  /**
   * 本会话的 BudgetTracker 引用（与 agent-tool 共享同一份）。构造期初值；
   * runtime 重建时新 tracker 经 `rebindLiveDeps` 进入 `liveDeps.budgetTracker`。
   */
  budgetTracker?: BudgetTracker;
  /**
   * S5：host 注入的完成通知投递句柄（见 `EnqueueSubagentCompletion`）。
   * 缺省（旧 host / 单测不接完成回调）时 `notifyCompleted` no-op 返 false。
   */
  enqueueNotification?: EnqueueSubagentCompletion;
  /** 日志回调（默认 console.warn）。 */
  log?: (msg: string, err?: unknown) => void;
  /** 时间源（测试可注入 fake clock）。默认 Date.now。 */
  clock?: () => number;
}

export class SubagentManager {
  readonly parentThreadId: string;
  readonly parentScopeThreadIds: readonly string[];
  readonly spaceId: string | undefined;
  /** 本会话的 BudgetTracker（后续 PR 用；PR1 仅持有）。 */
  readonly budgetTracker: BudgetTracker | undefined;

  private readonly runs = new Map<string, SubagentRunEntry>();
  private readonly onChildThreadScope?: (input: SubagentChildThreadScopeInput) => (() => void) | void;
  private readonly childScopeReleases = new Map<string, () => void>();
  private readonly log: (msg: string, err?: unknown) => void;
  private readonly clock: () => number;
  private disposed = false;

  /** S3：当前活体 live 依赖（host 每次 createRuntimeForSession 后 rebind）。 */
  private liveDeps: SubagentLiveDeps | undefined;
  /** S5：host 注入的完成通知投递句柄。 */
  private enqueueNotification: EnqueueSubagentCompletion | undefined;
  /**
   * 最近终态缓存。
   *
   * 后台子完成时会先通知、后从 `runs` 注销。等待工具可能恰好落在注销之后，
   * 因此不能把“不在活动表”直接等同于“未知”。同 childId 重新登记时清除旧终态。
   */
  private readonly terminalCompletions = new Map<string, SubagentCompletionInfo>();
  /**
   * 父 Agent 的后台等待屏障，按发起 wait 的 tool_use id 隔离。
   *
   * 一个父会话可以自然地分批等待多组后台子任务；同一 tool_use id 重入时保持幂等。
   */
  private readonly completionBarriersByToolCallId = new Map<string, SubagentCompletionBarrier>();
  /** 有活动屏障时到达、但不属于任何屏障目标的完成通知；等所有屏障清空后再投递。 */
  private readonly blockedCompletionsOutsideBarriers = new Map<string, SubagentCompletionInfo>();

  constructor(opts: SubagentManagerOptions) {
    this.parentThreadId = opts.parentThreadId;
    this.parentScopeThreadIds = opts.parentScopeThreadIds?.length
      ? opts.parentScopeThreadIds
      : [opts.parentThreadId];
    this.spaceId = opts.spaceId;
    this.budgetTracker = opts.budgetTracker;
    this.onChildThreadScope = opts.onChildThreadScope;
    this.enqueueNotification = opts.enqueueNotification;
    this.log = opts.log ?? ((msg, err) => console.warn(`[SubagentManager] ${msg}`, err ?? ''));
    this.clock = opts.clock ?? (() => Date.now());
  }

  /** Manager 是否已 dispose（session 已销毁）。 */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * 登记一个运行中的子 Agent。返回**注销句柄**——调用方（agent-tool finally）
   * 在子结束时调它，从登记表移除。
   *
   * dispose 后再 registerRun 是 no-op（返回空注销句柄）：session 已销毁，
   * 不应再有新子加入——理论上不会发生（dispose 时父 turn 已 abort），防御兜底。
   *
   * 同 childId 重复登记（如 resume 复用 childId）：后者覆盖前者；注销句柄
   * 用引用比对保证「只注销自己那次登记」，不误删后来的重登记（run entry
   * 与 scope lease 均遵循同一归属校验）。
   */
  registerRun(
    childId: string,
    controller: AbortController,
    meta: SubagentRunMeta = {},
  ): SubagentRunUnregister {
    if (this.disposed) {
      this.log(`registerRun(${childId.slice(0, 8)}…) after dispose — ignored`);
      return () => {};
    }
    this.detachChildThreadScope(childId);
    const childThreadId = `agent-${childId}`;
    const releaseChildScope = this.onChildThreadScope?.({
      childId,
      childThreadId,
      parentThreadId: this.parentThreadId,
      parentScopeThreadIds: this.parentScopeThreadIds,
    });

    const entry: SubagentRunEntry = {
      childId,
      controller,
      meta,
      registeredAt: this.clock(),
      scopeRelease: releaseChildScope ?? undefined,
    };
    if (releaseChildScope) {
      this.childScopeReleases.set(childId, releaseChildScope);
    }
    this.terminalCompletions.delete(childId);
    this.runs.set(childId, entry);
    return () => {
      // 引用比对：仅当登记表里仍是「本次」entry 才删并释放 scope——避免旧
      // unregister（如 queued→active 重登记后的 A 句柄）误释放新 run 的 lease。
      const current = this.runs.get(childId);
      if (current === entry) {
        this.detachChildThreadScope(childId);
        this.runs.delete(childId);
      }
    };
  }

  /**
   * 取消某个登记中的子 Agent：abort 其 controller + 跑 onCancel 额外清理 +
   * 从登记表移除。返回是否命中。
   *
   * **注意（PR1）**：这是 Manager **自己的** session 隔离取消路径，PR1 不接入
   * 任何对外 caller（W0 取消仍走模块级 `cancelSubagent`）。后续 PR 才让它承担
   * 后台子 / interrupt 的取消。
   */
  cancel(childId: string): boolean {
    const entry = this.runs.get(childId);
    if (!entry) return false;
    this.abortEntry(entry);
    this.runs.delete(childId);
    return true;
  }

  /**
   * **S7（PR3）**：等待某 childId 的 run 真正 settle（finally 跑完、storage flush、
   * recordEnd 落盘、并发槽释放），即从登记表移除。
   *
   * **为什么靠 `!has(childId)`**：run 的清理在 `agent-tool.ts` 里收口于
   *   - 前台/后台 active：executeChildAgent 的 `finally` → `unregisterFromManager()`，
   *     而该 finally 必在 forkQuery 的 finally（storage dispose + recordEnd）**之后**
   *     执行（forkQuery 是被 `await gen.next()` 驱动的 generator，其 finally 的 await
   *     完成后 next() 才 settle）；
   *   - 排队中：被取消后 agent-tool 排队段 `unregisterQueuedFromManager()`。
   * 所以「登记表里没有它」⟺「这个 run 已彻底收尾」。**注意**：interrupt 路径用
   * `cancelSubagent`（abort signal）而非 `manager.cancel`（后者会**立刻**删登记表、
   * run 实际还没 settle），正是为了让本方法如实等到真 settle。
   *
   * 返回 `true` = 已 settle；`false` = 超时仍未 settle（调用方应放弃 resume 避免
   * 同 childId 并发写）。已不在登记表 → 立即 `true`。墙钟轮询（不走注入 clock，
   * 因 settle 本质是真实异步事件，需真实时间推进）。
   *
   * **注意（PR3 review P2-4）**：「`!has(childId)` ⟺ 已 settle」仅对**非 dispose 路径**
   * 成立——`dispose()` 会 `runs.clear()` 抢在子 forkQuery finally 真 flush 之前清表，
   * 使本方法提前返 true。但 dispose 同时置 `disposed=true`，后续 resume 在
   * `resolveLiveDeps()` 即被挡下（不会真并发写），故安全；勿在 disposed 之后复用本结论。
   */
  async waitUntilSettled(childId: string, timeoutMs: number, pollIntervalMs = 20): Promise<boolean> {
    if (!this.runs.has(childId)) return true;
    const startedAt = Date.now();
    return new Promise<boolean>((resolve) => {
      const tick = () => {
        if (!this.runs.has(childId)) {
          resolve(true);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          resolve(false);
          return;
        }
        const t = setTimeout(tick, pollIntervalMs);
        (t as { unref?: () => void }).unref?.();
      };
      const t0 = setTimeout(tick, pollIntervalMs);
      (t0 as { unref?: () => void }).unref?.();
    });
  }

  /** 查询某子 Agent 在本 session 的运行状态快照（不在登记表 → undefined）。 */
  getStatus(childId: string): SubagentRunStatus | undefined {
    const entry = this.runs.get(childId);
    if (!entry) return undefined;
    return this.toStatus(entry);
  }

  /**
   * **S6（PR3）**：回填运行中子 Agent 的实时进度（步数 / 最近工具）。
   *
   * 由 `agent-tool.ts` 的 while 循环在每次 SUBAGENT_PROGRESS emit 点调用一次——
   * 让 `getStatus` / `check_agent_id` 能报出 running 子的「已执行 N 步、最近工具 X」。
   * 不在登记表（已注销 / 排队未起跑）或已 dispose → no-op。只覆盖显式传入的字段。
   */
  reportProgress(childId: string, progress: { stepCount?: number; latestTool?: string }): void {
    if (this.disposed) return;
    const entry = this.runs.get(childId);
    if (!entry) return;
    if (typeof progress.stepCount === 'number') entry.stepCount = progress.stepCount;
    if (typeof progress.latestTool === 'string') entry.latestTool = progress.latestTool;
  }

  /** 列出本 session 当前所有登记中的子 Agent。 */
  list(): SubagentRunStatus[] {
    return [...this.runs.values()].map((e) => this.toStatus(e));
  }

  /** 本 session 当前登记中的子数量（监控 / 测试用）。 */
  size(): number {
    return this.runs.size;
  }

  /** 某 childId 是否在本 session 登记中。 */
  has(childId: string): boolean {
    return this.runs.has(childId);
  }

  /**
   *  Wave2：向运行中（state=active 且未 abort）的子 Agent 投递 user 指引。
   * 子 fork runtime 下一轮 beforeModel 经 `drainPendingUserMessages` 消费。
   */
  injectUserMessage(childId: string, text: string): InjectUserMessageResult {
    if (this.disposed) return { ok: false, reason: 'not_found' };
    const entry = this.runs.get(childId);
    if (!entry) return { ok: false, reason: 'not_found' };
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: 'empty' };
    const state = entry.meta.state ?? 'active';
    if (state !== 'active' || entry.controller.signal.aborted) {
      return { ok: false, reason: 'not_running' };
    }
    if (!entry.pendingUserMessages) entry.pendingUserMessages = [];
    entry.pendingUserMessages.push(trimmed);
    return { ok: true };
  }

  /**  Wave2：取走并清空某子 Agent 的待注入指引队列。 */
  drainPendingUserMessages(childId: string): string[] {
    const entry = this.runs.get(childId);
    if (!entry?.pendingUserMessages?.length) return [];
    const drained = [...entry.pendingUserMessages];
    entry.pendingUserMessages = [];
    return drained;
  }

  /**
   * 登记“等这些后台子 Agent 全部终态后再通知父 Agent”的一次性屏障。
   *
   * 已终态目标视为满足，只把仍在后台运行 / 排队的目标写入 pending。JS 同步执行
   * 保证校验与写入屏障之间不会被 notifyCompleted 插队。
   */
  armCompletionBarrier(
    waitToolCallIdOrChildIds: string | readonly string[],
    maybeChildIds?: readonly string[],
  ): ArmSubagentCompletionBarrierResult {
    if (this.disposed) {
      return { ok: false, reason: '当前子 Agent 会话已经失效，无法进入等待。' };
    }
    if (!this.enqueueNotification) {
      return { ok: false, reason: '当前宿主未配置子任务完成通知，无法进入后台等待。' };
    }
    const waitToolCallId = typeof waitToolCallIdOrChildIds === 'string'
      ? waitToolCallIdOrChildIds.trim()
      : '__legacy_wait_tool_call__';
    const childIds = typeof waitToolCallIdOrChildIds === 'string'
      ? maybeChildIds ?? []
      : waitToolCallIdOrChildIds;
    if (!waitToolCallId) {
      return { ok: false, reason: 'wait_agent_ids 缺少当前 tool_call_id，无法进入等待。' };
    }
    const normalizedIds = [...new Set(
      childIds
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean),
    )].sort();
    if (normalizedIds.length === 0) {
      return { ok: false, reason: 'wait_agent_ids 至少需要一个有效的子 Agent ID。' };
    }
    const existing = this.completionBarriersByToolCallId.get(waitToolCallId);
    if (existing) {
      const active = existing.childIds.join(',');
      const requested = normalizedIds.join(',');
      if (active === requested) {
        return {
          ok: true,
          waitToolCallId,
          childIds: [...normalizedIds],
          pendingChildIds: [...existing.pendingIds],
          completions: normalizedIds
            .map((childId) => existing.bufferedCompletions.get(childId))
            .filter((info): info is SubagentCompletionInfo => !!info),
        };
      }
      return {
        ok: false,
        reason: '当前等待工具调用已经绑定另一组后台子 Agent，请等待现有完成通知。',
      };
    }
    const pendingChildIds: string[] = [];
    const completions: SubagentCompletionInfo[] = [];
    for (const childId of normalizedIds) {
      const completion = this.terminalCompletions.get(childId);
      if (completion) {
        completions.push(completion);
        continue;
      }
      const run = this.runs.get(childId);
      if (!run) {
        return {
          ok: false,
          reason: `未找到当前会话中的后台子 Agent ${childId}，请核对 ID。`,
        };
      }
      if (run.meta.background !== true) {
        return {
          ok: false,
          reason: `子 Agent ${childId} 不是后台任务，不能登记后台等待屏障。`,
        };
      }
      pendingChildIds.push(childId);
    }
    if (pendingChildIds.length === 0) {
      return {
        ok: true,
        waitToolCallId,
        childIds: normalizedIds,
        pendingChildIds: [],
        completions,
      };
    }
    this.completionBarriersByToolCallId.set(waitToolCallId, {
      waitToolCallId,
      childIds: normalizedIds,
      pendingIds: new Set(pendingChildIds),
      bufferedCompletions: new Map(
        completions.map((info) => [info.subagent_run_id, info]),
      ),
    });
    return {
      ok: true,
      waitToolCallId,
      childIds: [...normalizedIds],
      pendingChildIds,
      completions,
    };
  }

  /** 某个后台子 Agent 是否已被登记进当前一次性完成屏障。 */
  isAwaitingCompletion(childId: string): boolean {
    for (const barrier of this.completionBarriersByToolCallId.values()) {
      if (barrier.pendingIds.has(childId)) return true;
    }
    return false;
  }

  /**
   * 当前父 run 没有真正进入挂起态时撤销屏障，并释放屏障期间暂存的完成通知。
   *
   * `endConversation`、hard-stop 或工具后处理异常都不能把一次未提交的屏障遗留
   * 到下个 run。之后到达的完成通知恢复普通逐条投递语义。
   */
  cancelCompletionBarrier(waitToolCallId?: string): boolean {
    if (waitToolCallId) {
      const barrier = this.completionBarriersByToolCallId.get(waitToolCallId);
      if (!barrier) return false;
      this.completionBarriersByToolCallId.delete(waitToolCallId);
      this.flushBarrierCompletions(barrier);
      this.flushBlockedCompletionsIfIdle();
      return true;
    }
    const barriers = [...this.completionBarriersByToolCallId.values()];
    if (barriers.length === 0) return false;
    this.completionBarriersByToolCallId.clear();
    for (const barrier of barriers) this.flushBarrierCompletions(barrier);
    this.flushBlockedCompletionsIfIdle();
    return true;
  }

  /**
   * 销毁本 Manager：取消**本 session 的所有**登记中子 Agent（abort + onCancel），
   * 清空登记表，标记 disposed。
   *
   * 由 host 在 `stop()` / session 销毁（runtime 重建覆盖旧 session）时调用——
   * 保证「关一个会话只取消它自己的后台子」，不波及别的 session（模块级单例做不到
   * 的 session 隔离）。幂等：重复调 no-op。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const childId of [...this.childScopeReleases.keys()]) {
      this.detachChildThreadScope(childId);
    }
    for (const entry of this.runs.values()) {
      this.abortEntry(entry);
    }
    this.runs.clear();
    // live 依赖 / 完成句柄随 session 销毁失效（resolveLiveDeps 走 disposed 分支报错）。
    this.liveDeps = undefined;
    this.enqueueNotification = undefined;
    this.completionBarriersByToolCallId.clear();
    this.blockedCompletionsOutsideBarriers.clear();
    this.terminalCompletions.clear();
  }

  // ─── S3：live 依赖重绑定（plan 第六节） ───────────────────────────────

  /**
   * **S3**：把「当前活着的 session runtime」的 6 类 live 依赖灌进 Manager。
   *
   * host 在每次 `createRuntimeForSession`（含 runtime 重建：换模型 / 切 persona /
   * 切 agentMode）末尾调用，传入当下 runtime 的依赖。这样后台子 / resume 子取
   * 依赖时拿到的是活体而非 spawn 快照。
   *
   * dispose 后调用是 no-op（session 已销毁，不该再 rebind）。可选同时刷新
   * `enqueueNotification`（reuse 同一 Manager 跨重建时保持完成句柄最新）。
   */
  rebindLiveDeps(deps: SubagentLiveDeps, enqueueNotification?: EnqueueSubagentCompletion): void {
    if (this.disposed) {
      this.log('rebindLiveDeps after dispose — ignored');
      return;
    }
    this.liveDeps = deps;
    if (enqueueNotification) this.enqueueNotification = enqueueNotification;
  }

  /**
   * **S3**：取当前活体 live 依赖（供 agent-tool 的后台 / resume 分支构造 forkQuery）。
   *
   * - session 已 dispose → `{ ok: false, reason }`——告诉主 Agent「该子 Agent 会话
   *   环境已失效，请重新派发」，**显式报错**而非静默 fail-closed deny（plan 第六节
   *   失败语义）。
   * - 未 dispose → `{ ok: true, deps }`（`deps` 可能 undefined：host 没 rebind 过，
   *   调用方回落 config 同款依赖，向后兼容）。
   */
  resolveLiveDeps(): ResolveLiveDepsResult {
    if (this.disposed) {
      return { ok: false, reason: '该子 Agent 会话环境已失效，请重新派发。' };
    }
    return { ok: true, deps: this.liveDeps };
  }

  /** 当前活体 live 依赖（未 rebind / 已 dispose → undefined）。监控 / 测试用。 */
  getLiveDeps(): SubagentLiveDeps | undefined {
    return this.disposed ? undefined : this.liveDeps;
  }

  // ─── S4：后台子登记 ───────────────────────────────────────────────

  /**
   * **S4**：登记一个**后台子**（detach、outlive 父 turn）。
   *
   * 与 `registerRun` 同语义，额外把 `meta.background` 标 true——让 runtime 重建
   * 时 `hasBackgroundRuns()` 能判出「本 session 还有后台子在跑」，host 据此
   * carry-forward 本 Manager（重绑依赖）而非 dispose（避免误杀，plan S3③）。
   */
  spawnBackground(
    childId: string,
    controller: AbortController,
    meta: SubagentRunMeta = {},
  ): SubagentRunUnregister {
    return this.registerRun(childId, controller, { ...meta, background: true });
  }

  /** 本 session 当前是否有后台子在登记中（runtime 重建 carry-forward 判据）。 */
  hasBackgroundRuns(): boolean {
    for (const entry of this.runs.values()) {
      if (entry.meta.background) return true;
    }
    return false;
  }

  /** 本 session 当前是否有父 run 已提交的后台完成等待屏障。 */
  hasCompletionBarriers(): boolean {
    return this.completionBarriersByToolCallId.size > 0;
  }

  // ─── S5：完成回调链（plan 5.1） ───────────────────────────────────

  /**
   * **S5**：子 Agent 终态 → 投进 host 的 NotificationQueue（跨 turn 唤醒主 Agent）。
   *
   * 由 agent-tool 的后台 detach 终态调用（**不**走前台 finally，避免阻塞主 turn）。
   * 经 host 注入的 `enqueueNotification` 句柄完成跨层投递。缺句柄（旧 host /
   * 单测不接完成回调）→ no-op 返 false。dedup 由 NotificationQueue 按
   * `childId` 去重（host 端 envelope 的 dedupKey = subagent_run_id）。
   */
  notifyCompleted(info: SubagentCompletionInfo): boolean {
    if (this.disposed) return false;
    if (!this.enqueueNotification) return false;
    this.rememberCompletion(info);
    const activeBarriers = [...this.completionBarriersByToolCallId.values()];
    if (activeBarriers.length === 0) {
      return this.enqueueCompletion(info);
    }
    const matchingBarriers: SubagentCompletionBarrier[] = [];
    let targetBarrierCount = 0;
    for (const barrier of activeBarriers) {
      if (!barrier.childIds.includes(info.subagent_run_id)) continue;
      targetBarrierCount += 1;
      barrier.bufferedCompletions.set(info.subagent_run_id, info);
      if (barrier.pendingIds.has(info.subagent_run_id)) matchingBarriers.push(barrier);
    }
    // 有活动屏障时，非目标完成也先缓存，避免父 run 因无关后台完成提前继续。
    if (targetBarrierCount === 0) {
      this.blockedCompletionsOutsideBarriers.set(info.subagent_run_id, info);
      return true;
    }
    if (matchingBarriers.length === 0) return true;

    for (const barrier of matchingBarriers) {
      barrier.pendingIds.delete(info.subagent_run_id);
      if (barrier.pendingIds.size > 0) continue;
      this.completionBarriersByToolCallId.delete(barrier.waitToolCallId);
      this.flushBarrierCompletions(barrier);
    }
    this.flushBlockedCompletionsIfIdle();
    return true;
  }

  private flushBarrierCompletions(barrier: SubagentCompletionBarrier): boolean {
    let accepted = false;
    for (const childId of barrier.childIds) {
      const completion = barrier.bufferedCompletions.get(childId);
      if (completion && this.enqueueCompletion(completion)) accepted = true;
    }
    return accepted;
  }

  private flushBlockedCompletionsIfIdle(): boolean {
    if (this.completionBarriersByToolCallId.size > 0) return false;
    if (this.blockedCompletionsOutsideBarriers.size === 0) return false;
    const completions = [...this.blockedCompletionsOutsideBarriers.values()];
    this.blockedCompletionsOutsideBarriers.clear();
    let accepted = false;
    for (const completion of completions) {
      if (this.enqueueCompletion(completion)) accepted = true;
    }
    return accepted;
  }

  private rememberCompletion(info: SubagentCompletionInfo): void {
    this.terminalCompletions.delete(info.subagent_run_id);
    this.terminalCompletions.set(info.subagent_run_id, info);
    while (this.terminalCompletions.size > MAX_TERMINAL_COMPLETIONS) {
      const oldestChildId = this.terminalCompletions.keys().next().value as string | undefined;
      if (!oldestChildId) break;
      this.terminalCompletions.delete(oldestChildId);
    }
  }

  private enqueueCompletion(info: SubagentCompletionInfo): boolean {
    let accepted = false;
    try {
      accepted = this.enqueueNotification?.(info) ?? false;
    } catch (err) {
      this.log(`notifyCompleted enqueue threw for ${info.subagent_run_id.slice(0, 8)}…`, err);
    }
    return accepted;
  }

  // ─── internal ────────────────────────────────────────────────────

  private detachChildThreadScope(childId: string): void {
    const release = this.childScopeReleases.get(childId);
    if (!release) return;
    this.childScopeReleases.delete(childId);
    try {
      release();
    } catch (err) {
      this.log(`childThreadScope.release threw for ${childId.slice(0, 8)}…`, err);
    }
  }

  private abortEntry(entry: SubagentRunEntry): void {
    try {
      entry.controller.abort();
    } catch (err) {
      this.log(`controller.abort threw for ${entry.childId.slice(0, 8)}…`, err);
    }
    if (entry.meta.onCancel) {
      try {
        entry.meta.onCancel();
      } catch (err) {
        this.log(`onCancel threw for ${entry.childId.slice(0, 8)}…`, err);
      }
    }
  }

  private toStatus(entry: SubagentRunEntry): SubagentRunStatus {
    return {
      childId: entry.childId,
      state: entry.meta.state ?? 'active',
      label: entry.meta.label,
      startedAt: entry.meta.startedAt,
      parentToolCallId: entry.meta.parentToolCallId,
      resumed: entry.meta.resumed,
      background: entry.meta.background,
      stepCount: entry.stepCount,
      latestTool: entry.latestTool,
      cancelled: entry.controller.signal.aborted,
      registeredAt: entry.registeredAt,
    };
  }
}
