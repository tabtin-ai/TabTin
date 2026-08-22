/**
 * FileHistoryService —— per-file 内容快照回退引擎。
 *
 * 平台无关：构造时注入 `historyRoot` + `logger`，Electron 主进程与 Daemon
 * 共用同一实现（统一两条编排路径）。语义与不变量见 `types.ts` 头部。
 *
 * 典型时序：
 *   beginSnapshot(runId)              // 一轮 Agent 开始：建立 anchor 基线
 *   trackEdit(runId, absPath) × N     // 每个写文件工具执行前：备份"改之前"内容
 *   ...（下一轮）beginSnapshot(runId2)
 *   rewind(runId)                     // 回退：把 tracked 文件还原到该轮开始前
 *
 * 设计对照常见 per-file history 方案：
 *   - trackEdit 三阶段提交（capture → async backup → commit re-check），防并发
 *     race 覆盖 before-backup（INV-2 / INV-6）。
 *   - beginSnapshot Phase3 重读 trackedFiles，继承异步窗口内新 track 的备份。
 *   - createBackup / restoreBackup 保真 mode（chmod），compare 比 mode+size+mtime。
 *   - copyFileHistoryForResume hard-link 优先、copy 兜底迁移上个 session 备份。
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import crypto from 'node:crypto'
import type { Stats } from 'node:fs'
import type {
  FileBackup,
  FileHistoryLogger,
  FileHistorySnapshot,
  FileHistoryServiceOptions,
  FlushResult,
  RewindDiffEntry,
  RewindFileContentFingerprint,
  RewindOptions,
  RewindPreview,
  RewindResult,
} from './types.js'

const DEFAULT_MAX_SNAPSHOTS = 50

/** snapshot 元数据持久化文件名（落在 thread 的 backupDir 内，与备份文件同目录）。 */
const MANIFEST_NAME = 'manifest.json'

/** manifest schema 版本，便于未来结构演进做兼容读。 */
const MANIFEST_VERSION = 1

/** mutation 后 flush 的 debounce 窗口（ms）：把一轮内多次 trackEdit 合并成一次写盘。 */
const FLUSH_DEBOUNCE_MS = 300

/** UI 文本 diff 的单文件最大读取量；CAS 另走原始字节流式 sha256。 */
const MAX_TEXT_DIFF_BYTES = 256 * 1024

/** 合法 backupRef：`<16位hex>@v<正整数>`。用于 loadSnapshots 校验，防 `../` 注入。 */
const BACKUP_REF_RE = /^[0-9a-f]{16}@v[1-9]\d*$/

interface ManifestFile {
  version: number
  /**
   * P1-2：manifest 记录创建时的 canonical workspaceRoot。resume 时若与当前 root
   * 不一致 → 相对路径 key 失配，**不复用**（见 `init`）。旧 manifest 无此字段
   * （`undefined`）时按"匹配"处理，向后兼容。
   */
  workspaceRoot?: string
  snapshots: FileHistorySnapshot[]
}

type CompareResult = 'same' | 'differs' | 'backup-missing'

function findLast<T>(arr: T[], pred: (x: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return arr[i]
  }
  return undefined
}

function errnoOf(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException)?.code
}

function isENOENT(e: unknown): boolean {
  return errnoOf(e) === 'ENOENT'
}

/**
 * canonicalize —— 把路径解析成稳定 key（对照 `action-tools/utils/canonical-path.ts`
 * 的策略，但本包不依赖 action-tools，内嵌等价 realpath 归一）。
 *
 * 解决「同一文件跨入口被不同路径串引用 → 分裂成两个 entry」：
 *   - macOS `/tmp` ↔ `/private/tmp` symlink、大小写不敏感卷 → realpath 归一。
 *   - 文件尚不存在（新建前）→ 回退父目录 realpath + basename，layout 仍稳定。
 *
 * 用 sync realpath：构造期（workspaceRoot）与异步热路径（shorten）共用一份逻辑，
 * 保证 read/track/rewind 跨阶段 key 一致。
 */
function canonicalize(abs: string): string {
  try {
    return fsSync.realpathSync(abs)
  } catch {
    try {
      return path.join(fsSync.realpathSync(path.dirname(abs)), path.basename(abs))
    } catch {
      return abs
    }
  }
}

/**
 * 把 workspaceRoot 归一成稳定 canonical 形式（`resolve` + realpath），与
 * `FileHistoryService` 构造时一致。registry 用它比对"命中缓存的 service root
 * 是否变了"（P1-2），保证两侧用同一归一逻辑、不因 symlink/相对路径误判。
 */
export function canonicalizeWorkspaceRoot(workspaceRoot: string): string {
  return canonicalize(path.resolve(workspaceRoot))
}

/**
 * 推导某 thread 的备份目录：`<historyRoot>/<sha256(threadId)>`。与实例内 `threadDir`
 * 同一 sha256 口径（P1-8），供 registry lazy-resume 在**不实例化 service** 的前提下
 * 定位 manifest（Bug 1：进程重启后内存空、需按 threadId 从磁盘探测账本）。
 */
export function fileHistoryThreadDir(historyRoot: string, threadId: string): string {
  const h = crypto.createHash('sha256').update(threadId).digest('hex')
  return path.join(historyRoot, h)
}

/**
 * 只读探测某 thread 的 manifest，取其中记录的 canonical workspaceRoot（Bug 1 lazy-resume）。
 *
 * registry `getOrResume` 在内存缓存 miss 时用它从磁盘恢复——"进程重启后对一个没再发过
 * 消息的历史会话点回退"：内存 registry 空，但磁盘 manifest + 备份仍在，据此读出建账本
 * 时的 workspaceRoot，再 `getOrCreate(threadId, root)` 让 `init()` 按 manifest 加载 snapshots。
 *
 * **必须用 manifest 里记录的 root**：随便传别的 root 会被 `init` 的 P1-2 校验判为 mismatch
 * 而**不复用** snapshots（相对路径 key 失配 → 整轮回退落空）。
 *
 * 返回 `undefined` 的情形（无从安全 resume；调用方据此拒绝回退，绝不静默成功）：
 *   - manifest 不存在（该 thread 从未 track 过文件 / 已被 gc）。
 *   - manifest 损坏 / 非法 JSON。
 *   - manifest 无 `workspaceRoot` 字段（旧格式：拿不到 root 就无法安全恢复相对路径 key）。
 *
 * 纯只读：不实例化 service、不改任何磁盘状态、不触发 quarantine（损坏处置留给真正 `init`）。
 */
export async function peekFileHistoryWorkspaceRoot(
  historyRoot: string,
  threadId: string,
): Promise<string | undefined> {
  const manifestPath = path.join(fileHistoryThreadDir(historyRoot, threadId), MANIFEST_NAME)
  let raw: string
  try {
    raw = await fs.readFile(manifestPath, 'utf8')
  } catch {
    return undefined // 不存在 / 不可读 → 无可恢复账本
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ManifestFile>
    const root = parsed.workspaceRoot
    return typeof root === 'string' && root.length > 0 ? root : undefined
  } catch {
    return undefined // 损坏 manifest：只读探测不做 quarantine
  }
}

export class FileHistoryService {
  private snapshots: FileHistorySnapshot[] = []
  private trackedFiles = new Set<string>()
  private readonly threadId: string
  private readonly historyRoot: string
  private readonly backupDir: string
  /** canonical workspaceRoot（仅用于相对路径压缩，INV-4）。对外只读 getter 暴露。 */
  private readonly wsRoot: string
  private readonly maxSnapshots: number
  private readonly log: FileHistoryLogger
  /** 是否启用 manifest 自动持久化（见 FileHistoryServiceOptions.persist）。 */
  private readonly persist: boolean
  /** manifest 元数据落盘路径（`<backupDir>/manifest.json`）。 */
  private readonly manifestPath: string
  /** debounce flush 定时器；null = 当前无待写。`unref` 不阻塞进程退出。 */
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * P2-4：per-instance 串行队列尾。`beginSnapshot/trackEdit/rewind/flush/destroy`
   * 全部经 `withLock` 入队，保证关键 mutation / 回退 / 持久化互斥串行
   * （对照 checkpoint-core withLock）。
   */
  private lockTail: Promise<void> = Promise.resolve()
  /** P2-4/P2-5：destroy 后置位，防止排在销毁之后的 flush 重建 backupDir + manifest。 */
  private destroyed = false
  /** P2-5：持久化降级标志——manifest 损坏（已 quarantine）或写盘失败后置位。 */
  private degraded = false
  /** P2-5：最近一次失败/降级原因（供 `flushNow` / `getHealth` 观测）。 */
  private lastError: string | undefined

  constructor(opts: FileHistoryServiceOptions) {
    this.threadId = opts.threadId
    this.historyRoot = opts.historyRoot
    // P1-8：threadId 用 sha256 hash 而非 lossy sanitize（`a/b` 与 `a_b` 不再碰撞）。
    this.wsRoot = canonicalizeWorkspaceRoot(opts.workspaceRoot)
    this.backupDir = this.threadDir(opts.threadId)
    this.maxSnapshots = opts.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS
    this.log = opts.logger
    this.persist = opts.persist ?? false
    this.manifestPath = path.join(this.backupDir, MANIFEST_NAME)
  }

  /** canonical workspaceRoot（registry 比对 root 漂移用，P1-2）。 */
  get workspaceRoot(): string {
    return this.wsRoot
  }

  /** 持久化健康度（P2-5③）：host 可在 flush 后查询是否降级。 */
  getHealth(): { degraded: boolean; lastError?: string } {
    return { degraded: this.degraded, lastError: this.lastError }
  }

  /**
   * P2-4 串行锁：把 fn 排到队尾，等前序全部 settle 后再执行，执行完释放。
   * 不让前序的 reject 污染后续（每个调用各自 await 自己的 fn 结果）。
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lockTail
    let release!: () => void
    this.lockTail = new Promise<void>((r) => {
      release = r
    })
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }

  // ── 写入 ────────────────────────────────────────────────────────────

  /**
   * 一轮 Agent 开始：以当前 tracked 文件的最新状态建立新 anchor 基线。
   *
   * 三阶段（对按常见 agent 工具 `fileHistoryMakeSnapshot`）：
   *   Phase1 capture：记下 `latest` + 待处理文件集合。
   *   Phase2 IO：异步为每个 tracked 文件备份"本轮开始前"内容。
   *   Phase3 commit：**重读** trackedFiles，继承异步窗口内新 track 的备份（P0-3），
   *                 再落盘新 snapshot。
   */
  async beginSnapshot(anchorId: string): Promise<void> {
    return this.withLock(() => this.beginSnapshotLocked(anchorId))
  }

  private async beginSnapshotLocked(anchorId: string): Promise<void> {
    // Phase1
    const latest = this.snapshots.at(-1)
    const filesToProcess = Array.from(this.trackedFiles)
    const computed: Record<string, FileBackup> = {}

    // Phase2（异步备份，期间不改动共享 state）
    if (latest) {
      await Promise.all(
        filesToProcess.map(async (rel) => {
          const abs = this.expand(rel)
          const prev = latest.trackedFileBackups[rel]
          try {
            if (prev && !(await this.changedSince(abs, prev))) {
              computed[rel] = prev
            } else {
              computed[rel] = await this.createBackup(abs, rel, (prev?.version ?? 0) + 1)
            }
          } catch (err) {
            // 单文件备份失败不阻断整轮；rewind 时该文件按 fail-visible 处理。
            this.log.warn(`[FileHistory] beginSnapshot backup failed for ${rel}:`, err)
          }
        }),
      )
    }

    // Phase3 commit —— 重读 trackedFiles（fresh），继承异步窗口内新 track 的 backup。
    const mostRecent = this.snapshots.at(-1)
    if (mostRecent) {
      for (const rel of this.trackedFiles) {
        if (rel in computed) continue
        const inherited = mostRecent.trackedFileBackups[rel]
        if (inherited) computed[rel] = inherited
      }
    }

    // 若异步窗口内有 trackEdit 已 bootstrap 出同 anchorId 的 snapshot，则合并进它
    // （已存在的 before-backup 优先，不被基线覆盖），避免重复 anchor。
    const existing = findLast(this.snapshots, (s) => s.anchorId === anchorId)
    if (existing) {
      for (const [rel, backup] of Object.entries(computed)) {
        if (!(rel in existing.trackedFileBackups)) existing.trackedFileBackups[rel] = backup
      }
    } else {
      this.pushSnapshot({ anchorId, trackedFileBackups: computed, timestamp: Date.now() })
    }
    this.log.debug(`[FileHistory] beginSnapshot ${anchorId} (${this.trackedFiles.size} tracked)`)
    this.scheduleFlush()
  }

  /**
   * 文件编辑工具写盘前调用：把"改之前"的内容备份进**指定 anchorId** 的 snapshot。
   * 同一 anchor 内对同一文件只备份一次（INV-2）。
   *
   * 三阶段（对按常见 agent 工具 `fileHistoryTrackEdit`）：
   *   Phase1 capture：定位目标 anchor；若已有此文件 backup → 直接返回（INV-2）。
   *   Phase2 IO：异步备份当前内容（= 改之前）。
   *   Phase3 commit：**重新定位** anchor 并 re-check；并发 race 已有 backup 则跳过
   *                 （绝不覆盖 before-backup，守 INV-2 / 防 P0-1 race）。
   */
  async trackEdit(anchorId: string, absPath: string): Promise<void> {
    return this.withLock(() => this.trackEditLocked(anchorId, absPath))
  }

  private async trackEditLocked(anchorId: string, absPath: string): Promise<void> {
    const rel = this.shorten(absPath)

    // Phase1
    const phase1Target = findLast(this.snapshots, (s) => s.anchorId === anchorId)
    if (phase1Target?.trackedFileBackups[rel]) return // INV-2：已有 before-backup

    // Phase2（异步备份，不改动共享 state）
    let backup: FileBackup
    try {
      backup = await this.createBackup(absPath, rel, 1)
    } catch (err) {
      // 备份失败 fail-visible（INV-1 / INV-5）：error 级日志 + 落 `backup-failed` 标记，
      // **绝不 return**。首次 track 的文件若直接 return，就不进 trackedFiles，rewind 根本
      // 不遍历它 → failedFiles 为空 → 用户看不到它无法回退。改记 backup-failed 走下方
      // Phase3 commit + add，rewind 会把它计入 failedFiles，且因无 before-backup 绝不触碰。
      const detail = err instanceof Error ? err.message : String(err)
      this.log.error(`[FileHistory] trackEdit backup failed for ${rel} @${anchorId}:`, err)
      backup = { kind: 'backup-failed', backupRef: null, version: 1, backupTime: Date.now(), error: detail }
    }

    // Phase3 commit —— 重新定位 anchor + re-check race。
    let target = findLast(this.snapshots, (s) => s.anchorId === anchorId)
    if (!target) {
      // anchor 不存在（beginSnapshot 失败 / 早于 beginSnapshot）：以**正确 anchorId**
      // 兜底建锚点，归属本轮而非"最新轮"（P0-1 / INV-6）。
      target = { anchorId, trackedFileBackups: {}, timestamp: Date.now() }
      this.pushSnapshot(target)
    }
    if (target.trackedFileBackups[rel]) return // race：他人已提交 before-backup → 不覆盖
    target.trackedFileBackups[rel] = backup
    this.trackedFiles.add(rel)
    this.log.debug(`[FileHistory] trackEdit ${rel} @${anchorId} -> ${backup.backupRef ?? `(${backup.kind})`}`)
    this.scheduleFlush()
  }

  // ── 回退 ────────────────────────────────────────────────────────────

  /**
   * 回退到 anchor：把 tracked 文件还原到该 anchor 记录的"那一轮开始前"状态（INV-3）。
   *
   * P2-4：经 `withLock` 串行（与 begin/track/flush/destroy 互斥）。
   * P0-1 ②：若传入 `opts.pathGuard`，在**写盘前**对将被写/删的每条绝对路径调一次；
   *   任一不允许 → 抛错、**不触碰任何文件**（原子拒绝）。
   */
  async rewind(anchorId: string, opts?: RewindOptions): Promise<RewindResult> {
    return this.withLock(() => this.rewindLocked(anchorId, opts))
  }

  private async rewindLocked(anchorId: string, opts?: RewindOptions): Promise<RewindResult> {
    const target = findLast(this.snapshots, (s) => s.anchorId === anchorId)
    if (!target) {
      throw new Error(`[FileHistory] snapshot not found for anchor: ${anchorId}`)
    }

    if (opts?.expectedPreviewRevision !== undefined) {
      if (!opts.previewRevisionFactory) {
        throw new Error('[FileHistory] previewRevisionFactory is required with expectedPreviewRevision')
      }
      // 与下方 path guard + 写盘在同一 withLock 内，防止 trackEdit / 其他 rewind
      // 在“复验成功”和“开始写盘”之间插入。外部程序直接改文件仍由
      // 下方每路径操作的 fail-visible 语义兜底。
      const currentPreview = await this.buildRewindPreview(target)
      const currentRevision = await opts.previewRevisionFactory(currentPreview)
      if (currentRevision !== opts.expectedPreviewRevision) {
        throw new Error(`[FileHistory] rewind ${anchorId} preview revision mismatch`)
      }
    }

    // P0-1 ②：path guard。先把"将被写/删的绝对路径集"算出来（与下方回退实际触碰
    // 的集合一致），逐条过 guard；任一不允许 → 抛错、绝不开始写盘（原子）。锁内
    // 完成 compute + guard + 回退三步，无 trackEdit 穿插（消除 TOCTOU）。
    if (opts?.pathGuard) {
      const planned = await this.computeAffectedPaths(target)
      const blocked: string[] = []
      for (const abs of planned) {
        const decision = opts.pathGuard(abs)
        if (!decision.allowed) blocked.push(decision.reason ? `${abs} (${decision.reason})` : abs)
      }
      if (blocked.length > 0) {
        throw new Error(
          `[FileHistory] rewind ${anchorId} blocked by path guard: ${blocked.length} path(s) not allowed: ${blocked.join('; ')}`,
        )
      }
    }

    const filesRestored: string[] = []
    const filesDeleted: string[] = []
    const failedFiles: string[] = []
    for (const rel of Array.from(this.trackedFiles)) {
      const abs = this.expand(rel)
      const backup = this.resolveTargetBackup(target, rel)
      if (!backup) {
        // metadata 解析不到目标版本 → 无法回退（INV-5 fail-visible），不静默跳过。
        failedFiles.push(abs)
        this.log.warn(`[FileHistory] rewind ${anchorId}: no backup metadata for ${rel}`)
        continue
      }
      try {
        if (backup.kind === 'unsupported' || backup.kind === 'backup-failed') {
          // 非普通文件（unsupported）/ 备份创建失败（backup-failed）都无法用内容语义还原
          // → fail-visible，绝不触碰（INV-5 / P1-6）。必须在 absent 判定**之前**拦截：
          // backup-failed 的 backupRef 也是 null，漏拦会被下方当 absent 误删未备份的现场。
          failedFiles.push(abs)
          continue
        }
        if (backup.kind === 'absent' || backup.backupRef === null) {
          if (await this.removePath(abs)) filesDeleted.push(abs)
          continue
        }
        const cmp = await this.compareFileToBackup(abs, backup)
        if (cmp === 'backup-missing') {
          // 备份文件缺失 → 无法恢复（P0-2）：fail-visible，绝不当"无需恢复即成功"。
          failedFiles.push(abs)
          this.log.warn(`[FileHistory] rewind ${anchorId}: backup file missing for ${rel}`)
          continue
        }
        if (cmp === 'differs') {
          await this.restoreBackup(abs, backup)
          filesRestored.push(abs)
        }
      } catch (err) {
        // 恢复 / 删除出错（含非 ENOENT OS 错误）→ fail-visible（INV-5 / P1-7）。
        this.log.warn(`[FileHistory] rewind failed for ${rel}:`, err)
        failedFiles.push(abs)
      }
    }
    this.log.info(
      `[FileHistory] rewind ${anchorId}: ${filesRestored.length} restored, ` +
        `${filesDeleted.length} deleted, ${failedFiles.length} failed`,
    )
    return { filesRestored, filesDeleted, failedFiles }
  }

  /**
   * 预览：回退到 anchor 会影响哪些文件（绝对路径），不写盘。
   * 只读、不入串行锁；host 据此对每条路径做 path-access 校验（preview 守卫，P0-1 ②）。
   */
  async getAffectedPaths(anchorId: string): Promise<string[]> {
    return (await this.getRewindPreview(anchorId)).affectedPaths
  }

  /**
   * 回退前 safety 快照：把当前 tracked 文件状态记入专用 anchor，供 unrevert 时
   * `rewind(safetyAnchorId)` 还原到回退前工作区（ 最小闭环）。
   */
  async createSafetySnapshot(safetyAnchorId: string): Promise<void> {
    return this.beginSnapshot(safetyAnchorId)
  }

  /**
   * 预览：回退到 anchor 会变更的文件 diff（当前 vs anchor 备份），不写盘。
   * 判定与 `computeAffectedPaths` / `rewind` 同构，只读、不入串行锁。
   */
  async getRewindDiff(anchorId: string): Promise<RewindDiffEntry[]> {
    return (await this.getRewindPreview(anchorId)).diffs
  }

  /**
   * 富预览：把会写/删的文件与已知不可恢复缺口一次算全。
   *
   * 旧 getAffectedPaths/getRewindDiff 只看可执行 diff，会把 backup-failed、
   * unsupported、backup-missing 压成空数组；执行时这些却进入 failedFiles。
   * 编辑重发据此必须 fail-closed，不能把“已知恢复不了”显示成“文件不会变更”。
   */
  async getRewindPreview(anchorId: string): Promise<RewindPreview> {
    const target = findLast(this.snapshots, (s) => s.anchorId === anchorId)
    if (!target) {
      throw new Error(`[FileHistory] snapshot not found for anchor: ${anchorId}`)
    }
    return this.buildRewindPreview(target)
  }

  private async buildRewindPreview(target: FileHistorySnapshot): Promise<RewindPreview> {
    const affectedPaths: string[] = []
    const diffs: RewindDiffEntry[] = []
    const fingerprints: RewindPreview['fingerprints'] = []
    const unrestorable: RewindPreview['unrestorable'] = []
    for (const rel of Array.from(this.trackedFiles)) {
      const abs = this.expand(rel)
      const backup = this.resolveTargetBackup(target, rel)
      if (!backup) {
        unrestorable.push({ path: rel, reason: 'missing_metadata' })
        continue
      }
      try {
        if (backup.kind === 'unsupported') {
          unrestorable.push({ path: rel, reason: 'unsupported' })
          continue
        }
        if (backup.kind === 'backup-failed') {
          unrestorable.push({ path: rel, reason: 'backup_failed', detail: backup.error })
          continue
        }
        if (backup.kind === 'absent' || backup.backupRef === null) {
          const cur = await this.lstatOrNull(abs)
          if (cur === null) continue
          if (!cur.isFile()) {
            unrestorable.push({ path: rel, reason: 'current_non_file' })
            continue
          }
          const current = await this.fingerprintRegularFile(abs, cur)
          affectedPaths.push(abs)
          fingerprints.push({
            path: rel,
            status: 'deleted',
            current,
            target: { kind: 'absent' },
          })
          diffs.push({
            path: rel,
            status: 'deleted',
            before: await this.readTextFileBestEffort(abs),
          })
          continue
        }
        const backupPath = this.backupPath(backup.backupRef as string)
        const backupStat = await this.statOrNull(backupPath)
        if (backupStat === null || !backupStat.isFile()) {
          unrestorable.push({ path: rel, reason: 'backup_missing' })
          continue
        }
        const cur = await this.lstatOrNull(abs)
        if (cur !== null && !cur.isFile()) {
          unrestorable.push({ path: rel, reason: 'current_non_file' })
          continue
        }
        const [current, targetFingerprint] = await Promise.all([
          cur === null
            ? Promise.resolve<RewindFileContentFingerprint>({ kind: 'absent' })
            : this.fingerprintRegularFile(abs, cur),
          this.fingerprintRegularFile(backupPath, backupStat),
        ])
        if (
          current.kind === 'file'
          && current.size === targetFingerprint.size
          && current.mode === targetFingerprint.mode
          && current.sha256 === targetFingerprint.sha256
        ) {
          continue
        }
        affectedPaths.push(abs)
        const after = await this.readTextFileBestEffort(backupPath)
        if (current.kind === 'absent') {
          fingerprints.push({ path: rel, status: 'added', current, target: targetFingerprint })
          diffs.push({ path: rel, status: 'added', after })
          continue
        }
        fingerprints.push({ path: rel, status: 'modified', current, target: targetFingerprint })
        diffs.push({
          path: rel,
          status: 'modified',
          before: await this.readTextFileBestEffort(abs),
          after,
        })
      } catch (err) {
        this.log.warn(`[FileHistory] getRewindDiff probe failed for ${rel}:`, err)
        unrestorable.push({
          path: rel,
          reason: 'probe_failed',
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return { affectedPaths, diffs, fingerprints, unrestorable }
  }

  /**
   * 计算回退到 target 会**实际写/删**的绝对路径集（rewind 与 getAffectedPaths 共享）。
   * 与 rewind 的写盘判定严格同构：unsupported 跳过、absent 且当前存在→删、file 且 differs→还原。
   * 故它就是"rewind 会触碰的文件集"，正好作为 path guard 的输入。
   */
  private async computeAffectedPaths(target: FileHistorySnapshot): Promise<string[]> {
    const affected: string[] = []
    for (const rel of Array.from(this.trackedFiles)) {
      const abs = this.expand(rel)
      const backup = this.resolveTargetBackup(target, rel)
      if (!backup) continue
      try {
        // unsupported / backup-failed 都不会被 rewind 实际写/删（只计入 failedFiles），
        // 故不计入"将被触碰路径"（与 rewind 写删集合严格同构；也避免对一个根本不会被
        // 触碰的文件做 path guard 校验而误拒整个 rewind）。须在 absent 判定前拦截。
        if (backup.kind === 'unsupported' || backup.kind === 'backup-failed') continue
        if (backup.kind === 'absent' || backup.backupRef === null) {
          if ((await this.lstatOrNull(abs)) !== null) affected.push(abs)
          continue
        }
        if ((await this.compareFileToBackup(abs, backup)) === 'differs') affected.push(abs)
      } catch (err) {
        this.log.warn(`[FileHistory] computeAffectedPaths probe failed for ${rel}:`, err)
      }
    }
    return affected
  }

  hasAnchor(anchorId: string): boolean {
    return this.snapshots.some((s) => s.anchorId === anchorId)
  }

  /** 列出所有 anchor（最新在后），用于审计 / 对话内展示。 */
  listAnchors(): Array<{ anchorId: string; timestamp: number; fileCount: number }> {
    return this.snapshots.map((s) => ({
      anchorId: s.anchorId,
      timestamp: s.timestamp,
      fileCount: Object.keys(s.trackedFileBackups).length,
    }))
  }

  // ── 持久化 / 运维 ───────────────────────────────────────────────────

  /**
   * 从 manifest 加载已有 snapshots（resume / 重启 / 同 thread 多 query）。
   * `persist` 关时 no-op；manifest 不存在按"全新 thread"从空开始；manifest 损坏
   * （截断 / 非法 JSON）也 fail-safe 从空开始，不抛、不阻断装配。
   * 幂等：复用 `loadSnapshots` 的 sanitize（防 `../` 注入），可安全多次调用。
   */
  async init(): Promise<void> {
    if (!this.persist) return
    let raw: string
    try {
      raw = await fs.readFile(this.manifestPath, 'utf8')
    } catch (e) {
      if (!isENOENT(e)) {
        // 非 ENOENT 读失败（权限 / IO）：不静默——标降级，让 host 经 getHealth 可见。
        this.degraded = true
        this.lastError = `read manifest failed: ${e instanceof Error ? e.message : String(e)}`
        this.log.warn(`[FileHistory] init: read manifest failed (${this.manifestPath}):`, e)
      }
      return // 无 manifest = 全新 thread
    }
    let parsed: Partial<ManifestFile>
    try {
      parsed = JSON.parse(raw) as Partial<ManifestFile>
    } catch (e) {
      // P2-5①：损坏 manifest（截断 / 非法 JSON）**不静默覆盖**——quarantine 保留
      // 现场 + 标降级，从空开始。否则下次 flush 直接覆盖损坏文件，丢失取证线索。
      await this.quarantineManifest(e)
      return
    }
    // P1-2：manifest 记录的 root 与当前 root 不一致 → 相对路径 key 失配，**不复用**。
    // 旧 manifest 无 workspaceRoot 字段（undefined）按"匹配"处理（向后兼容）。
    if (typeof parsed.workspaceRoot === 'string' && parsed.workspaceRoot !== this.wsRoot) {
      this.log.warn(
        `[FileHistory] init: workspaceRoot mismatch (manifest=${parsed.workspaceRoot}, current=${this.wsRoot}); ` +
          'not reusing snapshots (relative-path keys would be wrong)',
      )
      return // 从空开始；后续 flush 会以当前 root 重写 manifest
    }
    if (Array.isArray(parsed.snapshots)) {
      this.loadSnapshots(parsed.snapshots)
      this.log.debug(`[FileHistory] init: loaded ${this.snapshots.length} snapshot(s) from manifest`)
    }
  }

  /**
   * P2-5①：把损坏的 manifest 改名为 `manifest.json.corrupt.<ts>`（保留取证），
   * 置降级标志。rename 失败也不抛——init 必须 fail-safe（不阻断装配）。
   */
  private async quarantineManifest(err: unknown): Promise<void> {
    this.degraded = true
    this.lastError = `manifest corrupt: ${err instanceof Error ? err.message : String(err)}`
    const dest = `${this.manifestPath}.corrupt.${Date.now()}`
    try {
      await fs.rename(this.manifestPath, dest)
      this.log.warn(`[FileHistory] init: manifest corrupt → quarantined to ${dest}, starting empty:`, err)
    } catch (renameErr) {
      this.log.warn('[FileHistory] init: manifest corrupt and quarantine failed; starting empty:', renameErr)
    }
  }

  /**
   * 立即把 snapshot 元数据写 manifest（确定性入口；可在 session 销毁 / 测试断言
   * 前手动调，绕开 debounce）。`persist` 关 / 已 destroy 时 no-op。
   *
   * P2-4：经 `withLock` 串行——与 mutation / rewind / destroy 互斥，且 debounce
   * fire 与显式 flush 不会并发写 manifest（替代旧 flushChain）。
   */
  async flush(): Promise<void> {
    if (!this.persist || this.destroyed) return
    await this.withLock(() => this.doFlush())
  }

  /**
   * P2-5②③：强制 flush 并**返回健康状态**。host 在 agent run 结束 / app quit /
   * daemon SIGTERM 调它（绕开 debounce 丢账），据返回值观测写盘是否失败 / 降级。
   */
  async flushNow(): Promise<FlushResult> {
    if (!this.persist) return { ok: true, degraded: false }
    if (this.destroyed) return { ok: true, degraded: this.degraded, error: this.lastError }
    const ok = await this.withLock(() => this.doFlush())
    return { ok, degraded: this.degraded, error: this.lastError }
  }

  /** 锁内执行的实际写盘。返回是否成功（false=写失败，已置降级）。 */
  private async doFlush(): Promise<boolean> {
    // 锁内 re-check destroyed：即便有 flush 抢在 destroy 之前过了外层闸，排到
    // destroy 之后执行时也必须 no-op，绝不重建 backupDir + 写回 manifest。
    if (!this.persist || this.destroyed) return true
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const data: ManifestFile = {
      version: MANIFEST_VERSION,
      workspaceRoot: this.wsRoot,
      snapshots: this.exportSnapshots(),
    }
    return this.writeManifest(JSON.stringify(data))
  }

  private async writeManifest(serialized: string): Promise<boolean> {
    const tmp = `${this.manifestPath}.tmp`
    try {
      await fs.mkdir(this.backupDir, { recursive: true })
      await fs.writeFile(tmp, serialized)
      await fs.rename(tmp, this.manifestPath)
      return true
    } catch (e) {
      // P2-5③：写盘失败置降级 + 记因，host 经 flushNow / getHealth 可观测，不静默。
      this.degraded = true
      this.lastError = `write manifest failed: ${e instanceof Error ? e.message : String(e)}`
      this.log.warn('[FileHistory] flush: write manifest failed:', e)
      await fs.rm(tmp, { force: true }).catch(() => {})
      return false
    }
  }

  /** mutation 后排程一次 debounced flush（合并同轮多次写）。`persist` 关 / 已 destroy 时 no-op。 */
  private scheduleFlush(): void {
    if (!this.persist || this.destroyed) return
    if (this.flushTimer) return // 已排程，等它 fire 时 export 最新全量（debounce 合并）
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, FLUSH_DEBOUNCE_MS)
    // 不阻塞进程退出：pending flush 不应吊住 Electron / Daemon 关停。
    this.flushTimer.unref?.()
  }

  /** 导出 snapshot 元数据（随会话落盘）。深拷贝 FileBackup，避免外部 mutate 内部状态。 */
  exportSnapshots(): FileHistorySnapshot[] {
    return this.snapshots.map((s) => ({
      anchorId: s.anchorId,
      timestamp: s.timestamp,
      trackedFileBackups: this.cloneBackups(s.trackedFileBackups),
    }))
  }

  /** 从持久化恢复（resume）。校验 backupRef 合法性（防 `../` 注入），丢弃非法 entry。 */
  loadSnapshots(snapshots: FileHistorySnapshot[]): void {
    this.snapshots = snapshots.map((s) => ({
      anchorId: s.anchorId,
      timestamp: s.timestamp,
      trackedFileBackups: this.sanitizeBackups(s.trackedFileBackups),
    }))
    this.rebuildTrackedFiles()
  }

  /**
   * resume 迁移（对按常见 agent 工具 `copyFileHistoryForResume`）：把上个 session
   * （`prevThreadId`）的备份文件迁到当前 backupDir。hard-link 优先、copy 兜底。
   * 某 snapshot 任一备份迁移失败 → 整个 snapshot 标记不可用（从 snapshots 移除），
   * 避免"半可用"静默回退残缺（INV-5）。
   *
   * 约定：先 `loadSnapshots(prevSnapshots)` 再调本方法。
   */
  async copyFileHistoryForResume(prevThreadId: string): Promise<void> {
    if (prevThreadId === this.threadId) {
      this.log.debug('[FileHistory] copyFileHistoryForResume: same thread, skip')
      return
    }
    const prevDir = this.threadDir(prevThreadId)
    await fs.mkdir(this.backupDir, { recursive: true })

    const failedAnchors = new Set<FileHistorySnapshot>()
    await Promise.all(
      this.snapshots.map(async (snap) => {
        const refs = Object.values(snap.trackedFileBackups)
          .filter((b) => b.kind === 'file' && b.backupRef)
          .map((b) => b.backupRef as string)
        const results = await Promise.allSettled(
          refs.map((ref) => this.migrateBackupFile(path.join(prevDir, ref), this.backupPath(ref))),
        )
        if (results.some((r) => r.status === 'rejected')) failedAnchors.add(snap)
      }),
    )

    if (failedAnchors.size > 0) {
      this.snapshots = this.snapshots.filter((s) => !failedAnchors.has(s))
      this.rebuildTrackedFiles()
      this.log.warn(
        `[FileHistory] copyFileHistoryForResume: ${failedAnchors.size} snapshot(s) unusable ` +
          `(backup migration failed); dropped from history`,
      )
    }
  }

  /** 清理超过 ttl 的整个 thread 备份目录（由上层定时调度）。 */
  async gc(olderThanMs: number): Promise<void> {
    try {
      const stat = await fs.stat(this.backupDir)
      if (Date.now() - stat.mtimeMs > olderThanMs) {
        await this.destroy()
        this.log.info(`[FileHistory] gc removed stale backups: ${this.backupDir}`)
      }
    } catch {
      /* dir 不存在，忽略 */
    }
  }

  /**
   * 彻底销毁本 thread 的所有备份（用户清理 / gc）。
   * P2-4：经 `withLock` 串行——等所有 in-flight mutation / flush 落定后才 rm，
   * 且置 `destroyed`，排在其后的 flush（doFlush re-check）一律 no-op，绝不重建。
   */
  async destroy(): Promise<void> {
    return this.withLock(async () => {
      this.destroyed = true
      if (this.flushTimer) {
        clearTimeout(this.flushTimer)
        this.flushTimer = null
      }
      await fs.rm(this.backupDir, { recursive: true, force: true }).catch(() => {})
      this.snapshots = []
      this.trackedFiles.clear()
    })
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  private pushSnapshot(s: FileHistorySnapshot): void {
    this.snapshots.push(s)
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots = this.snapshots.slice(-this.maxSnapshots)
    }
  }

  private rebuildTrackedFiles(): void {
    this.trackedFiles = new Set()
    for (const s of this.snapshots) {
      for (const rel of Object.keys(s.trackedFileBackups)) this.trackedFiles.add(rel)
    }
  }

  private async readTextFileBestEffort(absPath: string): Promise<string | undefined> {
    try {
      const st = await this.lstatOrNull(absPath)
      if (st === null || !st.isFile() || st.size > MAX_TEXT_DIFF_BYTES) return undefined
      const bytes = await fs.readFile(absPath)
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return undefined
    }
  }

  /**
   * 对普通文件做原始字节流式 sha256，不把大文件整块读入内存，也不经过
   * UTF-8 解码。读取前后 stat 不一致时拒绝产生擖裂指纹，由上层将本次
   * 预览标为 probe_failed 并 fail-closed。
   */
  private async fingerprintRegularFile(
    absPath: string,
    knownStat?: Stats,
  ): Promise<Extract<RewindFileContentFingerprint, { kind: 'file' }>> {
    const before = knownStat ?? await fs.stat(absPath)
    if (!before.isFile()) throw new Error(`[FileHistory] fingerprint target is not a regular file: ${absPath}`)

    const hash = crypto.createHash('sha256')
    await new Promise<void>((resolve, reject) => {
      const stream = fsSync.createReadStream(absPath)
      stream.on('data', chunk => hash.update(chunk))
      stream.once('error', reject)
      stream.once('end', resolve)
    })

    const after = await fs.stat(absPath)
    if (
      !after.isFile()
      || after.size !== before.size
      || after.mode !== before.mode
      || after.mtimeMs !== before.mtimeMs
      || after.ino !== before.ino
    ) {
      throw new Error(`[FileHistory] file changed while fingerprinting: ${absPath}`)
    }
    return {
      kind: 'file',
      size: before.size,
      mode: before.mode,
      sha256: hash.digest('hex'),
    }
  }

  private resolveTargetBackup(target: FileHistorySnapshot, rel: string): FileBackup | undefined {
    return target.trackedFileBackups[rel] ?? this.firstVersionBackup(rel)
  }

  private firstVersionBackup(rel: string): FileBackup | undefined {
    for (const s of this.snapshots) {
      const b = s.trackedFileBackups[rel]
      if (b && b.version === 1) return b
    }
    return undefined
  }

  private cloneBackups(src: Record<string, FileBackup>): Record<string, FileBackup> {
    const out: Record<string, FileBackup> = {}
    for (const [rel, b] of Object.entries(src)) out[rel] = { ...b }
    return out
  }

  /** 校验并复制 backups：非法 backupRef（防 `../` 注入）的 entry 丢弃 + 告警。 */
  private sanitizeBackups(src: Record<string, FileBackup>): Record<string, FileBackup> {
    const out: Record<string, FileBackup> = {}
    for (const [rel, b] of Object.entries(src)) {
      const refOk =
        b.kind === 'file' ? typeof b.backupRef === 'string' && BACKUP_REF_RE.test(b.backupRef) : b.backupRef === null
      if (!refOk) {
        this.log.warn(`[FileHistory] loadSnapshots: dropping entry with illegal backupRef for ${rel}: ${b.backupRef}`)
        continue
      }
      out[rel] = { ...b }
    }
    return out
  }

  private threadDir(threadId: string): string {
    return fileHistoryThreadDir(this.historyRoot, threadId)
  }

  private shorten(absPath: string): string {
    const abs = canonicalize(path.resolve(absPath))
    if (abs === this.wsRoot) return path.basename(abs)
    if (abs.startsWith(this.wsRoot + path.sep)) return path.relative(this.wsRoot, abs)
    return abs // 工作区外：用绝对（canonical）路径作 key
  }

  private expand(rel: string): string {
    return path.isAbsolute(rel) ? rel : path.join(this.wsRoot, rel)
  }

  private backupName(rel: string, version: number): string {
    const h = crypto.createHash('sha256').update(rel).digest('hex').slice(0, 16)
    return `${h}@v${version}`
  }

  private backupPath(ref: string): string {
    return path.join(this.backupDir, ref)
  }

  /** lstat；ENOENT → null；其他 errno 抛出（P1-7：只把 ENOENT 当"不存在"）。 */
  private async lstatOrNull(p: string): Promise<Stats | null> {
    try {
      return await fs.lstat(p)
    } catch (e) {
      if (isENOENT(e)) return null
      throw e
    }
  }

  /** stat；ENOENT → null；其他 errno 抛出。 */
  private async statOrNull(p: string): Promise<Stats | null> {
    try {
      return await fs.stat(p)
    } catch (e) {
      if (isENOENT(e)) return null
      throw e
    }
  }

  /**
   * 创建备份。用 `lstat` 区分 absent / regular-file / 非普通文件（P1-6）：
   *   - absent       → `kind:'absent'`（新建语义，rewind 回退即删除）。
   *   - regular file → 复制内容 + chmod 保真 mode（P1-5），`kind:'file'`。
   *   - symlink/dir/其他 → `kind:'unsupported'`，**不**伪装成 absent。
   */
  private async createBackup(absPath: string, rel: string, version: number): Promise<FileBackup> {
    const now = Date.now()
    const lst = await this.lstatOrNull(absPath)
    if (lst === null) return { kind: 'absent', backupRef: null, version, backupTime: now }
    if (lst.isSymbolicLink() || !lst.isFile()) {
      return { kind: 'unsupported', backupRef: null, version, backupTime: now }
    }

    const ref = this.backupName(rel, version)
    const dest = this.backupPath(ref)
    try {
      await fs.copyFile(absPath, dest)
    } catch (e) {
      if (isENOENT(e)) {
        await fs.mkdir(this.backupDir, { recursive: true })
        await fs.copyFile(absPath, dest)
      } else {
        throw e
      }
    }
    // P1-5：备份文件保真原文件 mode（restore 时据此 chmod 回去 / compare 时比 mode）。
    await fs.chmod(dest, lst.mode)
    return { kind: 'file', backupRef: ref, version, backupTime: now }
  }

  /**
   * 从备份还原（kind==='file'）。P1-6：恢复前 lstat，当前是 symlink / 目录 / 其他
   * 非普通文件时先删掉，避免 copyFile 跟随 symlink 写到 target。P1-5：chmod 回原 mode。
   */
  private async restoreBackup(absPath: string, backup: FileBackup): Promise<void> {
    const src = this.backupPath(backup.backupRef as string)
    const bakStat = await fs.stat(src) // compare 已确认存在；并发删除时这里抛错 → 上层 fail-visible
    const cur = await this.lstatOrNull(absPath)
    if (cur && (cur.isSymbolicLink() || cur.isDirectory() || !cur.isFile())) {
      await fs.rm(absPath, { force: true, recursive: cur.isDirectory() })
    }
    try {
      await fs.copyFile(src, absPath)
    } catch (e) {
      if (isENOENT(e)) {
        await fs.mkdir(path.dirname(absPath), { recursive: true })
        await fs.copyFile(src, absPath)
      } else {
        throw e
      }
    }
    await fs.chmod(absPath, bakStat.mode)
  }

  /** 删除路径（symlink / 目录安全）。返回是否真的删了东西。 */
  private async removePath(absPath: string): Promise<boolean> {
    const st = await this.lstatOrNull(absPath)
    if (st === null) return false
    await fs.rm(absPath, { force: true, recursive: st.isDirectory() })
    return true
  }

  /**
   * 当前文件与备份比较（备份 kind==='file'）：
   *   - 备份文件缺失 → `'backup-missing'`（P0-2：fail-visible，不当"无需恢复"）。
   *   - 当前缺失 / 非普通文件 → `'differs'`（需还原成备份的普通文件）。
   *   - 先比 mode + size（P1-5），再用 mtime 快路径（P1-9：原文件 mtime 早于备份
   *     时间即判未变，省一次全量读），最后才读内容比对。
   */
  private async compareFileToBackup(absPath: string, backup: FileBackup): Promise<CompareResult> {
    const src = this.backupPath(backup.backupRef as string)
    const bakStat = await this.statOrNull(src)
    if (bakStat === null) return 'backup-missing'
    const cur = await this.lstatOrNull(absPath)
    if (cur === null) return 'differs'
    if (cur.isSymbolicLink() || !cur.isFile()) return 'differs'
    if (cur.mode !== bakStat.mode || cur.size !== bakStat.size) return 'differs'
    // 不信任 mtime 作为内容证明：它可被 utimes/复制工具回拨。原始字节
    // 流式 sha256 与 compare-and-rewind 预览同口径，同时避免大文件整块进内存。
    const [currentFingerprint, backupFingerprint] = await Promise.all([
      this.fingerprintRegularFile(absPath, cur),
      this.fingerprintRegularFile(src, bakStat),
    ])
    return currentFingerprint.sha256 === backupFingerprint.sha256 ? 'same' : 'differs'
  }

  /** 文件相对上一个备份是否变化（用于 beginSnapshot 决定是否推进版本）。 */
  private async changedSince(absPath: string, prev: FileBackup): Promise<boolean> {
    if (prev.kind === 'absent') return (await this.lstatOrNull(absPath)) !== null
    // 非普通文件 / 上轮备份失败 → 总是重新评估（下一轮 beginSnapshot 尝试重新备份）。
    // backup-failed 必须在此拦截：其 backupRef 为 null，落到下方 file 分支会让
    // compareFileToBackup 用 null backupRef 计算备份路径而抛错。
    if (prev.kind === 'unsupported' || prev.kind === 'backup-failed') return true
    // prev.kind === 'file'
    const cur = await this.lstatOrNull(absPath)
    if (cur === null) return true
    if (cur.isSymbolicLink() || !cur.isFile()) return true
    return (await this.compareFileToBackup(absPath, prev)) !== 'same'
  }

  /** 迁移单个备份文件：hard-link 优先；EEXIST 视为已迁移；link 失败 copy 兜底。 */
  private async migrateBackupFile(oldPath: string, newPath: string): Promise<void> {
    try {
      await fs.link(oldPath, newPath)
      return
    } catch (e) {
      if (errnoOf(e) === 'EEXIST') return // 已迁移
      if (isENOENT(e)) {
        // 上个 session 备份不存在 → 无法迁移，抛出让该 snapshot 标记不可用。
        throw e
      }
      // 其他原因（如跨设备 EXDEV）→ copy 兜底。
      try {
        await fs.copyFile(oldPath, newPath)
      } catch (copyErr) {
        if (errnoOf(copyErr) === 'EEXIST') return
        throw copyErr
      }
    }
  }
}
