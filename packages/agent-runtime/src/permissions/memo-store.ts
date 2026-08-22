/**
 * `InMemoryApprovalMemoStore` — `ApprovalMemoStore` 的进程内实装（PRD 05 v0.4 §7.3）。
 *
 * 数据流（W2-轮 1 接通）：
 *
 *   ┌── always (跨会话跨设备) ────────────────────────────────────┐
 *   │  Django Agent.agent_config.approval_memo  ←──────────────┐ │
 *   │                ▲                                          │ │
 *   │                │ relay_handler 写入                        │ │
 *   │  WS approval_resolved(scope='always') ───┐                │ │
 *   │                                            │                │ │
 *   │  putAlways() ─── commit 回调（WS 上行）──┘                │ │
 *   │      ↑                                                    │ │
 *   │      │ (Layer 4 用户首次批 always 时调)                   │ │
 *   │  本地内存 Map                                              │ │
 *   │      ↓                                                    │ │
 *   │  getAlways() ←── 同步纯查缓存                            │ │
 *   │                                                            │ │
 *   │  WS approval_memo_updated(generation=N)──→ updateGeneration() │
 *   │      ↓ (本地 generation < N)                               │ │
 *   │  refetch() ─→ HTTP GET /api/agents/{id}/approval-memo ─→ replaceAll()
 *   └────────────────────────────────────────────────────────────┘
 *
 *   ┌── thread (本会话内) ────────────────────────────────────────┐
 *   │  putThread / getThread  ←→  纯内存 Map                     │
 *   │  thread 结束时 clearThread()                               │
 *   └────────────────────────────────────────────────────────────┘
 *
 * 本期范围（W2-轮 1）：实装数据结构 + Layer 4 命中检测；commit / refetch
 * 回调由宿主层（Daemon / Electron）后续 Wave 接通真实 WS / REST。当前默认
 * no-op，让 Layer 4 真接 store 而不是 stub。
 */

import type {
  ApprovalMemoEntry,
  ApprovalMemoStore,
} from './types.js';

export interface CommitAlwaysCallback {
  (approvalKey: string, entry: ApprovalMemoEntry): void | Promise<void>;
}

export interface RefetchAllCallback {
  (): Promise<{ entries: Record<string, ApprovalMemoEntry>; generation: number }>;
}

/**
 * W3-轮 1（PRD §7.6.2 接口 B）：cancelClient 回调签名。
 *
 * 由 host 层注入；典型走 HTTP POST 到 Django ``cancel_pending_approvals_by_thread``
 * REST 端点（07 PRD 启动后接通），返回值与 Django ``CancelPendingResult`` 字段对齐
 * （snake_case → camelCase）。
 *
 * 缺省（host 未注入）→ ``markPendingApprovalsStale`` 直接抛错让调用方降级处理。
 */
export interface CancelPendingApprovalsCallback {
  (
    threadId: string,
    reason: string,
    rollbackEventId?: string,
  ): Promise<{
    cancelledIds: string[];
    alreadyResolvedIds?: string[];
    notFound?: boolean;
  }>;
}

export interface InMemoryApprovalMemoStoreOptions {
  /** 启动时的初始 always entries（bootstrap 一次拉的快照）。 */
  initialAlways?: Record<string, ApprovalMemoEntry>;
  /** 启动时的初始 generation（PRD §8.1.2）。 */
  initialGeneration?: number;
  /** putAlways 时异步上行的 commit 回调（典型走 WS `approval_resolved`）。 */
  commitAlways?: CommitAlwaysCallback;
  /**
   * generation 比对失败时全量重拉（PRD §8.1.2）。
   * 调用方负责按外部信号（WS `approval_memo_updated`）触发 ``maybeRefetch``。
   */
  refetchAll?: RefetchAllCallback;
  /** 测试 / 排障用：commit 回调失败的容错日志钩子。 */
  onCommitError?: (err: unknown, key: string) => void;
  /**
   * W3-轮 1（PRD §7.6.2 接口 B）：``markPendingApprovalsStale`` 调用时
   * 走的 host 层 HTTP cancel client；典型 POST 到 Django
   * ``cancel_pending_approvals_by_thread`` REST 端点（07 PRD 启动后接通）。
   *
   * 缺省（host 未注入）→ ``markPendingApprovalsStale`` 抛错让调用方降级处理。
   */
  cancelPendingApprovals?: CancelPendingApprovalsCallback;
}

export class InMemoryApprovalMemoStore implements ApprovalMemoStore {
  private alwaysCache: Map<string, ApprovalMemoEntry>;
  private threadCache: Map<string, ApprovalMemoEntry>;
  private _generation: number;
  private commitAlways: CommitAlwaysCallback | undefined;
  private refetchAll: RefetchAllCallback | undefined;
  private onCommitError: ((err: unknown, key: string) => void) | undefined;
  private cancelPendingApprovals: CancelPendingApprovalsCallback | undefined;

  constructor(opts: InMemoryApprovalMemoStoreOptions = {}) {
    this.alwaysCache = new Map(Object.entries(opts.initialAlways ?? {}));
    this.threadCache = new Map();
    this._generation = opts.initialGeneration ?? 0;
    this.commitAlways = opts.commitAlways;
    this.refetchAll = opts.refetchAll;
    this.onCommitError = opts.onCommitError;
    this.cancelPendingApprovals = opts.cancelPendingApprovals;
  }

  get generation(): number {
    return this._generation;
  }

  getAlways(approvalKey: string): ApprovalMemoEntry | null {
    return this.alwaysCache.get(approvalKey) ?? null;
  }

  putAlways(approvalKey: string, entry: ApprovalMemoEntry): void {
    this.alwaysCache.set(approvalKey, entry);
    if (this.commitAlways) {
      // fire-and-forget；commit 错误走 onCommitError 容错日志，不抛
      try {
        const ret = this.commitAlways(approvalKey, entry);
        if (ret && typeof (ret as Promise<void>).then === 'function') {
          (ret as Promise<void>).catch((err) => {
            this.onCommitError?.(err, approvalKey);
          });
        }
      } catch (err) {
        this.onCommitError?.(err, approvalKey);
      }
    }
  }

  getThread(approvalKey: string): ApprovalMemoEntry | null {
    return this.threadCache.get(approvalKey) ?? null;
  }

  putThread(approvalKey: string, entry: ApprovalMemoEntry): void {
    this.threadCache.set(approvalKey, entry);
  }

  clearThread(): void {
    this.threadCache.clear();
  }

  /**
   * 接收外部信号（WS ``approval_memo_updated``）后比对 server generation；
   * 本地 generation 落后则触发 ``refetchAll`` 全量重拉。
   *
   * @returns true 如果触发了 refetch
   */
  async maybeRefetch(serverGeneration: number): Promise<boolean> {
    if (serverGeneration <= this._generation) return false;
    if (!this.refetchAll) {
      // 没注入 refetch 回调 — 本期 fallback 是只更新 generation，让客户端"知道
      // 自己缓存可能过期"但不真重拉；W2-轮 2 真接通后此分支基本不会走到（host
      // 装配时一定会注入 refetchAll），保留作纯单测桩位。
      this._generation = serverGeneration;
      return false;
    }
    const snapshot = await this.refetchAll();
    this.replaceAll(snapshot.entries, snapshot.generation);
    return true;
  }

  /**
   * 启动期 bootstrap：主动调一次 ``refetchAll`` 把 server 视图灌入 cache。
   *
   * 跟 ``maybeRefetch`` 区别：
   * - ``maybeRefetch(serverGeneration)`` 用于 WS 推到 generation 比对**已知**
   *   落后时才重拉；本地 generation=0 + 没人比对的情况下不会触发。
   * - ``bootstrap()`` 是 host 装配 store 时**主动**拉一次的入口——desktop B /
   *   Daemon 实例首次启动时本地 cache 是空的、server 端可能已经有 desktop A
   *   写过的 always entries，必须主动拉（PRD §7.3 + §8.1.2）。
   *
   * 失败语义：fail-soft——抛错被吞、log warn 后返回 false；本地 cache 保持空，
   * 下次审批走"不命中 + 弹审批"路径，不会因为 bootstrap 失败把 runtime 卡住。
   *
   * @returns true 表示成功 replaceAll；false 表示没注入 refetchAll 或失败
   */
  async bootstrap(): Promise<boolean> {
    if (!this.refetchAll) return false;
    try {
      const snapshot = await this.refetchAll();
      this.replaceAll(snapshot.entries, snapshot.generation);
      return true;
    } catch (err) {
      // 跟 commit 失败一致走 onCommitError 通道——给 host log 看到 bootstrap 失败
      // 而不是吞错；常用 key=``__bootstrap__`` 区分
      this.onCommitError?.(err, '__bootstrap__');
      return false;
    }
  }

  /**
   * 全量替换 always 缓存（refetch / bootstrap 完成后调用）。
   * thread-scope 不动。
   */
  replaceAll(entries: Record<string, ApprovalMemoEntry>, generation: number): void {
    this.alwaysCache = new Map(Object.entries(entries));
    this._generation = generation;
  }

  /**
   * commit 成功后单调推进 generation（W2-轮 2 自修复 CRITICAL #1）。
   *
   * 不替换 ``alwaysCache`` —— 仅同步 server 端最新 generation 到本地。
   * 用法：``commitAlways`` PUT 200 时从响应体读 ``data.generation``，
   * 调本方法把客户端 If-Match 推到最新值；下一笔 commit 不再撞 409。
   *
   * 单调性：``newGeneration <= this._generation`` 时不动作（防止旧响应回填
   * 把刚被 WS 推到更高 gen 的客户端拉低）。
   *
   * @returns true 表示 generation 被推进；false 表示忽略（旧值或同值）
   */
  advanceGeneration(newGeneration: number): boolean {
    if (newGeneration <= this._generation) return false;
    this._generation = newGeneration;
    return true;
  }

  /**
   * 测试 / 排障用：直接读 cancel client（让 host 接入 review 时不必再 grep）。
   */
  __debugHasCancelClient(): boolean {
    return !!this.cancelPendingApprovals;
  }

  /**
   * W3-轮 1（PRD §7.6.2 接口 B）：触发 Django 服务端权威清理 + 等结果。
   *
   * 行为：调用 host 注入的 ``cancelPendingApprovals`` 回调（典型走 HTTP POST
   * 到 Django ``cancel_pending_approvals_by_thread`` REST 端点），透传服务端
   * 返回的 ``cancelled_ids``。
   *
   * 与 host 层 envelope handler 配合：服务端清理完后会广播
   * ``agent.stream.approval_resolved(outcome='cancelled_by_rollback')`` 给
   * 所有镜像端 + runtime；runtime 层（``ElectronAgentHost`` /
   * ``DaemonAgentHost``）的 envelope handler 在收到广播后按 ``batch_id`` 找
   * pending 的 batch 决议 promise + resolve 成 deny + rejection_message
   * （详见 host 端 ``handleApprovalResolvedEnvelope`` 实装）。
   *
   * 缺省（host 未注入 cancel client）→ 抛错让调用方降级；fail-closed 优先于
   * 静默 swallow，避免调用方误以为已 cancel。
   */
  async markPendingApprovalsStale(
    threadId: string,
    reason: string,
    rollbackEventId?: string,
  ): Promise<{
    cancelledIds: string[];
    alreadyResolvedIds?: string[];
    notFound?: boolean;
  }> {
    if (!this.cancelPendingApprovals) {
      throw new Error(
        '[ApprovalMemoStore] markPendingApprovalsStale: no cancelClient wired; ' +
        'host must inject `cancelPendingApprovals` (typically HTTP POST to ' +
        'Django cancel_pending_approvals_by_thread)',
      );
    }
    return this.cancelPendingApprovals(threadId, reason, rollbackEventId);
  }

  /** 测试用：直接读出当前 always 缓存快照。 */
  __debugAlwaysSnapshot(): Record<string, ApprovalMemoEntry> {
    return Object.fromEntries(this.alwaysCache.entries());
  }

  /** 测试用：直接读出当前 thread 缓存快照（本会话 scope）。 */
  __debugThreadSnapshot(): Record<string, ApprovalMemoEntry> {
    return Object.fromEntries(this.threadCache.entries());
  }

  /** 测试用：当前 thread 缓存条数。 */
  __debugThreadSize(): number {
    return this.threadCache.size;
  }
}

// ─── W3-轮 1（PRD §7.6.2 接口 B）host envelope handler helper ────────

/**
 * Django 广播的 ``approval_resolved`` envelope payload 单条 decision。
 *
 * 与 ``@tabtin/agent-wire`` 的 ``ApprovalDecision`` 形状对齐，但本 helper
 * 故意不直接 import wire schema 避免循环依赖（runtime 包不依赖 wire）。
 */
export interface CancelledByRollbackDecision {
  request_id: string;
  tool_call_id: string;
  outcome: 'allow' | 'deny' | 'cancelled' | 'expired' | 'cancelled_by_rollback';
  rejection_message?: string;
}

/**
 * Host 端在收到 ``agent.stream.approval_resolved`` envelope（Django
 * cancel_pending_approvals_by_thread 广播）时，对每条
 * ``outcome === 'cancelled_by_rollback'`` 的 decision 解析对应 ``hitlMap``
 * 中的 promise resolver，按 batch 形态构造 ``handleSubmitHitlBatch`` 期望的
 * deny 决议（含 rejection_message）让 LocalPermissionHandler 主流程把它当成
 * "用户拒绝 + 文案=Cancelled by rollback"——LLM 自然看到 rollback 原因不会
 * 误以为用户主动 deny。
 *
 * 设计取舍（与 PRD §7.6.2 接口 B 对齐）：
 * - **decisions outcome 降级**：runtime 内部 ``BatchApprovalDecision.outcome``
 *   仅有 ``'allow' | 'deny' | 'cancelled'`` 三态（与 LocalPermissionHandler
 *   返回的 ``PermissionDecisionResult`` 同源）；
 *   ``'cancelled_by_rollback'`` 在 host 端被映射为 ``'cancelled'`` outcome +
 *   ``rejection_message`` 携带 "[crash-resume] 因用户回滚而取消" 文案，
 *   让 LLM 上下文自然消化（与 ``pending-approvals-restorer`` 的 cancelled
 *   tool_result 文案一致）。
 * - **不重复触发 channel 端**：调用方先把 hitlMap 中匹配条目 ``delete()``
 *   再 resolve，避免后续 ``handleSubmitHitlBatch`` 同 batch 二次 resolve（仅
 *   一次回响）。
 * - **fail-soft**：找不到 batch_id 对应 promise 时静默 skip（可能是另一台
 *   设备已先 resolve / runtime 还没挂上 pending）。
 *
 * 返回值含 ``resolvedBatchIds`` / ``orphanedRequestIds``，便于 host 层做
 * telemetry 和单测断言。
 */
export interface ApplyCancelledByRollbackInput {
  /**
   * 来自 broadcast envelope 的 ``payload.decisions[]``；只保留
   * ``outcome === 'cancelled_by_rollback'`` 的条目（其它 outcome 由本 helper
   * 内部过滤跳过）。
   */
  decisions: CancelledByRollbackDecision[];
  /**
   * batch_id 到 host 内部 hitl resolver entry 的映射；典型是 ElectronAgentHost
   * ``pendingHitlRequests`` map（key=batchId，value `{ sessionId, resolver }`）。
   *
   * helper 在内部完成 ``delete(batchId) + resolve()``；调用方不必自己处理 race。
   * Phase 3 F1 起 entry 携带 sessionId（与 ``cancelAllPendingHitlRequests`` 对齐），
   * 本 helper 仅消费 `.resolver` 字段，不感知 sessionId。
   */
  hitlMap: import('./hitl-cancel.js').PendingHitlMap;
  /** broadcast envelope 的 ``payload.batch_id``。 */
  batchId: string;
  /** 用户 / runtime 友好的 rollback 文案，写入 rejection_message 让 LLM 上下文消化。 */
  rejectionMessage?: string;
}

export interface ApplyCancelledByRollbackResult {
  /** 本次 resolve 命中的 batchId（一般是 0 或 1）。 */
  resolvedBatchIds: string[];
  /** envelope 含但 hitlMap 找不到的 request_id（telemetry 用）。 */
  orphanedRequestIds: string[];
}

export function applyCancelledByRollbackToHitl(
  input: ApplyCancelledByRollbackInput,
): ApplyCancelledByRollbackResult {
  const result: ApplyCancelledByRollbackResult = {
    resolvedBatchIds: [],
    orphanedRequestIds: [],
  };
  const matched = input.decisions.filter(
    (d) => d.outcome === 'cancelled_by_rollback',
  );
  if (matched.length === 0) return result;

  const entry = input.hitlMap.get(input.batchId);
  if (!entry) {
    // 没有匹配 pending —— 可能是 first-resolve 跨设备 race / 进程已重启
    // （interrupt_state 已被 Django 接口 A 清空，restore 时不会再挂）。
    for (const d of matched) {
      result.orphanedRequestIds.push(d.request_id);
    }
    return result;
  }

  // 构造 LocalRtUserResponse batch 形态：{ batch_id, decisions[] }，
  // 与 host handleSubmitHitlBatch 期望 schema 对齐（PRD §7.4
  // LocalRtUserResponsePayload）；outcome 降级为 'cancelled' +
  // rejection_message 携带 rollback 原因（runtime 内部 outcome 三态枚举不含
  // cancelled_by_rollback；详见 helper docstring 设计取舍）。
  const reason = input.rejectionMessage
    ?? '[crash-resume] 因用户回滚而取消（本次工具调用未实际执行）';
  const responsePayload = {
    batch_id: input.batchId,
    decisions: matched.map((d) => ({
      request_id: d.request_id,
      tool_call_id: d.tool_call_id,
      // 降级为 'cancelled'：与 LocalPermissionHandler 内部决议三态一致，
      // 同时 rejection_message 让 LLM 看到"rollback 取消"完整语义。
      outcome: 'cancelled' as const,
      rejection_message: reason,
    })),
  };

  input.hitlMap.delete(input.batchId);
  entry.resolver(responsePayload);
  result.resolvedBatchIds.push(input.batchId);
  return result;
}

/**
 * 便捷工厂：宿主装配时常用。
 *
 * @example
 * ```ts
 * const memoStore = createApprovalMemoStore({
 *   commitAlways: async (key, entry) => {
 *     await wsClient.publish('agent.stream.approval_resolved', {
 *       scope: 'always', approvalKey: key, decision: entry.decision,
 *     });
 *   },
 *   refetchAll: async () => {
 *     const res = await fetch(`/api/agents/${agentId}/approval-memo`);
 *     const body = await res.json();
 *     return { entries: body.data.entries, generation: body.data.generation };
 *   },
 * });
 * ```
 */
export function createApprovalMemoStore(
  opts: InMemoryApprovalMemoStoreOptions = {},
): InMemoryApprovalMemoStore {
  return new InMemoryApprovalMemoStore(opts);
}
