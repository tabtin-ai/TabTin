/**
 * BudgetTracker — shared token / credits / concurrency budget across an Agent tree.
 *
 * A single instance is created by the root query and passed by reference
 * to all child (forked) queries. Because JS is single-threaded, concurrent
 * Promise.allSettled children safely share the same tracker without locks.
 *
 * Wave 3 起 BudgetTracker 成为 token / cost 的**唯一数据源（Single Source of
 * Truth）**。EngineState 上的 `totalInputTokens` 等字段改为 BudgetTracker 的
 * 读视图——每次 `recordRequest` 之后由 query.ts 同步回写，消费方读到的始终是
 * BudgetTracker 累计值。未来 Wave 可逐步移除 EngineState 扁平字段。
 *
 * FR-17.1（H3-C）+ W4 (2026-05-26)：除 token / credits 之外，BudgetTracker 还
 * 承担 **per-parent** 的子 Agent 并发上限 + 排队队列。限制范围与 BudgetTracker
 * 实例绑定——agent-tool 在 fork 子 Agent 时调 `trySubmit({ speakerId })`，结果：
 *   - active 有空位 → state='active'，直接跑
 *   - active 满 + queue 有空位 → state='queued'，emit SUBAGENT_QUEUED + 等
 *     `onActivate(speakerId, callback)` 触发；正常路径子完成或失败时调
 *     `releaseChildAgent(speakerId)` 释放并 drainQueue 激活下一个
 *   - queue 满 → state='rejected'，reason='queue_full'，agent-tool 返中文 error
 *
 * 子 Agent 通过 `forkQuery` 继承同一个 tracker——token / credits 预算全树共享。
 *
 * （2026-07-06）：并发槽位改为**按嵌套深度分池**（depth 1 一池、
 * depth 2 一池，各自上限 maxConcurrentChildren）。此前全树单池会死锁：主 Agent
 * 并行派满 5 个 L1 后，每个 L1 前台再 fork L2 —— L1 占槽阻塞等 L2、L2 排队等
 * L1 释放槽，循环等待永不 drain。分池后浅池成员只会等待更深的池，而最深层
 * （MAX_SUBAGENT_DEPTH）的子已被结构性剔除 `agent` 工具、必然是叶子会完成并
 * 释放，等待关系严格单向，不可能成环。父阻塞等子时自己不跑 LLM，每条链同一
 * 时刻只有链末端在消耗模型，故实际 LLM 并发仍近似 maxConcurrentChildren。
 *
 * W4 删除 deprecated `acquireChildSlot` / `releaseChildSlot` 双轨——trySubmit
 * 是唯一调度入口。
 */

// ─── 累计字段结构 ────────────────────────────────────────────────────
/**
 * BudgetTracker 全局 / per-scope / per-model 的累计 token & cost 快照。
 * 所有数值均为不可变深拷贝——调用方修改不影响内部状态。
 */
export interface AccumulatedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  compactInputTokens: number;
  compactOutputTokens: number;
  credits: number;
}

/** `recordRequest` 接受的结构化参数。 */
export interface RecordRequestParams {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  chargeStatus?: string;
  model?: string;
  /** 'react' = 主循环；'compact' = compact 路径；'digest' = digest 工具单次调用。 */
  source?: 'react' | 'compact' | 'digest';
}

/** FIFO 请求明细条目（最近 N 条）。 */
export interface RequestEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  costUsd: number;
  model?: string;
  source?: 'react' | 'compact' | 'digest';
  timestamp: number;
}

interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  costUsd: number;
  source?: 'react' | 'compact' | 'digest';
}

/** wire 层 per-model 快照（snake_case，与 agent-wire `PerModelUsageSchema` 对齐）。 */
export interface PerModelUsageWire {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  reasoning_tokens?: number;
  compact_input_tokens?: number;
  compact_output_tokens?: number;
  credits?: number;
}

const MAX_RECENT_ENTRIES = 50;

export interface BudgetTrackerOptions {
  /** Max total tokens (input + output) across the entire agent tree. */
  maxTotalTokens?: number;
  /** Max credits (USD) across the entire agent tree. */
  maxCredits?: number;
  /**
   * FR-17.1：Max concurrent child agents per BudgetTracker instance.
   * Default `5` when unset (PRD §5.2 FR-17 & harness 总控 §18 决策)。
   *
   * 作用域（ 起）：**按嵌套深度分池**——每个 depth（子=1、孙=2）
   * 各自最多允许 maxConcurrentChildren 个 active 子 Agent 持有 slot。
   * 全树单池会在「父占槽阻塞等子」的嵌套场景死锁，见文件头注释。
   * `Infinity` 显式禁用限制；任何 ≤ 0 的值视为 `Infinity`
   * 并 silent fallback（避免运维误填 0 把所有子 Agent 都卡死）。
   *
   * 与全局 `DEFAULT_CONCURRENCY_LIMIT=50` 的区别：
   *   - DEFAULT_CONCURRENCY_LIMIT 是 tool-orchestration 层 **全局** 同时执行
   *     concurrencySafe 工具的硬上限（cross-session 共享）。
   *   - 本字段是 **per-parent**（per-BudgetTracker），由 host 在创建
   *     runtime 时构造一份 BudgetTracker 即一份 quota——天然按"每次
   *     用户对话"独立。
   */
  maxConcurrentChildren?: number;
  /**
   * PRD §5.1.3 + W4 (2026-05-26) D1 决策：scheduler queue 最大深度。
   *
   * active pool 满后 trySubmit 入 queue 排队；queue 满则 rejected。
   * Host 层默认传 95（DEFAULT_MAX_SUBAGENT_QUEUE，形成 5 + 95 总并发 100）。
   * 未传或非法值时 fallback 95——直接 new BudgetTracker({ maxConcurrentChildren: N })
   * 的简化场景也走 W4 默认值，避免双默认值分歧。
   *
   * 设计哲学（C3 派任务总是被接住）：保守 active 避免撞 LLM RPM；大 queue 让
   * "队列满"成为罕见兜底而不是常态。
   */
  maxQueueSize?: number;
}

// ─── Scheduler 类型（PRD §5.1.3 v0.3 + W4 trySubmit 唯一入口）─────────

export interface ChildSubmitConfig {
  speakerId: string;
  /**
   * ：被提交子 Agent 的嵌套深度（子=1、孙=2）。并发槽位按 depth
   * 分池，防止「父占槽等子、子排队等槽」死锁。缺省 1（旧调用方 / 测试视为
   * 第一层子）。
   */
  depth?: number;
}

export type SubmitResult =
  | { accepted: true;  state: 'active' }
  | { accepted: true;  state: 'queued' }
  | { accepted: false; state: 'rejected'; reason: 'queue_full' | 'budget_exhausted' };

export interface SchedulerStats {
  activeCount: number;
  queuedCount: number;
  maxActive: number;
  maxQueue: number;
}

// W4 (2026-05-26)：删除 deprecated `AcquireChildSlotResult` 接口（与
// acquireChildSlot / releaseChildSlot 方法一起退役）。trySubmit + SubmitResult
// 是唯一入口——按 C6「上线前不留兼容」精神。

export class BudgetTracker {
  // ─── 全局累计器（Wave 3 升级为完整 8 字段）───────────────────────
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheCreationTokens = 0;
  private reasoningTokens = 0;
  private compactInputTokens = 0;
  private compactOutputTokens = 0;
  private credits = 0;

  // ─── per-scope 分桶（子 Agent childId 维度）─────────────────────
  private scopeUsage = new Map<string, AccumulatedUsage>();

  // ─── per-model 分桶（Wave 3 新增）──────────────────────────────
  private byModel = new Map<string, AccumulatedUsage>();

  // ─── 最近 N 条请求明细（FIFO）──────────────────────────────────
  private recentEntries: RequestEntry[] = [];

  // ─── 最近一次 charge_status（Wave 3 新增）──────────────────────
  private chargeStatus: string | undefined;

  private readonly maxTotalTokens: number;
  private readonly maxCredits: number;
  /** FR-17.1：实际生效的并发上限（≤0 / 非数值 → Infinity）——**每个深度池**各自适用。 */
  private readonly maxConcurrentChildren: number;
  /**
   * FR-17.1 + ：当前活跃子 Agent slot 账本，speakerId → 嵌套深度。
   * 用 Map 而不是 counter 是为了：(1) 能 dedupe（同一 childId 重入时不重复占
   * slot）；(2) release 时能定位它属于哪个深度池；(3) 调试能直接看到哪些
   * child 占用 slot。并发判定按深度分池：`activeCountAtDepth(d) <
   * maxConcurrentChildren`，防止父（depth d）占槽阻塞等子（depth d+1）时
   * 与子竞争同一池造成死锁。
   */
  private readonly activeChildren = new Map<string, number>();

  // ─── Scheduler 内部状态（PRD §5.1.3）──────────────────────────────
  private readonly maxQueueSize: number;
  private readonly schedulerQueue: Array<{ speakerId: string; depth: number }> = [];
  private readonly activateCallbacks = new Map<string, () => void>();

  constructor(options: BudgetTrackerOptions = {}) {
    this.maxTotalTokens = options.maxTotalTokens ?? Infinity;
    this.maxCredits = options.maxCredits ?? Infinity;
    // ≤0 / 非有限值 → Infinity（容错）。值合法时 floor 一下保证整数槽位。
    const rawMaxChildren = options.maxConcurrentChildren;
    if (typeof rawMaxChildren === 'number' && Number.isFinite(rawMaxChildren) && rawMaxChildren > 0) {
      this.maxConcurrentChildren = Math.floor(rawMaxChildren);
    } else {
      this.maxConcurrentChildren = Infinity;
    }
    const rawMaxQueue = options.maxQueueSize;
    if (typeof rawMaxQueue === 'number' && Number.isFinite(rawMaxQueue) && rawMaxQueue >= 0) {
      this.maxQueueSize = Math.floor(rawMaxQueue);
    } else {
      // W4 (2026-05-26)：默认 40 → 95，与 host-knobs DEFAULT_MAX_SUBAGENT_QUEUE 对齐。
      this.maxQueueSize = 95;
    }
  }

  // ─── 核心写入 ──────────────────────────────────────────────────

  /**
   * Wave 3 主入口：结构化记录一次 LLM 请求的 token / cost。
   *
   * 内部：全局累加 → per-model 累加 → per-scope 累加 → compact 分桶 →
   * FIFO 明细 → chargeStatus。
   */
  recordRequest(usage: RecordRequestParams, scope?: string): void {
    const normalized = normalizeUsage(usage);

    this.recordGlobalUsage(normalized);
    if (usage.model) this.recordModelUsage(usage.model, normalized);
    if (scope) this.recordScopeUsage(scope, normalized);

    // FIFO 明细
    this.recentEntries.push({
      inputTokens: normalized.inputTokens,
      outputTokens: normalized.outputTokens,
      cacheReadTokens: normalized.cacheReadTokens,
      cacheCreationTokens: normalized.cacheCreationTokens,
      reasoningTokens: normalized.reasoningTokens,
      costUsd: normalized.costUsd,
      model: usage.model,
      source: usage.source,
      timestamp: Date.now(),
    });
    if (this.recentEntries.length > MAX_RECENT_ENTRIES) {
      this.recentEntries.shift();
    }

    // chargeStatus
    if (usage.chargeStatus) {
      this.chargeStatus = usage.chargeStatus;
    }
  }

  private recordGlobalUsage(usage: NormalizedUsage): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.cacheReadTokens += usage.cacheReadTokens;
    this.cacheCreationTokens += usage.cacheCreationTokens;
    this.reasoningTokens += usage.reasoningTokens;
    if (usage.costUsd > 0) this.credits += usage.costUsd;
    if (usage.source === 'compact') {
      this.compactInputTokens += usage.inputTokens;
      this.compactOutputTokens += usage.outputTokens;
    }
  }

  private recordModelUsage(model: string, usage: NormalizedUsage): void {
    const prev = this.byModel.get(model) ?? emptyAccumulated();
    addUsageToAccumulated(prev, usage);
    this.byModel.set(model, prev);
  }

  private recordScopeUsage(scope: string, usage: NormalizedUsage): void {
    const prev = this.scopeUsage.get(scope) ?? emptyAccumulated();
    addUsageToAccumulated(prev, usage);
    this.scopeUsage.set(scope, prev);
  }

  /**
   * @deprecated Wave 3 向后兼容 wrapper。新代码请用 `recordRequest()`。
   */
  recordUsage(input: number, output: number, costUsd?: number, scope?: string): void {
    this.recordRequest({ inputTokens: input, outputTokens: output, costUsd }, scope);
  }

  // ─── 查询方法 ──────────────────────────────────────────────────

  /** 返回全局累计的不可变快照（深拷贝）。 */
  getAccumulated(): AccumulatedUsage {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheCreationTokens: this.cacheCreationTokens,
      reasoningTokens: this.reasoningTokens,
      compactInputTokens: this.compactInputTokens,
      compactOutputTokens: this.compactOutputTokens,
      credits: this.credits,
    };
  }

  /** 返回 per-model 分桶的快照（内部 camelCase 格式）。 */
  getByModelRaw(): Record<string, AccumulatedUsage> {
    const result: Record<string, AccumulatedUsage> = {};
    for (const [model, usage] of this.byModel) {
      result[model] = { ...usage };
    }
    return result;
  }

  /** 返回 per-model 分桶的 wire 格式快照（snake_case，可直接序列化到 DONE payload）。 */
  getByModel(): Record<string, PerModelUsageWire> {
    const result: Record<string, PerModelUsageWire> = {};
    for (const [model, usage] of this.byModel) {
      result[model] = accumulatedToWire(usage);
    }
    return result;
  }

  /**
   * 返回相对 `baseline` 的 per-model 增量（wire 格式）——#2012 P2-1。
   *
   * 根 query 的 DONE.usage 标量字段已是「本 run 增量」（getAccumulated − 基线），
   * by_model 也须同口径，否则同一 payload 内 by_model（per-runtime 累计）与标量
   * （per-run）自相矛盾。本 run 内零消耗的模型（baseline 之前用过、本 run 没碰）
   * 跳过，避免列出全 0 噪声条目。
   *
   * `baseline` 缺省（子 query / 旧 host 未快照）时等价 `getByModel()`（全量累计），
   * 维持历史行为。
   */
  getByModelSince(
    baseline?: Record<string, AccumulatedUsage>,
  ): Record<string, PerModelUsageWire> {
    if (!baseline) return this.getByModel();
    const result: Record<string, PerModelUsageWire> = {};
    for (const [model, usage] of this.byModel) {
      const b = baseline[model];
      const delta: AccumulatedUsage = b
        ? {
            inputTokens: Math.max(0, usage.inputTokens - b.inputTokens),
            outputTokens: Math.max(0, usage.outputTokens - b.outputTokens),
            cacheReadTokens: Math.max(0, usage.cacheReadTokens - b.cacheReadTokens),
            cacheCreationTokens: Math.max(0, usage.cacheCreationTokens - b.cacheCreationTokens),
            reasoningTokens: Math.max(0, usage.reasoningTokens - b.reasoningTokens),
            compactInputTokens: Math.max(0, usage.compactInputTokens - b.compactInputTokens),
            compactOutputTokens: Math.max(0, usage.compactOutputTokens - b.compactOutputTokens),
            credits: Math.max(0, usage.credits - b.credits),
          }
        : { ...usage };
      if (
        delta.inputTokens === 0 && delta.outputTokens === 0 &&
        delta.cacheReadTokens === 0 && delta.cacheCreationTokens === 0 &&
        delta.reasoningTokens === 0 && delta.credits === 0
      ) {
        continue;
      }
      result[model] = accumulatedToWire(delta);
    }
    return result;
  }

  /** 返回 credits 总计。 */
  getCostAccumulated(): number {
    return this.credits;
  }

  /** 返回最近的 charge_status。 */
  getChargeStatus(): string | undefined {
    return this.chargeStatus;
  }

  /** 返回 compact 路径消耗的 token。 */
  getCompactUsage(): { inputTokens: number; outputTokens: number } {
    return { inputTokens: this.compactInputTokens, outputTokens: this.compactOutputTokens };
  }

  /** 返回最近 N 条请求明细（只读拷贝）。 */
  getRecentEntries(): readonly RequestEntry[] {
    return [...this.recentEntries];
  }

  getUsageByScope(scope: string): AccumulatedUsage {
    return { ...(this.scopeUsage.get(scope) ?? emptyAccumulated()) };
  }

  getRemainingBudget(): { tokens: number; credits: number } {
    return {
      tokens: Math.max(0, this.maxTotalTokens - (this.inputTokens + this.outputTokens)),
      credits: Math.max(0, this.maxCredits - this.credits),
    };
  }

  isExhausted(): boolean {
    if (this.maxTotalTokens !== Infinity) {
      if (this.inputTokens + this.outputTokens >= this.maxTotalTokens) return true;
    }
    if (this.maxCredits !== Infinity) {
      if (this.credits >= this.maxCredits) return true;
    }
    return false;
  }

  /** @deprecated Wave 3 兼容。新代码用 `getAccumulated()` 取完整快照。 */
  getUsage(): { inputTokens: number; outputTokens: number; credits: number } {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      credits: this.credits,
    };
  }

  /**
   * FR-15：暴露 token 上限给 IterationBudget 评估器（query.ts 顶部双通路兜底）。
   *
   * `Infinity` 表示未配置（IterationBudget 该通路自动 disabled，永远 normal）。
   */
  getMaxTotalTokens(): number {
    return this.maxTotalTokens;
  }

  // ─── FR-17.1: per-parent child concurrency ─────────────────────────

  /**
   * 当前活跃子 Agent 数量（已 acquire 但未 release 的）。
   *
   * 暴露给 agent-tool 在拒绝时构造 telemetry payload 用；测试也直接读。
   */
  getActiveChildrenCount(): number {
    return this.activeChildren.size;
  }

  /**
   * W-H③（2026-05-30）：某 speaker 当前是否真的占着 active slot。
   *
   * 用途：agent-tool 的 queued 子 Agent 在 `await onActivate` resolve 后，需要
   * 区分"真激活"与"budget 耗尽 drain 的假唤醒"。真激活只经 `_drainQueue` 正常
   * 分支（**先** `activeChildren.add` **再** resolve callback），所以此时返回
   * true；而 `_flushQueueCallbacks`（budget 耗尽）只 resolve callback、**不**
   * add active，返回 false。agent-tool 据此走取消分支，避免假激活绕过并发上限。
   *
   * 单线程下无 race：callback 同步触发，调用方在 await 之后的同一微任务里查询，
   * 期间不会有其它代码改动 `activeChildren`。
   *
   * Infinity 模式不会走 queued 路径（trySubmit 永远直接 active），此查询无意义
   * 但仍如实返回 Set 成员状态。
   */
  isActiveChild(speakerId: string): boolean {
    return this.activeChildren.has(speakerId);
  }

  /**
   * FR-17.1：获取生效的并发上限（含 `Infinity`）。
   *
   * 给 telemetry payload 用——上层不需要重复 typeguard。
   */
  getMaxConcurrentChildren(): number {
    return this.maxConcurrentChildren;
  }

  // ─── PRD §5.1.3: Scheduler API（trySubmit / onActivate / release / cancel）──
  //
  // W4 (2026-05-26)：删除 deprecated `acquireChildSlot` / `releaseChildSlot` 双轨。
  // 它们之前与 trySubmit + onActivate + releaseChildAgent 共存，但 agent-tool 只
  // 用旧 API → 满即返 error 不排队，违背 C3（派任务总是被接住）。
  // W4 切到 trySubmit 唯一入口，按 C6 不留兼容精神彻底删除。

  /** ：指定深度池当前占用的 slot 数。池成员数 ≤ maxConcurrentChildren（个位数），线性扫可接受。 */
  private activeCountAtDepth(depth: number): number {
    let count = 0;
    for (const d of this.activeChildren.values()) {
      if (d === depth) count++;
    }
    return count;
  }

  /**
   * 同步提交子 Agent 到调度器。
   *
   * 检查顺序：budget exhausted → 本深度池 active 有空位 → queue 有空位。
   * JS 单线程下无 race——内部禁止 await。
   *
   * ：并发槽位按 `config.depth` 分池（子=1、孙=2 各一池），排队
   * 队列全深度共享（maxQueueSize 总量）。分池后父（浅池）阻塞等子（深池）
   * 不会挤占子的槽位，等待关系严格从浅指向深、不可能成环。
   */
  trySubmit(config: ChildSubmitConfig): SubmitResult {
    if (this.isExhausted()) {
      return { accepted: false, state: 'rejected', reason: 'budget_exhausted' };
    }
    if (this.maxConcurrentChildren === Infinity) {
      return { accepted: true, state: 'active' };
    }
    const depth = normalizeDepth(config.depth);
    if (this.activeChildren.has(config.speakerId)) {
      return { accepted: true, state: 'active' };
    }
    if (this.schedulerQueue.some((q) => q.speakerId === config.speakerId)) {
      return { accepted: true, state: 'queued' };
    }
    if (this.activeCountAtDepth(depth) < this.maxConcurrentChildren) {
      this.activeChildren.set(config.speakerId, depth);
      return { accepted: true, state: 'active' };
    }
    if (this.schedulerQueue.length < this.maxQueueSize) {
      this.schedulerQueue.push({ speakerId: config.speakerId, depth });
      return { accepted: true, state: 'queued' };
    }
    return { accepted: false, state: 'rejected', reason: 'queue_full' };
  }

  /**
   * 订阅 queued 子 Agent 的 activate 事件。
   * 调用方在 trySubmit 返回 queued 后注册，releaseChildAgent 触发 drain 时回调。
   * 取消路径（cancelAllByParent / budget 耗尽）也会触发 callback 以避免
   * 调用方 Promise 永远 pending——上层应配合 AbortSignal 检测取消。
   */
  onActivate(speakerId: string, cb: () => void): void {
    this.activateCallbacks.set(speakerId, cb);
  }

  /**
   * 释放子 Agent 占用的 active slot（或从 queue 移除），并激活下一个。
   *
   * **三种命中情形**：
   *   - **active 命中**（正常完成 / 失败归还 slot）：从 activeChildren 删除
   *     → drainQueue 把队首激活。callback Map 此时已经被 `_drainQueue` /
   *     active 路径自己清掉，这里 delete 是兜底（一般为 no-op）。
   *   - **queue 命中**（取消队列中的子 Agent，W4 review P0-A 2026-05-26）：
   *     从 schedulerQueue 移除 + **invoke** callback 让上游
   *     `await new Promise<void>((resolve) => onActivate(id, resolve))`
   *     能 unblock；上层配合 `context.abortSignal.aborted` 区分"真激活
   *     vs 取消"（agent-tool.ts queued 路径已实现）。
   *     **不 drain**——取消 queued 子 Agent 不释放 active slot。
   *   - **都不命中**：no-op（防御编程）。
   *
   * **历史 bug**（已修，2026-05-26 W4 三视角 review P0-A）：之前 queue 命中
   * 时只 `activateCallbacks.delete()` 不调 callback → agent-tool 的
   * `await new Promise` 永远 pending → tool execute hang。语义改为"取消
   * 时也 invoke" 后与 `cancelQueued` 行为一致；cancelQueued 现在仅多返回
   * boolean 告诉调用方"是否真的在 queue 中"。
   */
  releaseChildAgent(speakerId: string): void {
    if (this.maxConcurrentChildren === Infinity) return;
    const wasActive = this.activeChildren.delete(speakerId);
    let wasQueued = false;
    if (!wasActive) {
      const idx = this.schedulerQueue.findIndex((q) => q.speakerId === speakerId);
      if (idx !== -1) {
        this.schedulerQueue.splice(idx, 1);
        wasQueued = true;
      }
    }
    // W4 review P0-A 修复（2026-05-26）：queue 内取消时 invoke callback 让
    // agent-tool 的 `await onActivate` 能 resolve；abortSignal 区分激活 vs 取消。
    const cb = this.activateCallbacks.get(speakerId);
    this.activateCallbacks.delete(speakerId);
    if (wasQueued && cb) cb();
    if (wasActive) this._drainQueue();
  }

  /**
   * 显式取消**单个** queued 子 Agent，并返回是否真的在 queue 中。
   *
   * 与 `releaseChildAgent` 的语义关系（2026-05-26 W4 review P0-A 修复后）：
   * - 两者对 **queued** speaker 的副作用完全一致：从 queue 移除 + invoke
   *   callback 让上游 `await Promise<void>((resolve) => onActivate(...))`
   *   unblock；上层配合 `context.abortSignal.aborted` 区分激活 vs 取消。
   * - `cancelQueued` 仅多返回 boolean 给调用方判断"是否真的在 queue 中"；
   *   `releaseChildAgent` 还兼顾 active 路径（归还 slot + drainQueue 头补位）。
   * - agent-tool 的 cancelSubagent 选 cancelQueued 是为了表达"显式取消而非
   *   归还 slot"的语义，并消费返回值确认 IPC 是否命中。
   *
   * 历史背景（P0-1 / 2026-05-26）：曾经 `releaseChildAgent` 在 queue 命中
   * 路径不调 callback → cancel 链路全断；引入 cancelQueued 作为修复入口。
   * W4 三视角 review P0-A 把"取消时 invoke callback" 合并进 releaseChildAgent
   * 后，两者对 queued 行为统一；cancelQueued 保留为"显式取消 + 返回 hit
   * boolean"语义。
   *
   * 返回 true 表示从 queue 中找到并移除；false 表示该 speakerId 不在 queue
   * （可能已激活、已完成、已被其他路径清掉等）。
   */
  cancelQueued(speakerId: string): boolean {
    const idx = this.schedulerQueue.findIndex((q) => q.speakerId === speakerId);
    if (idx === -1) return false;
    this.schedulerQueue.splice(idx, 1);
    const cb = this.activateCallbacks.get(speakerId);
    if (cb) {
      this.activateCallbacks.delete(speakerId);
      cb();
    }
    return true;
  }

  /**
   * 级联取消：清空 active set + queue，触发所有 pending onActivate 回调
   * 以避免调用方 Promise 永远 pending。上层应配合 AbortSignal 区分激活与取消。
   *
   * **预留 / 暂无生产 caller（W-H④ 标注，2026-05-30）**：本方法目前只有单测在用，
   * 生产链路无人调用。保留而非删除的理由：
   *   1. 它是 W4/W5「取消全部子 Agent」按钮（聚合卡右上角）的预期落点，下个 Wave
   *      接线时直接复用，删了又得重写 + 重测。
   *   2. 已有完整单测（budget-tracker-scheduler / concurrency-stress）钉死行为。
   * 注意：单独调本方法**不足以**真正中止运行中的子 Agent——它只动 BudgetTracker
   * 的 active/queue 账本，不持有 agent-tool 模块级 `activeChildren` 里的真实
   * AbortController。完整「取消全部」须由 host 层遍历 `getActiveSubagentIds()` 逐个
   * `cancelSubagent(id)`（各自 abort + release），故本方法不在 W0 单子 Agent 取消
   * 接线范围内，留待 W4/W5「取消全部」一并设计。
   */
  cancelAllByParent(): void {
    this.activeChildren.clear();
    this.schedulerQueue.length = 0;
    const pendingCallbacks = [...this.activateCallbacks.values()];
    this.activateCallbacks.clear();
    for (const cb of pendingCallbacks) cb();
  }

  /**
   * 返回调度器统计快照。
   */
  getSchedulerStats(): SchedulerStats {
    return {
      activeCount: this.maxConcurrentChildren === Infinity ? 0 : this.activeChildren.size,
      queuedCount: this.schedulerQueue.length,
      maxActive: this.maxConcurrentChildren,
      maxQueue: this.maxQueueSize,
    };
  }

  /**
   * 按 FIFO 找到第一个「其深度池有空位」的排队者入 active，调用其 onActivate 回调。
   * budget 耗尽时把 queue 全部清空并触发 callback（避免永久挂起）。
   * 每次 release 触发一次，一次只提升一个。
   *
   * ：queue 是全深度共享的，但激活须匹配释放出来的深度池——
   * 不能只看队首（队首可能属于仍然满的另一个深度池）。
   */
  private _drainQueue(): void {
    if (this.schedulerQueue.length === 0) return;
    if (this.isExhausted()) {
      this._flushQueueCallbacks();
      return;
    }
    const idx = this.schedulerQueue.findIndex(
      (q) => this.activeCountAtDepth(q.depth) < this.maxConcurrentChildren,
    );
    if (idx === -1) return;
    const [next] = this.schedulerQueue.splice(idx, 1);
    this.activeChildren.set(next.speakerId, next.depth);
    const cb = this.activateCallbacks.get(next.speakerId);
    if (cb) {
      this.activateCallbacks.delete(next.speakerId);
      cb();
    }
  }

  /**
   * 清空 queue 并触发所有 pending callback（budget 耗尽或异常退出路径）。
   */
  private _flushQueueCallbacks(): void {
    const items = this.schedulerQueue.splice(0);
    for (const item of items) {
      const cb = this.activateCallbacks.get(item.speakerId);
      if (cb) {
        this.activateCallbacks.delete(item.speakerId);
        cb();
      }
    }
  }
}

// ─── 内部 helper ──────────────────────────────────────────────────

/**
 * ：把调用方传入的 depth 规整为 ≥1 的整数池号。
 * 缺省 / 非法值一律归入池 1（旧调用方与单测不传 depth，行为等价于修前单池）。
 */
function normalizeDepth(depth: number | undefined): number {
  if (typeof depth === 'number' && Number.isFinite(depth) && depth >= 1) {
    return Math.floor(depth);
  }
  return 1;
}

function normalizeUsage(usage: RecordRequestParams): NormalizedUsage {
  return {
    inputTokens: Math.max(0, usage.inputTokens),
    outputTokens: Math.max(0, usage.outputTokens),
    cacheReadTokens: Math.max(0, usage.cacheReadTokens ?? 0),
    cacheCreationTokens: Math.max(0, usage.cacheCreationTokens ?? 0),
    reasoningTokens: Math.max(0, usage.reasoningTokens ?? 0),
    costUsd: typeof usage.costUsd === 'number' && usage.costUsd > 0 ? usage.costUsd : 0,
    source: usage.source,
  };
}

function addUsageToAccumulated(target: AccumulatedUsage, usage: NormalizedUsage): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheReadTokens += usage.cacheReadTokens;
  target.cacheCreationTokens += usage.cacheCreationTokens;
  target.reasoningTokens += usage.reasoningTokens;
  target.credits += usage.costUsd;
  if (usage.source === 'compact') {
    target.compactInputTokens += usage.inputTokens;
    target.compactOutputTokens += usage.outputTokens;
  }
}

function emptyAccumulated(): AccumulatedUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    compactInputTokens: 0,
    compactOutputTokens: 0,
    credits: 0,
  };
}

function accumulatedToWire(a: AccumulatedUsage): PerModelUsageWire {
  return {
    input_tokens: a.inputTokens,
    output_tokens: a.outputTokens,
    cache_read_tokens: a.cacheReadTokens || undefined,
    cache_creation_tokens: a.cacheCreationTokens || undefined,
    reasoning_tokens: a.reasoningTokens || undefined,
    compact_input_tokens: a.compactInputTokens || undefined,
    compact_output_tokens: a.compactOutputTokens || undefined,
    credits: a.credits || undefined,
  };
}
