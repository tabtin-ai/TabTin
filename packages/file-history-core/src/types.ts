/**
 * file-history-core 类型契约 —— per-file 内容快照回退引擎
 *
 * 设计采用 per-file 内容快照方案：只追踪 Agent 通过
 * 文件编辑工具改过的文件，回退时只还原这些文件，**不依赖 git、不依赖工作区
 * 根的权限判定**。完整背景见 checkpoint / file-history 总方案。
 *
 * ── 系统不变量（由实现 + 测试守护）──
 * - INV-1 每个被 `trackEdit` 的文件，在其所属 snapshot 里必有一条 backup 记录、
 *         且一定进入 `trackedFiles`：成功是 before-backup（`rewind` 据此还原到
 *         "改之前"），失败是 `kind:'backup-failed'` 标记（`rewind` 计入 `failedFiles`）。
 *         绝不"备份失败就直接 return、静默漏记"——否则首次 track 的文件不进
 *         `trackedFiles`，`rewind` 根本不遍历它，用户看不到它无法回退（见 INV-5）。
 * - INV-2 同一 snapshot 内，同一文件的 before-backup 只写一次，不被后续
 *         `trackEdit` 覆盖（否则会把"改后内容"当成"改前内容"）。三阶段提交
 *         在 commit 时 re-check 该 anchor 是否已有此文件的 backup，防并发 race
 *         覆盖（对照 `trackEdit` Phase3）。
 * - INV-3 `rewind` 只触碰 `trackedFiles` 集合内的文件，绝不扫描 / 改动工作区
 *         里其他文件（用户手改、其他来源改动一律不碰）。
 * - INV-4 `rewind` 不依赖 git，也不依赖 `workspaceRoot` 的权限白名单；
 *         `workspaceRoot` 仅用于相对路径压缩（省存储 + 跨机一致）。
 * - INV-5 备份缺失 / 不可恢复（非普通文件、metadata 丢失、迁移失败、
 *         **首次 track 时备份创建失败 `kind:'backup-failed'`**）一律
 *         **fail-visible**：计入 `RewindResult.failedFiles`，绝不静默当"无需恢复
 *         即成功"。上层据此提示用户"这些文件无法自动回退"。
 * - INV-6 `trackEdit(anchorId, absPath)` 把 before-backup 归属到**指定 anchorId**
 *         的 snapshot，而不是"最新 snapshot"——并发 / 多 runtime / beginSnapshot
 *         失败时都不会归错轮。
 */

/**
 * 备份内容种类：
 * - `'file'`       普通文件，`backupRef` 指向 backupDir 内的备份文件。
 * - `'absent'`     该版本下文件不存在（新建前 / 已删除）；`rewind` 回退即"删除"。
 * - `'unsupported'` 非普通文件（symlink / 目录 / 设备节点 等），无法用内容备份
 *                  语义安全地还原；`rewind` 计入 `failedFiles`，**绝不**当成
 *                  `'absent'` 去删除（删目录 / 删软链是破坏性误操作）。
 * - `'backup-failed'` 备份创建本身失败（IO / 权限 / 非 ENOENT 的 lstat 错误等）。
 *                  备份失败时**不能**直接 return：首次 track 的文件若不落标记就漏进
 *                  `trackedFiles`，`rewind` 不遍历它 → `failedFiles` 为空 → 用户看不到
 *                  它无法回退（违背 INV-5）。故改记此 kind 并 `trackedFiles.add`，让
 *                  `rewind` 计入 `failedFiles`；既无 before-backup，`rewind` **绝不**
 *                  触碰该文件（碰它只会把"未备份的现场"改坏）。
 */
export type BackupKind = 'file' | 'absent' | 'unsupported' | 'backup-failed'

/** 备份引用：`'file'` 时为备份文件名（相对 backupDir），其余种类为 `null`。 */
export type BackupRef = string | null

export interface FileBackup {
  /** 备份内容种类，决定 `rewind` 的还原策略。 */
  kind: BackupKind
  /** `kind==='file'` 时为备份文件名（`<sha256(relPath)[:16]>@v<n>`），否则 `null`。 */
  backupRef: BackupRef
  /** 文件版本号（同一文件跨轮递增；用于 firstVersion 回退解析）。 */
  version: number
  /** 备份创建时间（ms epoch）。 */
  backupTime: number
  /**
   * 仅 `kind==='backup-failed'`：备份失败原因（透传给日志 / 上层诊断，fail-visible）。
   * 其余 kind 省略。
   */
  error?: string
}

export interface FileHistorySnapshot {
  /** 回退锚点：一轮 Agent 回复 = 一个 anchorId（业务上 = agentRunId）。 */
  anchorId: string
  /** 相对 workspaceRoot 的文件路径 → 该文件在"本轮开始前"的备份。 */
  trackedFileBackups: Record<string, FileBackup>
  timestamp: number
}

export interface FileHistoryState {
  snapshots: FileHistorySnapshot[]
  trackedFiles: Set<string>
}

export interface FileHistoryLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
}

export interface RewindResult {
  /** 被还原内容的文件（绝对路径）。 */
  filesRestored: string[]
  /** 被删除的文件（绝对路径，目标版本下不存在）。 */
  filesDeleted: string[]
  /**
   * 无法回退的文件（绝对路径）——备份缺失、非普通文件、metadata 解析不到、
   * 恢复/删除时报非 ENOENT 的 OS 错误。**fail-visible（INV-5）**：上层必须把
   * 这批文件呈现给用户，绝不能当作回退成功。
   */
  failedFiles: string[]
}

/** per-file 回退预览 diff 单条（与 CheckpointDiffSheet DiffFileEntry 对齐）。 */
export interface RewindDiffEntry {
  /** 相对 workspaceRoot 的路径（展示用）。 */
  path: string
  status: 'added' | 'modified' | 'deleted'
  /** 回退前（当前磁盘）内容；新建语义下省略。 */
  before?: string
  /** 回退后（anchor 备份）内容；删除语义下省略。 */
  after?: string
}

export type RewindPreviewGapReason =
  | 'missing_metadata'
  | 'unsupported'
  | 'backup_failed'
  | 'backup_missing'
  | 'current_non_file'
  | 'probe_failed'

export interface RewindPreviewGap {
  /** 相对 workspaceRoot 的路径（工作区外记录绝对路径）。 */
  path: string
  reason: RewindPreviewGapReason
  detail?: string
}

/**
 * 参与 compare-and-rewind 的单路径原始字节指纹。文本 diff 只供 UI 展示，
 * 不得用来做 CAS：非 UTF-8 字节可能被解码成同一个替换字符。
 */
export type RewindFileContentFingerprint =
  | { kind: 'absent' }
  | { kind: 'file'; size: number; mode: number; sha256: string }

export interface RewindFileFingerprint {
  /** 相对 workspaceRoot 的路径，与 diff.path 同口径。 */
  path: string
  status: 'added' | 'modified' | 'deleted'
  current: RewindFileContentFingerprint
  target: RewindFileContentFingerprint
}

/** 回退前只读探测；同时覆盖会写入的影响与执行时必然失败的已知缺口。 */
export interface RewindPreview {
  affectedPaths: string[]
  diffs: RewindDiffEntry[]
  /** 用于确认后执行前复验的原始字节指纹；与 affectedPaths 一一对应。 */
  fingerprints: RewindFileFingerprint[]
  unrestorable: RewindPreviewGap[]
}

/**
 * rewind 单路径放行判定（P0-1 ②）。host 注入平台相关 path-access 实现
 * （Electron `getDefaultPathAccessChecker().check`；Daemon `checkDaemonPathAccess`）；
 * 引擎只负责"对将被写/删的每条路径调一次 guard、任一不允许→原子拒绝整个 rewind"。
 */
export interface PathGuardDecision {
  allowed: boolean
  /** 拒绝原因（透传给上层错误信息），允许时可省略。 */
  reason?: string
}

/** rewind 路径守卫：对**绝对路径**判定是否允许写/删。同步判定（与现有 checker 一致）。 */
export type RewindPathGuard = (absPath: string) => PathGuardDecision

export interface RewindOptions {
  /**
   * 可选 path 守卫（P0-1 ②）。提供时：rewind 在**锁内、写盘前**对将被写/删的
   * 每条绝对路径调一次；任一 `allowed:false` → 抛错、**不触碰任何文件**（原子）。
   * 未提供时（如纯引擎单测）跳过守卫，行为与旧版一致。
   */
  pathGuard?: RewindPathGuard
  /**
   * 用户确认预览时的不透明修订值。提供时必须同时提供
   * `previewRevisionFactory`；引擎会在与写盘同一把锁内重算富预览并严格比对。
   */
  expectedPreviewRevision?: string
  /** 将锁内重算的富预览转为 host 级修订值。 */
  previewRevisionFactory?: (preview: RewindPreview) => string | Promise<string>
}

/**
 * `flushNow()` 的结果（P2-5 ②③）。host 据此观测持久化健康度：
 * - `ok=false`：本次 manifest 写盘失败（磁盘满 / 权限 / IO 错误）。
 * - `degraded=true`：曾检测到 manifest 损坏（已 quarantine）或写盘失败，账本进入降级。
 */
export interface FlushResult {
  ok: boolean
  degraded: boolean
  /** 最近一次失败/降级原因（ok 且未降级时为 undefined）。 */
  error?: string
}

export interface FileHistoryServiceOptions {
  /** 业务对话 thread id；备份隔离在 `<historyRoot>/<sha256(threadId)>/`。 */
  threadId: string
  /** 工作区根，仅用于相对路径压缩（不参与权限判定，见 INV-4）。 */
  workspaceRoot: string
  /** 备份根目录，如 `~/.tabtin/file-history`。 */
  historyRoot: string
  logger: FileHistoryLogger
  /** 内存中保留的 snapshot 上限（滑窗淘汰），默认 50。 */
  maxSnapshots?: number
  /**
   * 是否启用元数据自动持久化（跨重启 / 同 thread 多 query / resume）。
   *
   * - `true`：构造后调 `init()` 从 `<backupDir>/manifest.json` 加载已有 snapshots；
   *   每次 mutation（beginSnapshot / trackEdit）后 debounced flush 回 manifest。
   * - `false`（默认）：`init()` / 自动 flush 全 no-op，行为与无持久化完全一致
   *   （保留给纯内存场景 / 单测，零磁盘副作用、零定时器）。
   *
   * 持久化的只是 snapshot **元数据**（anchorId / backupRef / version …）；备份
   * 文件内容本来就落在 backupDir，二者一起构成可 resume 的完整 ledger。
   */
  persist?: boolean
}
