/**
 * @tabtin/agent-runtime — PersistentQueue<T> 抽象与默认实现。
 *
 * FR-14（H2-D）持久化通路的"宿主无关"侧：Runtime 只定义抽象 + 内存实现；
 * 真正落盘 / IndexedDB / 远端 KV 等具体物理介质由宿主在启动时注入。
 *
 * W6c 后 renderer 侧的 `pendingSyncQueue.ts`（IndexedDB / POST /messages/sync）
 * 已废弃删除，**消息**持久化改由 relay ACK 驱动。
 *
 * 本接口仅服务于 **transcript event** 持久化（与消息持久化无关），运行在
 * **Runtime 主循环 / 宿主主进程**（Electron main / Daemon），
 * 模式：失败重试 → 持久化 → 启动恢复 → TTL 归档。
 * 详见 `packages/agent-runtime/SYNC_QUEUE.md`。
 *
 * ## 不变量（所有实现必须保证）
 *
 * 1. **永不丢数据**：`append` 成功返回前必须保证条目已落地（fsync / 写完
 *    再 resolve）。失败抛错让上层决定是否重试，不要静默吞。
 * 2. **id 唯一**：`append(entry)` 时若 id 已存在，应做 upsert 语义（用于
 *    `update`-after-`append` 的失败 + 累计重试场景）。
 * 3. **archive ≠ remove**：归档是"移到 archive 子库"——后续仍可审计/
 *    人工恢复；`remove` 是"上传成功后彻底删除"。
 * 4. **dispose 幂等**：连续多次 dispose 不抛、不重复释放。
 *
 * ## 失败模式约定
 *
 * - 实现内部 I/O 错误统一抛 `Error`；调用方（`SyncQueue`）会 try/catch
 *   并 emit telemetry。**不要**在实现内 emit telemetry——避免双重计数。
 */

/**
 * 账号 / 租户 / agent 归属信息（LH2-D3 引入）。
 *
 * 由 `SyncQueue` 在 enqueue / persistBatch 时注入，写到磁盘后用于：
 * 1. 多账号场景的目录分桶（详见 `sync-account.ts` 的
 *    `buildSyncAccountDir`），物理隔离不同账号的 transcript；
 * 2. recover / 上传前的 owner 校验——如果磁盘上某条 entry 的 owner
 *    与当前 `SyncQueue.owner` 不一致，**通过 `SyncQueue.onError` 报告
 *    `OwnerMismatchError`**（不向调用方抛错），并跳过该 entry：不上传 /
 *    不删除 / 仅在 entry 已超 TTL 时归档（reason='owner_mismatch_ttl'）。
 *    属于"目录分桶"之外的二次防御，保证就算分桶机制被绕过（恶意拷贝
 *    文件、未来路径调整 bug 等）也不会用 B 账号凭证发 A 账号数据。
 *
 * **不可变**：一旦 entry append 成功，owner 不应被 update 改写——
 * 否则会丢失"这条记录属于谁"的关键信息。`SyncQueue.recover` 走 update
 * 累加 attempts 时也只改 attempts/lastAttemptAt，owner 原样回写。
 *
 * 字段命名说明：
 * - `userId`、`organizationId`：camelCase 而非 snake_case（与 Runtime 内部
 *   `EngineConfig` / `telemetryContext` 风格一致；Django 协议层做映射）。
 * - `agentId`：可选，因为部分 entry 可能不绑定具体 agent（例如 host
 *   级 bootstrap recover 用的临时 SyncQueue）。
 */
export interface PersistedEntryOwner {
  userId: string;
  organizationId: string;
  agentId?: string;
}

export interface PersistedEntry<T> {
  /** 全局唯一 id（建议 UUID v4 / `crypto.randomUUID()`）。 */
  id: string;
  /** 业务负载（SyncQueue 场景下是 `TranscriptEntry[]`）。 */
  payload: T;
  /** 首次入队时间戳（ms since epoch），用于 TTL 计算。 */
  createdAt: number;
  /** 累计上传尝试次数（含已失败的）。 */
  attempts: number;
  /** 最近一次尝试时间戳（ms since epoch；从未尝试为 null）。 */
  lastAttemptAt: number | null;
  /**
   * 账号 / 租户 / agent 归属。LH2-D3 引入，**必填**——
   * 缺失意味着我们丢失了"这条 entry 属于谁"的关键信息，无法做
   * owner 校验，等价于 LH2-D1/D2/D3 整套机制失效。`SyncQueue` 在
   * 构造 / persistBatch 时强制注入；调用方不直接接触本字段。
   *
   * 历史兼容（LH2-D3 前的旧 entry）：磁盘上读到 `owner` 缺失的 entry
   * 视为 `unknown / unknown` owner，由 `SyncQueue.recover` 当作
   * mismatch 跳过（不上传不删除不归档），等运维手动迁移或归档目录
   * 自然 TTL 过期。详见 `SYNC_QUEUE.md §6 LH2-D3` 历史 entry 处理。
   */
  owner: PersistedEntryOwner;
}

/**
 * 持久化通路的"宿主无关"抽象。
 *
 * 实现示例（按消费者职责清晰度排序）：
 * - `InMemoryPersistentQueue`（本文件下方）：默认实现，进程退出即丢，
 *   等价"无持久化"，但满足同一接口便于上层统一编程。
 * - `FilePersistentQueue`（本目录 `persistent-queue-file.ts`）：基于 fs
 *   的 JSONL 实现，同时被 Electron main 进程 与 Daemon 复用。
 * - 未来可加 `SqlitePersistentQueue` / `IndexedDbPersistentQueue`（renderer
 *   场景）等。
 */
export interface PersistentQueue<T> {
  /**
   * 写入一个 entry 到主队列。
   * - 同 id 已存在 → upsert 覆盖（用于 SyncQueue 内部"先 append、失败再
   *   累加 attempts 调用 update"的场景）。
   * - I/O 失败抛 `Error`。
   */
  append(entry: PersistedEntry<T>): Promise<void>;
  /**
   * 启动时（或周期性 recover 时）读出主队列全部条目。
   * 顺序按 `createdAt` 升序，保证 FIFO 处理。
   */
  loadAll(): Promise<PersistedEntry<T>[]>;
  /**
   * 上传成功后从主队列删除。id 不存在时静默 no-op（幂等）。
   */
  remove(id: string): Promise<void>;
  /**
   * 累计 attempts / 时间戳后回写。等价于"upsert"，与 append 共享存储。
   */
  update(entry: PersistedEntry<T>): Promise<void>;
  /**
   * 把主队列条目移到归档（archive）子库。
   * - 用于 TTL 超时 / 达到 max attempts 的"知情放弃"。
   * - 不是删除，归档保留 `reason` 便于后续审计 / 工单恢复。
   */
  archive(
    entry: PersistedEntry<T>,
    reason: PersistedEntryArchiveReason,
  ): Promise<void>;
  /**
   * 释放底层资源（关文件句柄 / 关 IndexedDB 连接 / 停定时器）。
   * 幂等：连续 dispose 不抛错。
   */
  dispose?(): Promise<void> | void;
}

/**
 * 归档原因。
 *
 * - `'ttl'`：超过 TTL（默认 7 天）未成功上传，运维侧认为"数据失去时效"。
 * - `'max_attempts'`：达到固定 recover 重投次数上限后归档。
 * - `'non_retryable'`：服务端明确不可重试（session 不存在 / 权限拒绝等），
 *   recover 时直接归档，避免每次启动重复 warn。
 * - `'owner_mismatch_ttl'`（LH2-D3 follow-up）：entry.owner 与当前 SyncQueue.owner
 *   不一致（被恶意拷贝 / 历史 entry 缺 owner），且已超 TTL；归档而非长期占盘。
 *   保留单独 reason 便于运维区分"普通超时"和"归错家的孤儿"。
 */
export type PersistedEntryArchiveReason =
  | 'ttl'
  | 'max_attempts'
  | 'non_retryable'
  | 'owner_mismatch_ttl';

/**
 * 默认实现：纯内存版。语义等价"无持久化"——进程重启所有条目都丢。
 *
 * 存在的意义：
 * 1. 让 `SyncQueue` 永远依赖一个非空 PersistentQueue 实例，不必到处
 *    `?? someDefault`，简化主路径。
 * 2. 单测里可以方便地 mock 出可观察状态（不需要 fs / IndexedDB 副作用）。
 * 3. 宿主未配置持久化（`syncPersistence: false`）时的零成本占位。
 */
export class InMemoryPersistentQueue<T> implements PersistentQueue<T> {
  private readonly store = new Map<string, PersistedEntry<T>>();
  private readonly archiveStore: Array<{
    entry: PersistedEntry<T>;
    reason: PersistedEntryArchiveReason;
    archivedAt: number;
  }> = [];
  private disposed = false;

  async append(entry: PersistedEntry<T>): Promise<void> {
    this.assertOpen();
    this.store.set(entry.id, { ...entry });
  }

  async loadAll(): Promise<PersistedEntry<T>[]> {
    this.assertOpen();
    return Array.from(this.store.values())
      .map((e) => ({ ...e }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async remove(id: string): Promise<void> {
    this.assertOpen();
    this.store.delete(id);
  }

  async update(entry: PersistedEntry<T>): Promise<void> {
    this.assertOpen();
    this.store.set(entry.id, { ...entry });
  }

  async archive(
    entry: PersistedEntry<T>,
    reason: PersistedEntryArchiveReason,
  ): Promise<void> {
    this.assertOpen();
    this.archiveStore.push({ entry: { ...entry }, reason, archivedAt: Date.now() });
    this.store.delete(entry.id);
  }

  dispose(): void {
    this.disposed = true;
    this.store.clear();
  }

  // ── 测试辅助 ────────────────────────────────────────────────────

  /** 测试：当前主队列大小。 */
  size(): number {
    return this.store.size;
  }

  /** 测试：归档数量（带条件过滤可选）。 */
  archivedCount(reason?: PersistedEntryArchiveReason): number {
    if (reason === undefined) return this.archiveStore.length;
    return this.archiveStore.filter((a) => a.reason === reason).length;
  }

  /** 测试：导出归档（避免破坏内部数组）。 */
  archivedSnapshot(): ReadonlyArray<{
    entry: PersistedEntry<T>;
    reason: PersistedEntryArchiveReason;
    archivedAt: number;
  }> {
    return this.archiveStore.map((a) => ({ ...a, entry: { ...a.entry } }));
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error('InMemoryPersistentQueue: queue has been disposed');
    }
  }
}
