/**
 * @tabtin/agent-runtime — Session Sync Queue（FR-14 H2-D 持久化版）
 *
 * 收集 SessionStorage.onWrite 产生的 TranscriptEntry，攒批后送给宿主注入
 * 的 `uploadFn`。三次连续失败后落 `PersistentQueue<TranscriptEntry[]>`，
 * 启动时 `recover()` 自动重试；超过 TTL 未上传的批次归档（不删除）。
 *
 * 与 v1 行为差异（迁移注意点）：
 * - 失败不再 unshift 回内存——内存队列只保护"还没尝试过"的新条目；
 *   失败的 batch 走 PersistentQueue（默认 InMemoryPersistentQueue 等价
 *   "无持久化"，行为退化与 v1 兼容）。
 * - `uploadFn` 仍可为空：未注入时 flush 直接 no-op + 清空当前 batch
 *   （等价 "Phase 6 之前的本地累积"），不会触发任何重试 / 持久化。
 *   宿主在 Phase 6 接通后只需注入 `uploadFn`；持久化通路自动生效。
 *
 * Telemetry（H1-E 协议；事件清单见 `TELEMETRY.md §6.7`）：
 * - `sync.queued`                    入队成功（每 enqueue 一条 TranscriptEntry）
 * - `sync.failed`                    一次 batch 上传失败（含 `attempt` 当前已尝试次数）
 * - `sync.persisted`                 达到 maxAttempts 后写入 PersistentQueue
 * - `sync.persist_failed`            persistBatch 时 PersistentQueue.append 抛错（数据丢失）
 * - `sync.recovered`                 recover() 从 PersistentQueue 重试上传成功
 * - `sync.archived`                  TTL 超时 / max-attempts 后归档
 * - `sync.bootstrap_recover_failed`  宿主 bootstrap 注入 onError 上报的 recover 子阶段失败
 *   （loadAll / archive / persist 等；本类不直接发，由宿主在临时 SyncQueue 注入
 *   `onError` 时转译。详见 `ElectronAgentHost.start()` / `DaemonAgentHost.start()`）
 *
 * @see packages/agent-runtime/SYNC_QUEUE.md
 */

import type {
  TranscriptEntry,
} from '../engine/contracts/context-capability.js';
import { TelemetryEvents } from '../telemetry/events.js';
import { emitTelemetryEvent } from '../telemetry/emitter.js';
import {
  InMemoryPersistentQueue,
  type PersistedEntry,
  type PersistedEntryOwner,
  type PersistentQueue,
} from './persistent-queue.js';
import { assertValidOwner, ownersMatch } from './sync-account.js';

/**
 * Owner 不匹配错误（LH2-D3）。
 *
 * 触发场景：
 * - `recover()` 时磁盘上的 entry.owner 与当前 SyncQueue.owner 不一致：
 *   B 账号启动时不小心读到了 A 账号的目录，或者文件被人手动拷贝；
 * - upload 链路中（Phase 6 接通后），本类不会自己抛——校验在 `recover()`
 *   内部 swallow 成 `failed` 计数 + onError 上报。
 *
 * 这是个**预期的拒绝**而非"程序 bug"——所以不打 stack trace 也行；保留
 * 字段化的 entryOwner / currentOwner 便于宿主转 telemetry / 排障。
 *
 * **被拒 entry 的处理策略**（产品决策）：
 *   1. **不删除**：万一未来正确账号登录回来，仍能通过磁盘扫描发现并恢复；
 *   2. **不归档**：归档是"业务上放弃"，owner mismatch 更像"暂时不属于我"；
 *   3. **不上传**：明确拒绝，避免拿当前凭证发别人的数据；
 *   4. 由 `sync.recover` 内的 `failed` 计数 + telemetry 让运维感知。
 *
 * 长期堆积风险：如果某账号永远不再登录，被拒 entry 会一直留在 disk 上，
 * 直到 TTL 归档（7 天）触发清理。LH2-D5（archive GC）可以一并解决。
 */
export class OwnerMismatchError extends Error {
  constructor(
    public readonly entryId: string,
    public readonly entryOwner: PersistedEntryOwner,
    public readonly currentOwner: PersistedEntryOwner,
  ) {
    const ownerStr = (o: PersistedEntryOwner): string =>
      `${o.userId}/${o.organizationId}${o.agentId ? `/agent=${o.agentId}` : ''}`;
    super(
      `SyncQueue owner mismatch: entry ${entryId} belongs to ` +
        `${ownerStr(entryOwner)} but current SyncQueue is bound to ` +
        `${ownerStr(currentOwner)}; refusing to upload / mutate`,
    );
    this.name = 'OwnerMismatchError';
  }
}

export interface SyncQueueOptions {
  /**
   * 账号 / 租户 / agent 归属（LH2-D3，**必填**）。
   *
   * 每条入队 entry 在 persistBatch 时自动注入此值；recover 路径上若
   * 磁盘上某 entry 的 owner 与本字段不一致，则视为 mismatch 拒绝处理
   * （`OwnerMismatchError`），不上传不归档不删除。
   *
   * 设计强制必填的理由：
   * - 任何"忘记传 owner = unknown owner = 全部 entry 在 recover 路径
   *   被当作 mismatch 跳过"，等于持久化通路完全失效——这是 LH2-D3 任务
   *   显式禁止的"为了简单做成 optional"。让构造时抛错强迫调用方先想清楚
   *   "我这个 SyncQueue 服务的是谁"。
   * - 与 `EngineConfig.workspaceRoot` 同构地强制约束（FR-13），降低
   *   "Daemon 跑在错路径"这类老问题的出现概率。
   *
   * 参见 `sync-account.ts.assertValidOwner` 的字符校验。
   */
  owner: PersistedEntryOwner;

  /** Batch upload interval in ms (default 5 000) */
  flushIntervalMs?: number;
  /** Flush immediately when queue reaches this size (default 50) */
  flushThreshold?: number;
  /**
   * Actual upload implementation — Phase 6 will inject this.
   *
   * 契约：
   * - 整批成功 → resolve（SyncQueue 视为已上传，不会再持久化）。
   * - 任一条目失败 → reject（整批进入退避重试 / 持久化兜底；不支持
   *   "部分成功"。如果未来需要部分成功，让 uploadFn 内部对成功条目
   *   去重 + 抛 `PartialFailureError` 含未成功 id 列表，扩展本接口）。
   */
  uploadFn?: (entries: TranscriptEntry[]) => Promise<void>;

  // ─── FR-14 新增字段 ────────────────────────────────────────────

  /**
   * 持久化通路。默认 `InMemoryPersistentQueue`（等价无持久化）。
   * 宿主开启 `EngineConfig.syncPersistence` 时注入 `FilePersistentQueue`
   * 或自定义实现。
   */
  persistentQueue?: PersistentQueue<TranscriptEntry[]>;
  /**
   * 是否在 `SyncQueue.dispose()` 时连带 dispose `persistentQueue`。
   *
   * - 默认推断：传入 `persistentQueue` 视为"宿主拥有"，**默认 `false`**——
   *   SyncQueue.dispose 不会动外部传入的实例（避免宿主级共享 queue 被
   *   bootstrap recover 流程误关）。未传 `persistentQueue` 时使用内部新建
   *   的 `InMemoryPersistentQueue`，**默认 `true`**——这种"自己创建自己释放"
   *   的小队列在 SyncQueue 销毁后无人引用，dispose 是必须的。
   * - 显式覆盖：宿主可以强行设为 `true`/`false`，例如多个 SyncQueue 共享
   *   同一持久化但其中一个负责生命周期。
   *
   * **修复历史**：技术 Review #1 发现 bootstrap `recover` 用临时 SyncQueue 时
   * 默认 dispose 共享 PersistentQueue 会让 host 后续 session 全挂；这个字段
   * 是该问题的契约级修复。
   */
  ownsPersistentQueue?: boolean;
  /**
   * 失败重试间隔序列（ms）。每次 `flush` 失败后等待对应位置的延迟
   * 重新尝试；用尽后将 batch 写入 `persistentQueue`。
   *
   * 默认 `[1_000, 5_000, 25_000]` —— 1s / 5s / 25s 三次（指数退避因子≈5），
   * 总等待 ~31s 后落地。修改此数组即可改成更激进 / 更保守的策略。
   */
  retryDelaysMs?: number[];
  /**
   * 持久化条目 TTL（ms）。超过此时长仍未成功上传的条目在 `recover`
   * 时归档（移到 archive 子库），不再尝试上传。
   *
   * 默认 7 天 = `7 * 24 * 60 * 60 * 1000`。
   *
   * 设计考虑：
   * - 7 天覆盖一个普通工作周；用户切换设备 / 离线再上线场景的合理上限。
   * - 超过 7 天的 transcript 大概率已失去业务价值（agent 上下文已变化）。
   * - 归档不是删除——仍可审计。如有特殊场景需要长期保留，宿主自定义实现。
   */
  ttlMs?: number;
  /**
   * 时间源（ms epoch）。注入用于测试，生产保留默认 `Date.now`。
   */
  now?: () => number;
  /**
   * Telemetry 上下文：sessionId / agentId 透传到每条 emit。
   */
  telemetryContext?: { session_id?: string; agent_id?: string };
  /**
   * id 生成器。默认 `crypto.randomUUID()`；测试可注入确定性 id。
   */
  newId?: () => string;
  /**
   * 错误回调（持久化 I/O 失败 / uploadFn 异常等）。
   * 默认 silent——业务上 sync 失败应通过 telemetry 观察，本回调用于
   * 测试 / 宿主额外打 logger。
   */
  onError?: (
    err: Error,
    ctx: { phase: 'flush' | 'persist' | 'archive' | 'recover' },
  ) => void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_FLUSH_THRESHOLD = 50;
const DEFAULT_RETRY_DELAYS_MS = [1_000, 5_000, 25_000];
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 默认 id 生成器。优先用 `crypto.randomUUID`（Node 19+ / 现代浏览器），
 * 退化时拼"时间戳 + 随机数"——满足"进程内唯一 + 可读"即可，因为
 * `PersistedEntry.id` 不参与安全判断。
 */
function defaultNewId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `sync-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class SyncQueue {
  /** 待 flush 的内存批次（**未尝试过**的条目）。 */
  private queue: TranscriptEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private disposed = false;
  /**
   * dispose 时唤醒所有 in-flight retry sleep。技术 Review #3 修复：旧实现在
   * `await sleep(25_000)` 期间宿主调 dispose，sleep 仍然会自然走完才看到
   * `disposed=true`——最坏 25s 延迟，且 sleep 醒后还会触发一次 SYNC_FAILED
   * 到可能已被替换的 telemetry sink，并尝试 `persistBatch.append` 写入已被
   * 宿主 dispose 的共享 PersistentQueue（→ throw → batch 丢）。
   *
   * 修复：sleep 接受此 signal；dispose 时 abort，sleep 立即 reject；
   * tryUploadWithRetry 在 catch 内识别 abort 后立即 return false 走 persistBatch
   * 分支（**在共享 PersistentQueue 还没 dispose 的窗口里把 batch 落地**），
   * 避免数据丢失 + 避免 dispose 后的 telemetry 噪音。
   */
  private readonly disposeAbort = new AbortController();

  private readonly flushIntervalMs: number;
  private readonly flushThreshold: number;
  private readonly uploadFn?: (entries: TranscriptEntry[]) => Promise<void>;
  private readonly persistentQueue: PersistentQueue<TranscriptEntry[]>;
  /** dispose 时是否连带 dispose 外部传入 / 内部新建的 persistentQueue。 */
  private readonly ownsPersistentQueue: boolean;
  private readonly retryDelaysMs: number[];
  /** 一次 flush 周期总尝试位数 = 0 立即 + N 退避 = N + 1。常量化便于 attempts 口径统一。 */
  private readonly totalAttemptsPerRun: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly telemetryContext: { session_id?: string; agent_id?: string };
  private readonly newId: () => string;
  private readonly onError: NonNullable<SyncQueueOptions['onError']>;
  /** LH2-D3：本 SyncQueue 服务的账号 / 租户 / agent。enqueue / recover 全链路使用。 */
  private readonly owner: PersistedEntryOwner;

  constructor(options: SyncQueueOptions) {
    // LH2-D3：构造时立即校验 owner——比"等到第一次 recover 才报错"对调用方友好得多。
    assertValidOwner(options.owner);
    this.owner = { ...options.owner };

    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flushThreshold = options.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD;
    this.uploadFn = options.uploadFn;
    const externallyProvided = options.persistentQueue !== undefined;
    this.persistentQueue =
      options.persistentQueue ?? new InMemoryPersistentQueue<TranscriptEntry[]>();
    // 默认：外部传入 → 不拥有；内部新建 → 拥有。技术 Review #1 修复。
    this.ownsPersistentQueue = options.ownsPersistentQueue ?? !externallyProvided;
    this.retryDelaysMs =
      options.retryDelaysMs && options.retryDelaysMs.length > 0
        ? [...options.retryDelaysMs]
        : DEFAULT_RETRY_DELAYS_MS;
    this.totalAttemptsPerRun = this.retryDelaysMs.length + 1;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.telemetryContext = options.telemetryContext ?? {};
    this.newId = options.newId ?? defaultNewId;
    this.onError = options.onError ?? (() => undefined);

    this._scheduleFlush();
  }

  /** Add one transcript entry (typically called from onWrite callback). */
  enqueue(entry: TranscriptEntry): void {
    if (this.disposed) return;
    this.queue.push(entry);
    this._emit(TelemetryEvents.SYNC_QUEUED, {
      pending: this.queue.length,
      entry_type: entry.type,
    });
    if (this.queue.length >= this.flushThreshold) {
      void this.flush();
    }
  }

  /**
   * 把内存队列里的一批送进 uploadFn；失败按 retryDelaysMs 退避重试，
   * 用尽后写入 persistentQueue。
   *
   * 单次调用同时只跑一份（`flushing` 锁），并发 flush 调用直接 no-op。
   */
  async flush(): Promise<void> {
    if (this.disposed || this.flushing || this.queue.length === 0) return;

    this.flushing = true;
    const batch = this.queue.splice(0);
    try {
      // 没注入 uploadFn = "Phase 6 之前的本地累积模式"。直接丢弃 batch
      // 即可（与 v1 历史行为一致：本地不持久化）。**不**触发持久化通路，
      // 否则一个未配置 endpoint 的 dev 环境会无限堆磁盘。
      if (!this.uploadFn) return;

      const succeeded = await this.tryUploadWithRetry(batch);
      if (succeeded) return;

      // 三次都失败 → 写持久化
      await this.persistBatch(batch);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 启动时调用：从持久化队列读出待上传 batch，过滤掉已超 TTL 的（归档），
   * 其余再次走完整重试流程。同样按 batch 串行处理（避免重启瞬间打满
   * Proxy）。
   *
   * 返回值：本次 recover 的统计（便于宿主在 startup 日志展示）。
   */
  async recover(): Promise<{ recovered: number; archived: number; failed: number }> {
    if (this.disposed) return { recovered: 0, archived: 0, failed: 0 };
    let recovered = 0;
    let archived = 0;
    let failed = 0;

    let entries: PersistedEntry<TranscriptEntry[]>[];
    try {
      entries = await this.persistentQueue.loadAll();
    } catch (err) {
      this.onError(err as Error, { phase: 'recover' });
      return { recovered: 0, archived: 0, failed: 0 };
    }

    const ttlCutoff = this.now() - this.ttlMs;

    for (const entry of entries) {
      // LH2-D3：owner 校验是 disk 分桶（LH2-D1）之外的二次防御。
      // - 即使有人手动拷贝 / 未来路径调整 bug 让 entry 出现在错的目录，
      //   这里仍能拒绝（不上传，避免拿当前凭证发别人数据）；
      // - 历史 entry（LH2-D3 之前写入的、磁盘上没有 owner 字段的）：
      //   反序列化后 owner 字段为 undefined，等价于"unknown owner"；
      //   ownersMatch 严格按 (userId, organizationId) 比对，必然 mismatch。
      const entryOwner = entry.owner as PersistedEntryOwner | undefined;
      if (!entryOwner || !ownersMatch(entryOwner, this.owner)) {
        this.reportOwnerMismatch(entry, entryOwner);
        failed += 1;

        // 产品 Review LH2-D3 follow-up：mismatch entry 不能永久留在磁盘——
        // 否则 (a) telemetry 每次启动都重复上报噪音，(b) 占盘无 GC，(c) 与
        // SYNC_QUEUE.md §6.2「长期堆积"7 天 TTL 后自然归档"」叙事不符。
        // 超 TTL 的 mismatch entry 走特殊 reason `owner_mismatch_ttl` 归档，
        // 让运维可与"普通超时"区分但仍可审计；未超 TTL 的留磁盘等正确账号
        // 下次登录恢复（其桶里读到时 owner 会匹配，正常 recover 上传）。
        archived += await this.archiveOwnerMismatchIfExpired(entry, entryOwner, ttlCutoff);
        continue;
      }

      if (entry.createdAt < ttlCutoff) {
        if (await this.archiveExpiredEntry(entry)) {
          archived += 1;
        } else {
          failed += 1;
        }
        continue;
      }

      // 没有 uploadFn 也跳过——保留磁盘条目，等下次有 uploadFn 时再处理
      if (!this.uploadFn) {
        continue;
      }

      const ok = await this.tryUploadWithRetry(entry.payload, entry.attempts);
      if (ok) {
        // 上传成功**且** remove 成功才计 recovered + 发事件——避免出现
        // "已上传但磁盘还在 → 下次 recover 重复上传"的不一致（产品 Review 修复）。
        if (await this.removeRecoveredEntry(entry)) {
          recovered += 1;
        } else {
          // 上传成功但 remove 失败：算 failed，等下次 recover 再 remove。
          // 重复上传由上游 endpoint 用 sessionId+version 幂等去重（见
          // SYNC_QUEUE.md "Phase 6 endpoint 去重"已知约束）。
          failed += 1;
        }
      } else {
        // recover 期内仍然失败 → 累加 attempts 回写持久化（保留下次再试）。
        // 累加值 = `totalAttemptsPerRun`（1 立即 + N 退避），与 `persistBatch`
        // 写入 attempts 一致，避免 off-by-one。
        await this.updateFailedRecoveryEntry(entry);
        failed += 1;
      }
    }

    return { recovered, archived, failed };
  }

  /**
   * Stop the periodic timer. Call on shutdown / test teardown.
   *
   * 流程：
   * 1. 标 disposed → 后续 enqueue/flush no-op
   * 2. 关定时器
   * 3. abort 进行中的 retry sleep（技术 Review #3 修复，详见类字段
   *    `disposeAbort` 注释）
   * 4. 如果有 in-flight flush，等它走完——可能落到 persistBatch（最后一次
   *    把 batch 写进 PersistentQueue，前提是宿主还没 dispose 共享对象）
   * 5. 拥有 persistentQueue 时 dispose 它
   *
   * **宿主侧约定**（Electron/Daemon stop()）：必须先 await 所有 session
   * `syncQueue.dispose()` 完成，再 dispose 共享 `pendingSyncDiskQueue`。
   * 反过来会回到 Window-D：syncQueue 还在写共享 disk，被并发 dispose
   * 触发 assertOpen → throw → batch 丢。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // 唤醒所有 in-flight retry sleep；让 tryUploadWithRetry 立即返回 false →
    // flush 主循环走 persistBatch 路径（共享 PersistentQueue 还没 dispose 的窗口里）。
    this.disposeAbort.abort();
    // 等待 in-flight flush 跑完（最多走完 persistBatch；abort 后 sleep 立即结束，
    // 不会卡 25s）。在意时序的宿主 stop() 应在调本方法前先 `await flush()`。
    while (this.flushing) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 0);
        if (typeof t === 'object' && 'unref' in t) (t as { unref: () => void }).unref();
      });
    }
    // 只有 SyncQueue 拥有 persistentQueue 时才 dispose；外部传入的（宿主级
    // 共享 PersistentQueue）由宿主在 stop() 时统一释放，避免 bootstrap
    // recover 流程把后续 session 的 SyncQueue 共享对象提前关掉。
    if (this.ownsPersistentQueue) {
      try {
        await this.persistentQueue.dispose?.();
      } catch (err) {
        this.onError(err as Error, { phase: 'persist' });
      }
    }
  }

  /** Number of entries waiting to be uploaded (in-memory). */
  get pendingCount(): number {
    return this.queue.length;
  }

  // ── Private ────────────────────────────────────────────────────────

  /**
   * 单次重试链：第 0 次立即跑，失败后按 retryDelaysMs 等待重试；
   * 全部用尽返回 false。
   *
   * @param startedAttempts 重试基线（recover 时 = entry.attempts）
   */
  private async tryUploadWithRetry(
    batch: TranscriptEntry[],
    startedAttempts = 0,
  ): Promise<boolean> {
    if (!this.uploadFn) return true;

    for (let attempt = 0; attempt < this.totalAttemptsPerRun; attempt++) {
      if (this.disposed) return false;
      try {
        await this.uploadFn(batch);
        return true;
      } catch (err) {
        const totalAttempts = startedAttempts + attempt + 1;
        this.onError(err as Error, { phase: 'flush' });
        this._emit(TelemetryEvents.SYNC_FAILED, {
          attempt: totalAttempts,
          max_attempts_in_run: this.totalAttemptsPerRun,
          entry_count: batch.length,
          error_message: err instanceof Error ? err.message : String(err),
        });

        // 还有重试位 → 退避后再来
        if (attempt < this.retryDelaysMs.length) {
          // sleep 可被 dispose 中断（技术 Review #3）。中断 = 整个 retry 链
          // 立即放弃，flush 主循环走 persistBatch 把 batch 落地。
          const aborted = await this.sleep(this.retryDelaysMs[attempt]!);
          if (aborted) return false;
          continue;
        }
        return false;
      }
    }

    return false;
  }

  /**
   * 把上传不成功的 batch 写入持久化队列。
   *
   * **失败语义**（产品 Review 修订）：append 失败时**不**回灌内存——回灌
   * 只是延迟丢失（下个 flush 周期 fs 状态通常没变好，且会无限堆增长）。
   * 通过 `onError` 上报 + 新事件 `sync.persist_failed` 让运维明确感知，
   * 当前 batch 仍丢——这是 fs 故障下的最差情况，**不能静默吞掉**。
   *
   * 注：`sync.persist_failed` 事件复用 `sync.failed` 名字会让"上传失败"和
   * "持久化失败"两类完全不同的运维信号混在一起，所以独立成事件名。
   */
  private async persistBatch(batch: TranscriptEntry[]): Promise<void> {
    const entry: PersistedEntry<TranscriptEntry[]> = {
      id: this.newId(),
      payload: batch,
      createdAt: this.now(),
      attempts: this.totalAttemptsPerRun,
      lastAttemptAt: this.now(),
      // LH2-D3：把 owner 烘焙进 entry，重启后 recover 路径凭此校验归属。
      // 浅拷贝避免外部被引用（owner 是不可变契约——append 后理论上不应再被改）。
      owner: { ...this.owner },
    };
    try {
      await this.persistentQueue.append(entry);
      this._emit(TelemetryEvents.SYNC_PERSISTED, {
        id: entry.id,
        entry_count: batch.length,
        attempts: entry.attempts,
      });
    } catch (err) {
      this.onError(err as Error, { phase: 'persist' });
      this._emit(TelemetryEvents.SYNC_PERSIST_FAILED, {
        id: entry.id,
        entry_count: batch.length,
        error_message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private _scheduleFlush(): void {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);

    // Don't block Node from exiting if the timer is the only ref.
    if (typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      this.flushTimer.unref();
    }
  }

  /**
   * 可被 `disposeAbort` 中断的 sleep。
   *
   * @returns `true` 表示被 abort 提前唤醒（dispose 中断 retry 链）；
   *          `false` 表示自然超时（继续重试）。
   *
   * 技术 Review #3 修复：旧实现纯 `setTimeout`，dispose 期间无法中断；
   * 现在 dispose 时 abort signal 触发 → resolve(true) → tryUploadWithRetry
   * 看到 aborted=true 立即 return false → flush 主循环 persistBatch 把 batch
   * 落地。
   */
  private sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const signal = this.disposeAbort.signal;
      if (signal.aborted) {
        resolve(true);
        return;
      }
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(false);
      }, ms);
      if (typeof t === 'object' && 'unref' in t) (t as { unref: () => void }).unref();
      const onAbort = (): void => {
        clearTimeout(t);
        resolve(true);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private _emit(eventName: string, payload: Record<string, unknown>): void {
    // LH2-D3：把 owner 默认带入 payload，让 dashboard 能按 (userId, organizationId)
    // 维度做"哪个账号 sync 失败率高"等多维分析。owner 不放顶层 record（顶层
    // 已有 session_id / agent_id 与 telemetry 协议绑定），放 payload 更稳。
    // 如果 payload 里已有同名字段，按业务字段优先（不被 owner 覆盖）。
    const enriched = {
      owner_user_id: this.owner.userId,
      owner_organization_id: this.owner.organizationId,
      ...(this.owner.agentId ? { owner_agent_id: this.owner.agentId } : {}),
      ...payload,
    };
    emitTelemetryEvent(eventName, enriched, this.telemetryContext);
  }

  private reportOwnerMismatch(
    entry: PersistedEntry<TranscriptEntry[]>,
    entryOwner: PersistedEntryOwner | undefined,
  ): void {
    const mismatchErr = new OwnerMismatchError(
      entry.id,
      entryOwner ?? { userId: 'unknown', organizationId: 'unknown' },
      this.owner,
    );
    this.onError(mismatchErr, { phase: 'recover' });
  }

  private async archiveOwnerMismatchIfExpired(
    entry: PersistedEntry<TranscriptEntry[]>,
    entryOwner: PersistedEntryOwner | undefined,
    ttlCutoff: number,
  ): Promise<number> {
    if (entry.createdAt >= ttlCutoff) return 0;
    try {
      await this.persistentQueue.archive(entry, 'owner_mismatch_ttl');
      this._emit(TelemetryEvents.SYNC_ARCHIVED, {
        id: entry.id,
        reason: 'owner_mismatch_ttl',
        age_ms: this.now() - entry.createdAt,
        attempts: entry.attempts,
        entry_count: entry.payload.length,
        entry_owner_user_id: entryOwner?.userId ?? 'unknown',
        entry_owner_organization_id: entryOwner?.organizationId ?? 'unknown',
      });
      return 1;
    } catch (err) {
      this.onError(err as Error, { phase: 'archive' });
      return 0;
    }
  }

  private async archiveExpiredEntry(entry: PersistedEntry<TranscriptEntry[]>): Promise<boolean> {
    try {
      await this.persistentQueue.archive(entry, 'ttl');
      this._emit(TelemetryEvents.SYNC_ARCHIVED, {
        id: entry.id,
        reason: 'ttl',
        age_ms: this.now() - entry.createdAt,
        attempts: entry.attempts,
        entry_count: entry.payload.length,
      });
      return true;
    } catch (err) {
      this.onError(err as Error, { phase: 'archive' });
      return false;
    }
  }

  private async removeRecoveredEntry(entry: PersistedEntry<TranscriptEntry[]>): Promise<boolean> {
    try {
      await this.persistentQueue.remove(entry.id);
      this._emit(TelemetryEvents.SYNC_RECOVERED, {
        id: entry.id,
        age_ms: this.now() - entry.createdAt,
        previous_attempts: entry.attempts,
        entry_count: entry.payload.length,
      });
      return true;
    } catch (err) {
      this.onError(err as Error, { phase: 'recover' });
      return false;
    }
  }

  private async updateFailedRecoveryEntry(entry: PersistedEntry<TranscriptEntry[]>): Promise<void> {
    const updated: PersistedEntry<TranscriptEntry[]> = {
      ...entry,
      attempts: entry.attempts + this.totalAttemptsPerRun,
      lastAttemptAt: this.now(),
    };
    try {
      await this.persistentQueue.update(updated);
    } catch (err) {
      this.onError(err as Error, { phase: 'recover' });
    }
  }
}
