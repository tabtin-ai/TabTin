/**
 * @tabtin/agent-runtime — 基于 fs JSONL 的 PersistentQueue 实现。
 *
 * 选型理由（详见 `SYNC_QUEUE.md`）：
 * - **Electron main 进程没有 IndexedDB**（IndexedDB 是浏览器 API，仅
 *   renderer 可用）；
 * - Daemon 是 headless Node 进程，更没有；
 * - 引入 sqlite / level 等都是新依赖。fs append-only 既轻量又能复用
 *   已有的 SessionStorage 模式（同一目录、同一 600 权限），是最务实
 *   的"宿主默认"。
 *
 * 文件布局（默认 `~/.tabtin-daemon/sync-queue/` 或 `userData/agent-sync/`）：
 *   - `pending.jsonl`：主队列。每行一条 `PersistedEntry`，最新覆盖在尾。
 *   - `archive.jsonl`：归档（TTL / max attempts 后保留）。仅追加，永不
 *     重写。
 *
 * ## 一致性策略
 *
 * 选型：**append-only + 周期 compact**。
 *
 * - 读：`loadAll` 一次性读全文 → 按 id 折叠（同 id 后写覆盖前写）→
 *   过滤掉带 `__deleted__` tombstone 的条目 → 按 createdAt 升序返回。
 *   1MB 量级的 JSONL 在 SSD 上 < 5ms，远小于 IPC / 上传耗时。
 * - 写：单行 `JSON.stringify(entry) + '\n'` `appendFile`（保证原子写
 *   单行；POSIX 4096B 以下原子）。
 * - 删除：`appendFile` 一行 `{__deleted__: true, id}` tombstone，
 *   `loadAll` 时跳过。
 * - **Compact**：当文件超过 `compactThresholdBytes`（默认 1MB）或
 *   tombstone 比例 > 50% 时，触发"读全 → 折叠 → 重写新文件 → rename
 *   覆盖"（rename 在同一目录是原子的）。compact 失败不影响读写——
 *   下次 loadAll 仍能正确折叠。
 *
 * ## 并发与多进程
 *
 * 设计前提是**单进程消费**：每个宿主进程拥有自己的目录（Electron
 * userData / Daemon `~/.tabtin-daemon`），不会有两个进程同时写同一文
 * 件。若未来在同一目录跑多个 Daemon 实例需要文件锁，可在 init 时加
 * 一个 `proper-lockfile` 之类的 dep。**当前不依赖**——避免 `node_modules`
 * 增长。
 *
 * 进程内并发：所有读 / 写操作（append / update / remove / archive /
 * loadAll / maybeCompact）通过单一 `Promise` 串行化（与 SessionStorage
 * 的写队列同模式），保证：
 * - 不会写交错（POSIX `appendFile` 在 < 4KB 时原子，但 SyncQueue 的批
 *   payload 经常 > 4KB，loadAll 与 append 并发会读到半行）
 * - loadAll 看到的总是\"上一笔写完成后的一致状态\"
 *
 * 技术 Review #4 修复：旧实现 loadAll 直接 `fs.promises.readFile` 不进
 * 队列，并发 loadAll 与 > 4KB append 时可能读到截断的 JSON → loadAll
 * 内部 try/catch 跳过损坏行 → 该 entry 静默丢失 → recover 漏一批。
 * 现在 loadAll 也串行化，消除该窗口。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type {
  PersistedEntry,
  PersistedEntryArchiveReason,
  PersistentQueue,
} from './persistent-queue.js';

/**
 * Tombstone 标记：写入此 id 表示删除。loadAll 时跳过。
 * 用 `__deleted__` 而非顶层字段，避免与业务 payload 字段命名冲突。
 */
interface Tombstone {
  __deleted__: true;
  id: string;
  /** 仅用于 compact 决策，不影响读取语义。 */
  ts: number;
}

type LineRecord<T> = PersistedEntry<T> | Tombstone;

const DEFAULT_PENDING_FILE = 'pending.jsonl';
const DEFAULT_ARCHIVE_FILE = 'archive.jsonl';
const DEFAULT_COMPACT_THRESHOLD_BYTES = 1 * 1024 * 1024; // 1MB
const DEFAULT_COMPACT_TOMBSTONE_RATIO = 0.5;

export interface FilePersistentQueueOptions {
  /**
   * 数据目录。**调用方负责保证父目录存在/可写**。本类构造时只 mkdir 自
   * 身路径（`recursive: true`），不主动创建祖辈目录的权限策略。
   */
  dir: string;
  /** 主队列文件名，默认 `pending.jsonl`。 */
  pendingFile?: string;
  /** 归档文件名，默认 `archive.jsonl`。 */
  archiveFile?: string;
  /** 触发 compact 的字节阈值，默认 1MB。 */
  compactThresholdBytes?: number;
  /** 触发 compact 的 tombstone 比例阈值，默认 0.5。 */
  compactTombstoneRatio?: number;
  /**
   * 错误回调（compact 失败 / tombstone 写入失败等）。
   * 默认 silent——业务上文件队列失败不应阻塞主路径，但宿主可挂自己的
   * logger / telemetry。
   */
  onError?: (err: Error, ctx: { phase: 'append' | 'remove' | 'update' | 'archive' | 'compact' | 'load' }) => void;
}

export class FilePersistentQueue<T> implements PersistentQueue<T> {
  private readonly pendingPath: string;
  private readonly archivePath: string;
  private readonly compactThresholdBytes: number;
  private readonly compactTombstoneRatio: number;
  private readonly onError: NonNullable<FilePersistentQueueOptions['onError']>;

  private writeQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  /** loadAll 时累计 tombstone 数量，用于 compact 决策。 */
  private tombstoneSeen = 0;
  private liveSeen = 0;

  constructor(options: FilePersistentQueueOptions) {
    this.pendingPath = path.join(options.dir, options.pendingFile ?? DEFAULT_PENDING_FILE);
    this.archivePath = path.join(options.dir, options.archiveFile ?? DEFAULT_ARCHIVE_FILE);
    this.compactThresholdBytes = options.compactThresholdBytes ?? DEFAULT_COMPACT_THRESHOLD_BYTES;
    this.compactTombstoneRatio = options.compactTombstoneRatio ?? DEFAULT_COMPACT_TOMBSTONE_RATIO;
    this.onError = options.onError ?? (() => undefined);
    fs.mkdirSync(options.dir, { recursive: true });
  }

  async append(entry: PersistedEntry<T>): Promise<void> {
    this.assertOpen();
    await this.enqueueWrite(async () => {
      await this.appendLine(this.pendingPath, entry, 'append');
    });
  }

  async update(entry: PersistedEntry<T>): Promise<void> {
    this.assertOpen();
    // append-only 语义下 update == append（loadAll 折叠时同 id 后写覆盖前写）。
    await this.enqueueWrite(async () => {
      await this.appendLine(this.pendingPath, entry, 'update');
    });
  }

  async remove(id: string): Promise<void> {
    this.assertOpen();
    const tomb: Tombstone = { __deleted__: true, id, ts: Date.now() };
    await this.enqueueWrite(async () => {
      await this.appendLine(this.pendingPath, tomb, 'remove');
      await this.maybeCompact();
    });
  }

  async archive(
    entry: PersistedEntry<T>,
    reason: PersistedEntryArchiveReason,
  ): Promise<void> {
    this.assertOpen();
    await this.enqueueWrite(async () => {
      await this.appendLine(
        this.archivePath,
        { ...entry, __archive_reason__: reason, __archived_at__: Date.now() },
        'archive',
      );
      // 归档后从主队列删除（写 tombstone）。
      const tomb: Tombstone = { __deleted__: true, id: entry.id, ts: Date.now() };
      await this.appendLine(this.pendingPath, tomb, 'archive');
      await this.maybeCompact();
    });
  }

  async loadAll(): Promise<PersistedEntry<T>[]> {
    this.assertOpen();
    // 进 writeQueue 串行化：让 loadAll 和 append/update/remove/archive 互斥，
    // 避免 > 4KB payload 的 appendFile 与并发 readFile 产生半行 JSON。
    // 技术 Review #4 修复（详见文件头注释）。
    return this.enqueueWrite(async () => this.doLoadAll());
  }

  private async doLoadAll(): Promise<PersistedEntry<T>[]> {
    const folded = new Map<string, PersistedEntry<T>>();
    let liveCount = 0;
    let tombCount = 0;

    // 逐行流式读，**不**一次性 `readFile` 整文件成单个字符串。历史 bug：
    // relay 队列在异常场景（如误落海量流式 delta）会撑到 GB 级，`readFile(...,
    // 'utf-8')` 的 `.toString()` 超过 V8 单字符串上限（~512MB）抛
    // `Invalid string length` → loadAll 抛错 → recover 永久失效、文件只增不减、
    // 无法自愈，并在读取时耗尽内存导致主进程 OOM。readline 按行产出，单行
    // 远小于整文件，既杜绝该崩溃又让 recover 能正常清理超大历史文件。
    let rl: readline.Interface;
    const stream = fs.createReadStream(this.pendingPath, { encoding: 'utf-8' });
    try {
      rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: LineRecord<T>;
        try {
          parsed = JSON.parse(trimmed) as LineRecord<T>;
        } catch {
          continue; // 跳过损坏的行（与 SessionStorage.loadTranscript 一致策略）
        }

        if (this.isTombstone(parsed)) {
          folded.delete(parsed.id);
          tombCount += 1;
          continue;
        }

        folded.set(parsed.id, parsed);
        liveCount += 1;
      }
    } catch (err) {
      // 文件不存在（createReadStream 的 ENOENT 走异步 error 事件）→ 空队列。
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      this.onError(err as Error, { phase: 'load' });
      throw err;
    } finally {
      stream.destroy();
    }

    this.liveSeen = liveCount;
    this.tombstoneSeen = tombCount;

    return Array.from(folded.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // 确保最后一笔写完成
    try {
      await this.writeQueue;
    } catch {
      /* swallowed; already reported via onError */
    }
  }

  // ── 测试辅助 ────────────────────────────────────────────────────

  /** 测试用：返回主队列文件路径。 */
  getPendingPath(): string {
    return this.pendingPath;
  }

  /** 测试用：返回归档文件路径。 */
  getArchivePath(): string {
    return this.archivePath;
  }

  // ── 私有 ────────────────────────────────────────────────────────

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error('FilePersistentQueue: queue has been disposed');
    }
  }

  private isTombstone(rec: LineRecord<T>): rec is Tombstone {
    return (
      typeof (rec as Tombstone).__deleted__ === 'boolean' &&
      (rec as Tombstone).__deleted__ === true &&
      typeof (rec as Tombstone).id === 'string'
    );
  }

  /**
   * 串行化所有写操作。SessionStorage 同模式——保证多笔 append 之间
   * 不会被 fs.appendFile 的 OS 调度切碎成"一行 + 半行"。
   */
  private enqueueWrite<R>(task: () => Promise<R>): Promise<R> {
    const next = this.writeQueue.then(task, task);
    // 把"成功/失败都当 void"塞回队列，避免 chain 一直累积 rejection。
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async appendLine(
    file: string,
    record: unknown,
    phase: 'append' | 'remove' | 'update' | 'archive',
  ): Promise<void> {
    const line = JSON.stringify(record) + '\n';
    try {
      await fs.promises.appendFile(file, line, { mode: 0o600 });
    } catch (err) {
      this.onError(err as Error, { phase });
      throw err;
    }
  }

  /**
   * 触发 compact 的判断 + 执行。
   *
   * 触发条件（任一）：
   *   - 文件 > compactThresholdBytes
   *   - tombstone 比例 > compactTombstoneRatio
   *
   * compact 实现：loadAll 折叠 → 写到 `<file>.tmp` → rename 覆盖原文
   * 件。rename 在 POSIX 同目录内是原子操作；跨 Windows 也走 rename
   * 系统调用（`fs.promises.rename` 在文件存在时会覆盖）。
   *
   * compact 失败 → onError 上报；下次 loadAll 仍能正常折叠（因为
   * append-only 语义不依赖 compact），不影响业务。
   */
  private async maybeCompact(): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(this.pendingPath);
    } catch {
      return;
    }

    const sizeOversized = stat.size > this.compactThresholdBytes;
    const ratioOversized =
      this.tombstoneSeen + this.liveSeen > 0 &&
      this.tombstoneSeen / (this.tombstoneSeen + this.liveSeen) >
        this.compactTombstoneRatio;

    if (!sizeOversized && !ratioOversized) return;

    try {
      // **必须**用 doLoadAll() 而非 loadAll()——maybeCompact 已经在 enqueueWrite
      // 队列里跑了，调 loadAll() 会再次 enqueueWrite 自我死锁（loadAll 等
      // maybeCompact 完成，maybeCompact 等 loadAll 结果）。技术 Review #4 修复
      // 后必须走内部直读路径。
      const live = await this.doLoadAll();
      const tmpPath = `${this.pendingPath}.tmp`;
      const compactedBody = live.map((e) => JSON.stringify(e)).join('\n') + (live.length ? '\n' : '');
      await fs.promises.writeFile(tmpPath, compactedBody, { mode: 0o600 });
      await fs.promises.rename(tmpPath, this.pendingPath);
      this.tombstoneSeen = 0;
      this.liveSeen = live.length;
    } catch (err) {
      this.onError(err as Error, { phase: 'compact' });
      // compact 失败不抛——保证主路径不被影响。
    }
  }
}
