/**
 * BaseCollabDatabase — Database Extension 抽象基类
 *
 * 统一 5 个 App（Table/Slide/Design/Video/Canvas）的 Hocuspocus 持久化扩展中
 * 重复的 fetch/store 流程。TabDoc 因使用独立的 Y.js binary API（非 JSON snapshot），
 * 保持独立实现。
 *
 * 子类只需实现:
 *   - getPrefix()           e.g. "table:"
 *   - getResourceType()     e.g. "table"
 *   - getModuleLabel()      e.g. "TableDB"
 *   - applySnapshotToDoc()  Django snapshot → Y.Doc
 *   - buildPersistPayload() Y.Doc → persist request body (null = skip)
 *   - onSnapshotLoaded()    (optional) save internal diff snapshot
 *   - clearSnapshot()       (optional) clean up on unload
 *   - prepareYDocForMerge() (optional) clear Y.Arrays before CRDT merge
 */

import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";
import { Database as HocuspocusDatabase } from "@hocuspocus/extension-database";
import {
  fetchCollabSnapshot,
  persistCollabChanges,
} from "../services/django-api.js";
import { metrics } from "./metrics.js";
import { withRetry } from "../lib/retry.js";
import {
  parseResourceId,
  extractEditorInfoForStore,
  handleStoreError,
} from "../lib/collab-utils.js";
import {
  assignDominatingResyncClientId,
  computeResyncDelta,
  RESYNC_ORIGIN,
} from "../lib/resync.js";
import type {
  CollabFirstRestoreEditorContext,
  CollabFirstRestoreResult,
  ResyncResult,
} from "../lib/resync.js";

const SLOW_SNAPSHOT_APPLY_MS = 100;

export function isIncompleteAuthoritativeRecordSnapshot(
  snapshot: Record<string, unknown>,
): boolean {
  const records = (snapshot.records ?? {}) as Record<string, unknown>;
  const snapshotRecordCount = Object.keys(records).length;
  const rawTotal = snapshot.total_records;
  if (
    typeof rawTotal !== "number"
    || !Number.isSafeInteger(rawTotal)
    || rawTotal < 0
    || snapshot.is_truncated !== false
  ) {
    return true;
  }
  return rawTotal !== snapshotRecordCount;
}

/**
 * 轻量级信号量，限制跨文档的最大并发 store HTTP 请求数。
 * 避免 100+ 文档同时持久化对 Django 造成密集突发压力。
 *
 * CI-007: 增加 maxQueueSize 防止等待队列无界增长（每个等待 Promise 闭包持有 Y.Doc 引用）。
 * CI-008: acquire 支持 timeoutMs，防止信号量槽泄漏时等待者永久阻塞。
 */
interface SemaphoreQueueEntry {
  resolve: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

class Semaphore {
  private _current = 0;
  private readonly _queue: SemaphoreQueueEntry[] = [];
  readonly maxQueueSize: number;

  constructor(readonly concurrency: number, maxQueueSize = Infinity) {
    this.maxQueueSize = maxQueueSize;
  }

  get current(): number {
    return this._current;
  }

  get pending(): number {
    return this._queue.length;
  }

  async acquire(timeoutMs?: number): Promise<void> {
    if (this._current < this.concurrency) {
      this._current++;
      return;
    }
    if (this._queue.length >= this.maxQueueSize) {
      throw new Error(
        `Semaphore queue full (max=${this.maxQueueSize}, pending=${this._queue.length})`,
      );
    }
    return new Promise<void>((resolve, reject) => {
      const entry: SemaphoreQueueEntry = { resolve };
      this._queue.push(entry);

      if (timeoutMs != null && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          const idx = this._queue.indexOf(entry);
          if (idx !== -1) {
            this._queue.splice(idx, 1);
            reject(new Error(
              `Semaphore acquire timed out after ${timeoutMs}ms (pending=${this._queue.length})`,
            ));
          }
        }, timeoutMs);
      }
    });
  }

  release(): void {
    const next = this._queue.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.resolve();
    } else {
      this._current--;
    }
  }
}

const DEFAULT_STORE_CONCURRENCY = 20;

const SEMAPHORE_MAX_QUEUE = parseInt(
  process.env.COLLAB_SEMAPHORE_MAX_QUEUE || "100",
  10,
);
const SEMAPHORE_ACQUIRE_TIMEOUT_MS = parseInt(
  process.env.COLLAB_SEMAPHORE_TIMEOUT_MS || "30000",
  10,
);

/** 全局 store 并发信号量，所有 BaseCollabDatabase 子类实例共享 */
export const storeSemaphore = new Semaphore(DEFAULT_STORE_CONCURRENCY, SEMAPHORE_MAX_QUEUE);

export interface PersistPayload {
  changes: Record<string, unknown>;
  op_id?: string;
  editor_type: string;
  editor_id: string;
  editor_name?: string;
  [key: string]: unknown;
}

/**
 * PERF-025: 带 LRU 淘汰的 Map，防止 snapshotCache 无限增长。
 * 基于 Map 插入顺序：最久未访问的条目在迭代头部，最近访问的在尾部。
 * 超出 maxSize 时淘汰最久未访问的条目。
 */
class LRUMap<K, V> extends Map<K, V> {
  constructor(private readonly maxSize: number) {
    super();
  }

  override get(key: K): V | undefined {
    if (!super.has(key)) return undefined;
    const value = super.get(key) as V;
    super.delete(key);
    super.set(key, value);
    return value;
  }

  override set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    if (super.size > this.maxSize) {
      const oldest = super.keys().next().value;
      if (oldest !== undefined) super.delete(oldest);
    }
    return this;
  }
}

const SNAPSHOT_CACHE_MAX = parseInt(
  process.env.COLLAB_SNAPSHOT_CACHE_MAX || "200",
  10,
);

const UNLOAD_TIMEOUT_MS = parseInt(
  process.env.COLLAB_UNLOAD_TIMEOUT_MS || "15000",
  10,
);

/**
 * VS-005: 全局 pending store 注册表。
 * key = documentName，value = 当前 store 链的 settled Promise。
 * 允许 force-close 在 unloadDocument 前等待 in-flight store 完成，
 * 防止 store 回调操作已卸载的 Y.Doc 导致状态不一致。
 */
const _pendingStoreRegistry = new Map<string, Promise<void>>();

/**
 * 等待指定文档的所有 in-flight store 操作完成。
 * 用于 force-close 流程在 unloadDocument 前确保 store 已完成或超时。
 * @returns true 表示正常完成，false 表示超时。
 */
export async function waitForDocumentStores(
  documentName: string,
  timeoutMs: number = UNLOAD_TIMEOUT_MS,
): Promise<boolean> {
  const pending = _pendingStoreRegistry.get(documentName);
  if (!pending) return true;

  let timer: ReturnType<typeof setTimeout>;
  const didTimeout = await Promise.race([
    pending.then(() => false, () => false),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  clearTimeout(timer!);

  if (didTimeout) {
    console.warn(
      `[BaseCollabDB] waitForDocumentStores timed out after ${timeoutMs}ms for ${documentName}`,
    );
  }
  return !didTimeout;
}

export abstract class BaseCollabDatabase extends HocuspocusDatabase {
  /**
   * 实例级快照缓存，用于 diff 比较避免无变更持久化。key = documentName。
   * 由 afterUnloadDocument 自动清理。
   * PERF-025: 使用 LRU 淘汰策略，上限 SNAPSHOT_CACHE_MAX（默认 200）。
   */
  readonly snapshotCache = new LRUMap<string, unknown>(SNAPSHOT_CACHE_MAX);

  /**
   * Per-document Promise 串行队列。
   * Hocuspocus debounce 到期后可能与上一次仍在进行的 store 并发，
   * 此队列确保同一 documentName 的 store 严格串行执行。
   */
  private readonly _storeQueues = new Map<string, Promise<void>>();

  constructor() {
    const self = {
      fetchDocument: null as any,
      storeDocument: null as any,
    };

    super({
      fetch: (params: any) => self.fetchDocument(params),
      store: (params: any) => self.storeDocument(params),
    });

    self.fetchDocument = this._fetchDocument.bind(this);
    self.storeDocument = this._storeDocument.bind(this);
  }

  // ─── 子类必须实现 ──────────────────────────────────

  /** documentName 前缀，如 "table:" */
  protected abstract getPrefix(): string;

  /** 资源类型（用于 Django API），如 "table" */
  protected abstract getResourceType(): string;

  /** 日志标签，如 "TableDB" */
  protected abstract getModuleLabel(): string;

  /**
   * 将 Django snapshot 写入临时 Y.Doc。
   * 在 initDoc.transact() 内执行。
   */
  protected abstract applySnapshotToDoc(
    initDoc: Y.Doc,
    snapshot: Record<string, unknown>,
  ): void;

  /**
   * 从当前 Y.Doc 构建持久化请求体。
   * 返回 null 表示无变更，跳过本次持久化。
   *
   * **纯函数约束**：此方法禁止产生副作用（如写入 snapshotCache）。
   * 快照更新必须在 onStoreSuccess 中完成，确保只有 HTTP 持久化
   * 成功后才更新 diff 基准，避免重试失败时变更被静默丢弃。
   */
  protected abstract buildPersistPayload(
    ydoc: Y.Doc,
    documentName: string,
    context: Record<string, unknown>,
  ): PersistPayload | null;

  // ─── 子类可选覆盖 ──────────────────────────────────

  /**
   * fetch 完成后的回调（用于保存 diff 快照等）。
   * 默认空实现。
   */
  protected onSnapshotLoaded(
    _documentName: string,
    _initDoc: Y.Doc,
    _snapshot: Record<string, unknown>,
  ): void {}

  /**
   * 清理 unload 文档的额外缓存（基类已自动清理 snapshotCache）。
   * 子类如有 snapshotCache 之外的附加资源需在此清理。默认空实现。
   */
  protected clearSnapshot(_documentName: string): void {}

  /** persist 失败后的附加清理。不得移动已确认的 snapshotCache 基线。 */
  protected onStoreFailure(_documentName: string): void {}

  /** 仅依赖增量基线且禁止全量 fallback 的模块，在 unload 超时时保留基线。 */
  protected retainSnapshotOnUnloadTimeout(): boolean { return false; }

  /**
   * fetch 完成后，initDoc 与 preFetchState 合并后的 stateVector 回调。
   * initDoc 仅含 Django snapshot，合并后的 SV 才是真实 ydoc 基准。
   * 子类可覆盖以修正 snapshot 中的 stateVector，确保 Tier1 SV 快速比较准确。
   * 默认空实现。
   */
  protected onPostMergeStateVector(
    _documentName: string,
    _mergedStateVector: Uint8Array,
  ): void {}

  /**
   * 在 CRDT merge 前清空 ydoc 中可能翻倍的 Y.Array。
   * 部分模块（Table、Slide）需要此操作。默认空实现。
   */
  protected prepareYDocForMerge(
    _ydoc: Y.Doc,
    _snapshot?: Record<string, unknown>,
  ): void {}

  /**
   * TBD-001/CL-002: 子类可覆盖以处理 prepareYDocForMerge 后丢失的复杂并发条目。
   *
   * 基类的 _reconcileConcurrentArrayItems 已自动处理 Y.Array<string|number>
   * 类型的原始值数组（如 rowOrder、pageOrder、trackOrder）。
   * 子类仅需在此覆盖以恢复包含 Y.Map 等复杂类型的数组条目。
   *
   * @param _mergeDoc  合并后的临时文档（已含 Django 数据）
   * @param _preFetchDoc  preFetchState 构建的只读参考文档
   * @param _snapshot  Django 返回的快照
   */
  protected reconcileConcurrentItems(
    _mergeDoc: Y.Doc,
    _preFetchDoc: Y.Doc,
    _snapshot: Record<string, unknown>,
  ): void {}

  /**
   * Preserve same-item edits that arrived on the live document after fetch
   * started. Subclasses opt in for their schema; version resync deliberately
   * does not use this hook because its snapshot is authoritative.
   */
  protected reconcileConcurrentEdits(
    _mergeDoc: Y.Doc,
    _preFetchDoc: Y.Doc,
    _liveDoc: Y.Doc,
  ): void {}

  /**
   * persist 成功后回调（如更新 Y.Doc 中的 revn）。
   * 默认空实现。
   */
  protected onStoreSuccess(
    _ydoc: Y.Doc,
    _documentName: string,
    _result: unknown,
  ): void {}

  /**
   * persist 返回版本冲突时回调。子类可覆盖以将服务端最新版本号
   * 写回 Y.Doc meta，避免后续 store 因 revn 过期而永久 conflict。
   * 默认空实现。
   *
   * **副作用约束**：此方法禁止操作 snapshotCache（set/delete）。
   * 基类在调用此方法后会立即调用 buildPersistPayload 构建重试 payload，
   * 若子类在此处设置 snapshotCache，会导致 buildPersistPayload 拿刚设的快照
   * 与同一 ydoc 对比，误判"无变更"返回 null，短路冲突重试。
   * 基类仅在 retry 也冲突（不可恢复）时才执行 snapshotCache.delete；
   * retry 成功后由 onStoreSuccess 重建缓存。
   */
  protected onStoreConflict(
    _ydoc: Y.Doc,
    _documentName: string,
    _conflictResult: Record<string, unknown>,
  ): void {}

  /**
   * store 成功后记录日志。子类可覆盖以输出更详细的信息。
   */
  protected logStoreSuccess(
    resourceId: string,
    _result: unknown,
    latencyMs: number,
  ): void {
    console.log(`[${this.getModuleLabel()}] Persisted ${resourceId} (${latencyMs}ms)`);
  }

  // ─── 异步钩子（子类可覆盖以实现分批处理等优化） ────

  /**
   * applySnapshotToDoc 的异步版本。
   * 默认实现在 transact 内调用同步版本。
   * 子类可覆盖以实现分批写入、让出事件循环等优化（如 Canvas 1000+ 节点场景）。
   */
  protected async applySnapshotToDocAsync(
    initDoc: Y.Doc,
    snapshot: Record<string, unknown>,
  ): Promise<void> {
    initDoc.transact(() => {
      this.applySnapshotToDoc(initDoc, snapshot);
    });
  }

  /**
   * buildPersistPayload 的异步版本。
   * 默认实现直接代理到同步版本。
   * 子类可覆盖以实现分批序列化等优化。
   */
  protected async buildPersistPayloadAsync(
    ydoc: Y.Doc,
    documentName: string,
    context: Record<string, unknown>,
  ): Promise<PersistPayload | null> {
    return this.buildPersistPayload(ydoc, documentName, context);
  }

  /**
   * onStoreSuccess 的异步版本。
   * 默认实现直接代理到同步版本。
   */
  protected async onStoreSuccessAsync(
    ydoc: Y.Doc,
    documentName: string,
    result: unknown,
  ): Promise<void> {
    this.onStoreSuccess(ydoc, documentName, result);
  }

  /**
   * onStoreConflict 的异步版本。
   * 默认实现直接代理到同步版本。
   */
  protected async onStoreConflictAsync(
    ydoc: Y.Doc,
    documentName: string,
    conflictResult: Record<string, unknown>,
  ): Promise<void> {
    this.onStoreConflict(ydoc, documentName, conflictResult);
  }

  // ─── 通用 fetch/store 流程 ─────────────────────────

  protected parseId(documentName: string): string | null {
    return parseResourceId(documentName, this.getPrefix());
  }

  /**
   * TBD-001/CL-002: 自动恢复 prepareYDocForMerge 误删的 Y.Array 原始值条目。
   *
   * prepareYDocForMerge 子类实现中调用 ydoc.getArray() 会将对应 share 条目解析为
   * YArray。遍历 mergeDoc.share 中已解析的 YArray（即被 prepareYDocForMerge 清空的
   * 数组），与 preFetchDoc 中的同名数组对比。若某个原始值（string/number）存在于
   * preFetchDoc 但不在 mergeDoc 中（被误删的并发/未持久化新增），追加到 mergeDoc。
   *
   * 仅处理 string/number 元素（rowOrder、pageOrder、trackOrder 等），
   * Y.Map 等复杂类型由子类 reconcileConcurrentItems 处理。
   */
  private _reconcileConcurrentArrayItems(
    mergeDoc: Y.Doc,
    preFetchDoc: Y.Doc,
  ): void {
    let restoredCount = 0;

    mergeDoc.transact(() => {
      mergeDoc.share.forEach((resolvedType, name) => {
        if (!(resolvedType instanceof Y.Array)) return;

        const mergeArr = resolvedType as Y.Array<unknown>;
        const preArr = preFetchDoc.getArray(name);
        if (preArr.length === 0) return;

        const currentValues = new Set<string>();
        for (let i = 0; i < mergeArr.length; i++) {
          const item = mergeArr.get(i);
          if (typeof item === "string" || typeof item === "number") {
            currentValues.add(String(item));
          }
        }

        const missing: Array<string | number> = [];
        for (let i = 0; i < preArr.length; i++) {
          const item = preArr.get(i);
          if (typeof item !== "string" && typeof item !== "number") continue;
          const val = String(item);
          if (!currentValues.has(val)) {
            missing.push(item as string | number);
            currentValues.add(val);
          }
        }

        if (missing.length > 0) {
          mergeArr.push(missing);
          restoredCount += missing.length;
        }
      });
    });

    if (restoredCount > 0) {
      console.log(
        `[${this.getModuleLabel()}] Restored ${restoredCount} concurrent Y.Array item(s) during fetch merge`,
      );
    }
  }

  private async _fetchDocument({
    documentName,
    document: ydoc,
    context,
  }: {
    documentName: string;
    document: Y.Doc;
    context: Record<string, unknown>;
  }): Promise<Uint8Array | null> {
    const resourceId = this.parseId(documentName);
    if (!resourceId) {
      console.warn(`[${this.getModuleLabel()}] Invalid document name: ${documentName}`);
      return null;
    }

    // A same-name document can be opened again after Hocuspocus removes the
    // old instance but while its final store / afterUnload hook is still
    // draining. Let the old ACK settle first so it cannot overwrite the new
    // fetch baseline.
    if (_pendingStoreRegistry.has(documentName)) {
      await this._awaitPendingStore(documentName);
    }

    // CR-022: 在 fetch 前捕获 ydoc 状态快照，用于后续在临时 Doc 上做安全合并。
    // 这样 fetch 期间到达的并发 update 不会被 prepareYDocForMerge 破坏。
    const preFetchState = Y.encodeStateAsUpdate(ydoc);
    const preFetchSV = Y.encodeStateVector(ydoc);

    try {
      console.log(`[${this.getModuleLabel()}] Fetching snapshot for ${resourceId}`);
      const snapshot = await withRetry(
        () => fetchCollabSnapshot(this.getResourceType(), resourceId),
        { label: `${this.getModuleLabel()}-Fetch`, maxRetries: 2 },
      );

      const initDoc = new Y.Doc();
      const applyStart = Date.now();
      await this.applySnapshotToDocAsync(initDoc, snapshot as Record<string, unknown>);
      const applyMs = Date.now() - applyStart;
      if (applyMs > SLOW_SNAPSHOT_APPLY_MS) {
        console.warn(
          `[${this.getModuleLabel()}] Slow applySnapshotToDoc for ${resourceId}: ${applyMs}ms`,
        );
        metrics.increment(`${this.getResourceType()}_slow_snapshot_apply`);
      }

      // DS-030: After (potentially long) snapshot loading, refresh the
      // connection's lastRevalidation timestamp so PermissionGuard doesn't
      // kill the connection for "revalidation overdue" due to loading time.
      if (context && typeof context === "object" && "lastRevalidation" in context) {
        (context as Record<string, unknown>).lastRevalidation = Date.now();
      }

      this.onSnapshotLoaded(documentName, initDoc, snapshot as Record<string, unknown>);
      metrics.snapshotCacheSizes[this.getResourceType()] = this.snapshotCache.size;

      // CR-022: 在临时 mergeDoc 上执行 prepareYDocForMerge（清空 Y.Array），
      // 避免直接操作活跃 ydoc 产生中间空状态或与并发 update 竞态。
      // 返回的 delta 相对于 fetch 前的 ydoc 状态，
      // 保证 fetch 期间到达的用户编辑不被删除。
      const mergeDoc = new Y.Doc();
      Y.applyUpdate(mergeDoc, preFetchState);
      this.prepareYDocForMerge(mergeDoc, snapshot as Record<string, unknown>);
      Y.applyUpdate(mergeDoc, Y.encodeStateAsUpdate(initDoc));

      // TBD-001/CL-002: prepareYDocForMerge 清空了 mergeDoc 中所有 Y.Array 条目，
      // 包括存在于 preFetchState 但不在 Django 快照中的并发/未持久化新增条目。
      // 这些条目的 CRDT 删除操作会随 delta 传播到 ydoc，导致永久丢失。
      // 通过对比 preFetchState 和 mergeDoc（已填充 Django 数据），
      // 识别被误删的条目并重新添加到 mergeDoc。
      const preFetchDoc = new Y.Doc();
      Y.applyUpdate(preFetchDoc, preFetchState);
      this._reconcileConcurrentArrayItems(mergeDoc, preFetchDoc);
      this.reconcileConcurrentItems(mergeDoc, preFetchDoc, snapshot as Record<string, unknown>);
      this.reconcileConcurrentEdits(mergeDoc, preFetchDoc, ydoc);
      preFetchDoc.destroy();

      // DC-010: 合并后 mergeDoc 的 SV 才是真实 ydoc 基准（initDoc SV 仅含 Django 数据）
      this.onPostMergeStateVector(documentName, Y.encodeStateVector(mergeDoc));

      const state = Y.encodeStateAsUpdate(mergeDoc, preFetchSV);

      mergeDoc.destroy();
      initDoc.destroy();

      metrics.increment(`${this.getResourceType()}_fetch_ok`);
      return state;
    } catch (err: unknown) {
      metrics.fetchErrors++;
      metrics.increment(`${this.getResourceType()}_fetch_error`);
      console.error(`[${this.getModuleLabel()}] Error fetching ${resourceId}:`, err);
      throw err;
    }
  }

  /** : resync / collab-first 前等待进行中的 debounced store 完成，避免陈旧 diff 覆盖还原基线。 */
  private async _awaitPendingStore(documentName: string): Promise<void> {
    const pending = this._storeQueues.get(documentName);
    if (pending) {
      await pending.catch(() => {});
    }
  }

  private _storeDocument(params: {
    documentName: string;
    state: Uint8Array;
    document: Y.Doc;
    context: Record<string, unknown>;
    instance: Hocuspocus | null;
  }): Promise<void> {
    const { documentName } = params;
    const prev = this._storeQueues.get(documentName) ?? Promise.resolve();
    const next = prev.then(
      () => this._doStoreDocument(params),
      () => this._doStoreDocument(params),
    );
    this._storeQueues.set(documentName, next);

    // VS-005: 注册到全局 pending store 表，供 force-close 等待
    _pendingStoreRegistry.set(documentName, next.then(() => {}, () => {}));

    // store 完成后重置队列条目，释放已完成的 Promise 链防止内存泄漏
    const cleanup = () => {
      if (this._storeQueues.get(documentName) === next) {
        this._storeQueues.set(documentName, Promise.resolve());
        _pendingStoreRegistry.delete(documentName);
      }
    };
    next.then(cleanup, cleanup);

    return next;
  }

  private async _doStoreDocument({
    documentName,
    document: ydoc,
    context,
    instance,
  }: {
    documentName: string;
    state: Uint8Array;
    document: Y.Doc;
    context: Record<string, unknown>;
    instance: Hocuspocus | null;
  }): Promise<void> {
    const resourceId = this.parseId(documentName);
    if (!resourceId) return;

    // DS-024 defense-in-depth: pre-persist audit for revoked connections.
    // If PermissionGuard has flagged any connection as revoked but the connection
    // hasn't been fully closed yet, force-close it now to prevent further Y.Doc
    // pollution during this persist cycle.
    this._auditRevokedConnections(instance, documentName, resourceId);

    const startTime = Date.now();

    try {
      const storeEditorInfo = extractEditorInfoForStore(context, instance, documentName);
      const storeContext = {
        ...context,
        editorType: storeEditorInfo.editorType,
        editorId: storeEditorInfo.editorId,
        editorName: storeEditorInfo.editorName,
        agentRunId: storeEditorInfo.agentRunId,
        systemPolicy: storeEditorInfo.systemPolicy,
      };
      const payload = await this.buildPersistPayloadAsync(ydoc, documentName, storeContext);
      if (!payload) {
        metrics.recordStoreLatency(Date.now() - startTime);
        return;
      }

      const { agentRunId, systemPolicy } = storeEditorInfo;
      if (agentRunId) {
        payload.agent_run_id = agentRunId;
      }
      if (systemPolicy) {
        payload.system_policy = systemPolicy;
      }
      if (context.skipVersionHistory === true) {
        payload.skip_version_history = true;
      }

      await storeSemaphore.acquire(SEMAPHORE_ACQUIRE_TIMEOUT_MS);
      let result: unknown;
      const parentDocumentId = typeof context.parentDocumentId === "string"
        ? context.parentDocumentId
        : undefined;
      try {
        result = await withRetry(
          () => persistCollabChanges(this.getResourceType(), resourceId, payload, parentDocumentId),
          { label: `${this.getModuleLabel()}-Store`, maxRetries: 3 },
        );
      } finally {
        storeSemaphore.release();
      }

      const resultObj = this._requirePersistResult(result, resourceId);
      if (resultObj?.conflict) {
        metrics.increment(`${this.getResourceType()}_store_conflict`);
        if (resultObj.anomaly) {
          console.error(
            `[${this.getModuleLabel()}] Persist version ANOMALY for ${resourceId}: ` +
            `local base_version > server version ${resultObj.current_revn ?? resultObj.current_version}. ` +
            `Forcing resync.`,
          );
          metrics.increment(`${this.getResourceType()}_store_version_anomaly`);
        }
        console.warn(
          `[${this.getModuleLabel()}] Persist conflict for ${resourceId}: ` +
          `current_revn=${resultObj.current_revn ?? resultObj.current_version}`,
        );
        await this.onStoreConflictAsync(ydoc, documentName, resultObj);

        const retryPayload = await this.buildPersistPayloadAsync(ydoc, documentName, storeContext);

        // CR-020 revised: 不再提前删除 snapshotCache。
        // 保留旧快照确保：retry 成功时 onStoreSuccess 自然重建缓存；
        // retry 失败时旧快照仍可作为 diff 基准，下次 store 仍能检测到变更并重试持久化，
        // 避免无缓存路径"保存快照+跳过持久化"导致的中间变更丢失。
        // 仅在 retry 也冲突（不可恢复）时清除缓存，让下次 store 走全量路径。

        if (retryPayload) {
          if (agentRunId) {
            retryPayload.agent_run_id = agentRunId;
          }
          if (systemPolicy) {
            retryPayload.system_policy = systemPolicy;
          }
          await storeSemaphore.acquire(SEMAPHORE_ACQUIRE_TIMEOUT_MS);
          let retryResult: unknown;
          try {
            retryResult = await withRetry(
              () => persistCollabChanges(this.getResourceType(), resourceId, retryPayload, parentDocumentId),
              { label: `${this.getModuleLabel()}-Store-ConflictRetry`, maxRetries: 2 },
            );
          } finally {
            storeSemaphore.release();
          }
          const retryObj = this._requirePersistResult(retryResult, resourceId);
          if (retryObj?.conflict) {
            console.error(
              `[${this.getModuleLabel()}] Persist conflict retry still failed for ${resourceId}`,
            );
            await this.onStoreConflictAsync(ydoc, documentName, retryObj);
            this.snapshotCache.delete(documentName);
            metrics.recordStoreLatency(Date.now() - startTime);
            throw new Error(
              `[${this.getModuleLabel()}] Persist conflict not resolved after retry for ${resourceId}`,
            );
          } else {
            await this.onStoreSuccessAsync(ydoc, documentName, retryResult);
            const latency = Date.now() - startTime;
            metrics.recordStoreLatency(latency);
            this.logStoreSuccess(resourceId, retryResult, latency);
            return;
          }
        }

        metrics.recordStoreLatency(Date.now() - startTime);
        return;
      }

      await this.onStoreSuccessAsync(ydoc, documentName, result);

      const latency = Date.now() - startTime;
      metrics.recordStoreLatency(latency);
      this.logStoreSuccess(resourceId, result, latency);
    } catch (err: unknown) {
      this.onStoreFailure(documentName);
      this._notifyStoreFailure(instance, documentName);
      await handleStoreError({
        error: err,
        resourceId,
        documentName,
        instance,
        moduleLabel: this.getModuleLabel(),
        startTime,
      });
    }
  }

  private _requirePersistResult(
    result: unknown,
    resourceId: string,
  ): Record<string, unknown> {
    if (
      !result
      || typeof result !== "object"
      || Array.isArray(result)
      || (result as Record<string, unknown>).error
      || (result as Record<string, unknown>).status === "error"
    ) {
      throw new Error(
        `Django API error 422: invalid persist success response for ` +
        `${this.getResourceType()}/${resourceId}`,
      );
    }
    return result as Record<string, unknown>;
  }

  /**
   * : 版本还原服务端重同步。
   *
   * 本节点已加载该文档时，拉取还原后的权威快照，算出「当前内容 → 还原后内容」的
   * CRDT delta 并 applyUpdate 到内存 Y.Doc——Hocuspocus 经既有协作链路把 delta 广播
   * 给所有在线客户端，无需 force-close 断线重连。随后把持久化基线重置为还原后快照，
   * 使紧随其后的 debounce store 判定「无变更」而跳过，避免冗余落库与重复版本记录。
   *
   * 文档不在本节点内存时返回 loaded=false，调用方（Django）回退到 force-close。
   */
  async resyncLoadedDocument(
    instance: Hocuspocus,
    documentName: string,
  ): Promise<ResyncResult> {
    const resourceId = this.parseId(documentName);
    if (!resourceId) return { loaded: false };
    const hocusDoc = instance.documents.get(documentName);
    if (!hocusDoc) return { loaded: false };

    await this._awaitPendingStore(documentName);

    const snapshot = (await withRetry(
      () => fetchCollabSnapshot(this.getResourceType(), resourceId),
      { label: `${this.getModuleLabel()}-Resync`, maxRetries: 2 },
    )) as Record<string, unknown>;

    // /#5898: 截断或计数不一致的 records 快照不得权威覆盖在线文档。
    // 合法空表会明确携带 total_records=0，因此仍允许把 live 行全部删除。
    const snapshotRecords = (snapshot.records ?? {}) as Record<string, unknown>;
    const snapshotRecordCount = Object.keys(snapshotRecords).length;
    const liveRecords = hocusDoc.share.has("records")
      ? hocusDoc.getMap("records")
      : null;
    if (
      liveRecords
      && liveRecords.size > 0
      && isIncompleteAuthoritativeRecordSnapshot(snapshot)
    ) {
      console.error(
        `[${this.getModuleLabel()}] Refusing incomplete-record resync for ${resourceId}: ` +
          `snapshot has ${snapshotRecordCount}/${String(snapshot.total_records ?? "?")} records, ` +
          `live Y.Doc has ${liveRecords.size}`,
      );
      if (Array.isArray(snapshot.fields) && snapshot.fields.length > 0) {
        const meta = hocusDoc.getMap("meta");
        hocusDoc.transact(() => {
          meta.set("fields", snapshot.fields);
        }, RESYNC_ORIGIN);
      }
      return { loaded: false };
    }

    const targetDoc = new Y.Doc();
    try {
      assignDominatingResyncClientId(hocusDoc, targetDoc);
      await this.applySnapshotToDocAsync(targetDoc, snapshot);
      const delta = computeResyncDelta(hocusDoc, Y.encodeStateAsUpdate(targetDoc));
      Y.applyUpdate(hocusDoc, delta, RESYNC_ORIGIN);
      // 基线对齐还原后快照（targetDoc）：下一次 buildPersistPayload diff 为空 → 跳过冗余 store
      this.onSnapshotLoaded(documentName, targetDoc, snapshot);
      metrics.snapshotCacheSizes[this.getResourceType()] = this.snapshotCache.size;
    } finally {
      targetDoc.destroy();
    }

    console.log(`[${this.getModuleLabel()}] Resynced ${resourceId} via Yjs broadcast (no force-close)`);
    return { loaded: true };
  }

  /**
   * : 表格 collab-first 版本还原（仅 Y.Doc）。
   *
   * 用 Django 提供的 VH 快照更新在线 Y.Doc 并广播 delta；PostgreSQL 由 Django
   * 侧 restore_from_snapshot 写入（统一 restore 语义，避免 diff persist 把应回退
   * 的行拆成多条 action=delete 的 RecordHistory）。
   */
  async collabFirstRestoreLoadedDocument(
    instance: Hocuspocus,
    documentName: string,
    snapshot: Record<string, unknown>,
    _editorContext: CollabFirstRestoreEditorContext,
  ): Promise<CollabFirstRestoreResult> {
    const resourceId = this.parseId(documentName);
    if (!resourceId) return { loaded: false };

    const hocusDoc = instance.documents.get(documentName);
    if (!hocusDoc) return { loaded: false };

    await this._awaitPendingStore(documentName);

    const targetDoc = new Y.Doc();
    try {
      assignDominatingResyncClientId(hocusDoc, targetDoc);
      await this.applySnapshotToDocAsync(targetDoc, snapshot);
      const delta = computeResyncDelta(hocusDoc, Y.encodeStateAsUpdate(targetDoc));
      Y.applyUpdate(hocusDoc, delta, RESYNC_ORIGIN);
      this.onSnapshotLoaded(documentName, targetDoc, snapshot);
      metrics.snapshotCacheSizes[this.getResourceType()] = this.snapshotCache.size;
      console.log(
        `[${this.getModuleLabel()}] Collab-first restored ${resourceId} (Y.Doc only, DB via Django)`,
      );
      return { loaded: true };
    } finally {
      targetDoc.destroy();
    }
  }

  /**
   * Send a stateless message to all connected clients when store fails,
   * so the UI can warn users that their edits are not yet persisted.
   */
  private _notifyStoreFailure(
    instance: Hocuspocus | null,
    documentName: string,
  ): void {
    if (!instance) return;
    try {
      const doc = instance.documents.get(documentName);
      if (!doc) return;
      const payload = JSON.stringify({
        type: "store_failed",
        message: "Data save failed. Your edits are preserved locally but not yet saved to server.",
        documentName,
        timestamp: Date.now(),
      });
      for (const connection of doc.getConnections()) {
        connection.sendStateless(payload);
      }
    } catch (notifyError) {
      console.error(
        `[${this.getModuleLabel()}] Failed to notify clients about store failure:`,
        notifyError,
      );
    }
  }

  async afterUnloadDocument({
    documentName,
    instance,
  }: {
    documentName: string;
    instance?: Hocuspocus;
  }): Promise<void> {
    const pending = this._storeQueues.get(documentName);
    if (pending) {
      let timer: ReturnType<typeof setTimeout>;
      const didTimeout = await Promise.race([
        pending.then(() => false, () => false),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(true), UNLOAD_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer!);
      if (didTimeout) {
        // CLB-011: 超时后 store 可能仍在进行。不立即删除 _storeQueues，
        // 让进行中的 store 自然完成（store 完成后会自行重置队列条目为 Promise.resolve()）。
        // 在途 store 仍依赖当前 diff 基线。超时只解除 unload 等待，不清理基线；
        // store 成功会推进基线，失败则保留旧基线供下一次增量重试。
        const retainSnapshot = this.retainSnapshotOnUnloadTimeout();
        console.warn(
          `[${this.getModuleLabel()}] afterUnloadDocument timed out after ${UNLOAD_TIMEOUT_MS}ms ` +
          `for ${documentName}. In-flight store is still running; ` +
          (retainSnapshot ? "diff baseline retained." : "continuing with legacy timeout cleanup."),
        );
        metrics.increment(`${this.getResourceType()}_unload_timeout`);
        if (!retainSnapshot) {
          this.snapshotCache.delete(documentName);
          this.clearSnapshot(documentName);
        }
        metrics.snapshotCacheSizes[this.getResourceType()] = this.snapshotCache.size;
        // 不删除 _storeQueues，让进行中的 store 完成后自行清理
        console.log(`[${this.getModuleLabel()}] Partial cleanup for ${documentName} (store still pending)`);
        return;
      }
    }

    // Hocuspocus deletes the old document from instance.documents before this
    // hook runs. A new connection may therefore load the same document name
    // while we await the old store. Do not let the old unload erase the new
    // fetch baseline or its queue.
    if (instance?.documents.has(documentName)) {
      console.log(
        `[${this.getModuleLabel()}] Skipped stale unload cleanup for reloaded ${documentName}`,
      );
      return;
    }

    this.snapshotCache.delete(documentName);
    this._storeQueues.delete(documentName);
    _pendingStoreRegistry.delete(documentName);
    this.clearSnapshot(documentName);
    metrics.snapshotCacheSizes[this.getResourceType()] = this.snapshotCache.size;
    console.log(`[${this.getModuleLabel()}] Cleaned up snapshot for ${documentName}`);
  }

  /**
   * DS-024 defense-in-depth: scan document connections for revoked users
   * and force-close any that haven't been fully disconnected yet.
   *
   * Y.js CRDT merges cannot be undone, so this cannot remove already-applied
   * changes. However, closing stale revoked connections prevents further
   * Y.Doc pollution during the persist HTTP roundtrip.
   */
  private _auditRevokedConnections(
    instance: Hocuspocus | null,
    documentName: string,
    resourceId: string,
  ): void {
    if (!instance) return;
    const doc = instance.documents.get(documentName);
    if (!doc) return;

    for (const conn of doc.getConnections()) {
      const ctx = conn.context as {
        permissionRevoked?: boolean;
        userId?: string;
      } | undefined;
      if (ctx?.permissionRevoked) {
        console.warn(
          `[${this.getModuleLabel()}] Pre-persist audit: revoked user=${ctx.userId || "unknown"} ` +
          `still connected on ${resourceId}, force-closing`,
        );
        try {
          conn.close();
        } catch {
          // connection may already be closed
        }
      }
    }
  }
}
