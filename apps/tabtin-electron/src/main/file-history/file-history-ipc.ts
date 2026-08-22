/**
 * File-history IPC Handlers
 *
 * 暴露 per-file 回退能力给 renderer（替代 shadow git 的 `checkpoint:restore`）：
 * - `file-history:rewind`(threadId, anchorId)：把该 thread 在 anchorId(=agentRunId)
 *   那一轮开始前 track 的文件还原（只动 Agent 改过的文件，INV-3）。
 * - `file-history:getAffectedPaths`(threadId, anchorId)：预览会被还原的文件，不写盘。
 *
 * service 实例经 `getOrResumeFileHistory` 取：先命中 host 的 per-thread 内存缓存；
 * 内存 miss 时**按 threadId 从磁盘 manifest lazy 恢复**（Bug 1：进程重启后对没再发过
 * 消息的历史会话点回退，内存空但磁盘账本仍在）。磁盘也没有该 thread → 返回 undefined
 * → `success:false`（无可回退账本，绝不静默成功）。
 *
 * 安全（P0-1）：
 *   ① threadId 必须解析出 service（内存命中或磁盘 manifest 恢复，`getOrResumeFileHistory`
 *      返回 undefined 即拒绝），不凭空对未知 thread 回退；sender guard 由 guardedHandle 兜底。
 *   ② rewind / preview 前，对回退**将写/删**的每条绝对路径走 path-access 校验
 *      （复用 fs/git/checkpoint 同源的 `getDefaultPathAccessChecker().check(p,'write')`，
 *      与 `checkpoint-ipc.ts` 的 `checkCheckpointProjectAccess` 同语义）。任一不允许
 *      → 拒绝整个 rewind（rewind 在引擎锁内原子校验，preview 在此处校验）。
 *      防"会话内 track 的文件在工作区边界变更后被回退到工作区外 / 红线路径"。
 */
import path from 'path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { guardedHandle } from '../utils/guarded-handle'
import { createLogger } from '../logger'
import {
  getCurrentUserFileHistoryRoots,
  getOrResumeFileHistory,
} from './file-history-registry'
import { getDefaultPathAccessChecker } from '../security/path-access-checker'
import {
  previewControlDeviceFiles,
  rewindControlDeviceFiles,
} from './control-device-file-rewind'
import { getBucket, registerStorageBucket } from '@tabtin/storage-manager'
import { buildLocalFilePreviewRevision } from '@shared/file-preview-revision'
import { getDeviceFingerprint } from '../utils/deviceFingerprint.js'

const log = createLogger('FileHistoryIPC')

export function registerFileHistoryIpcHandlers(): void {
  /** 回退：还原该 thread 在 anchorId 那一轮开始前 track 的文件。 */
  guardedHandle('file-history:rewind', async (
    _event,
    threadId: string,
    anchorId: string,
    expectedPreviewRevision?: string,
  ) => {
    // 回退 = 覆盖工作区已 track 文件（不可逆），起止都留痕；threadId/anchorId 为内部 id，非 PII
    log.info('rewind 开始', { threadId, anchorId })
    // ② path guard：引擎在锁内、写盘前对每条受影响路径调一次，任一不允许 → 不触碰文件。
    let guardBlocked = 0
    const checker = getDefaultPathAccessChecker()
    const outcome = await rewindControlDeviceFiles(threadId, anchorId, {
      getFileHistory: getOrResumeFileHistory,
      pathGuard: (absPath) => {
        const access = checker.check(absPath, 'write')
        if (!access.allowed) guardBlocked++
        return { allowed: access.allowed, reason: access.reason?.message }
      },
      expectedPreviewRevision,
    })
    if (outcome.success) {
      log.info('rewind 完成', { threadId, anchorId, guardBlocked })
      return { success: true, result: outcome.result }
    }
    log.error('rewind failed:', outcome.error)
    return { success: false, error: outcome.error, reason: outcome.reason }
  })

  /** 预览：列出回退到 anchorId 会影响的文件（绝对路径），不写盘。 */
  guardedHandle('file-history:getAffectedPaths', async (_event, threadId: string, anchorId: string) => {
    // 与 rewind 同源：内存命中或磁盘 manifest lazy 恢复（Bug 1：重启后预览也要能看到将恢复的文件）。
    const svc = await getOrResumeFileHistory(threadId)
    if (!svc) {
      return { success: false, error: `No file-history for thread ${threadId}`, paths: [] }
    }
    try {
      const paths = await svc.getAffectedPaths(anchorId)
      // ② 与 rewind 同源的 path guard：任一受影响路径不在工作区 / 命中红线 → 整体拒绝，
      //    不向 renderer 暴露越界路径（与 rewind 原子拒绝语义对齐）。
      const checker = getDefaultPathAccessChecker()
      const blocked = paths.filter((p) => !checker.check(p, 'write').allowed)
      if (blocked.length > 0) {
        return {
          success: false,
          error: `Rewind would touch ${blocked.length} path(s) outside your workspace or on a protected path: ${blocked.join(', ')}`,
          paths: [],
        }
      }
      return { success: true, paths }
    } catch (error) {
      log.error('getAffectedPaths failed:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error), paths: [] }
    }
  })

  /**
   * 编辑重发的权威本机预览：除路径外同时绑定当前/目标内容，执行前由 Host
   * 用同一函数重算，防止确认后文件继续变化。
   */
  guardedHandle('file-history:getPreview', async (_event, threadId: string, anchorId: string | null) => {
    if (!anchorId) {
      return {
        success: true as const,
        status: 'not_applicable' as const,
        paths: [] as string[],
        reason: 'no_file_anchor' as const,
        revision: await buildLocalFilePreviewRevision({
          sessionId: threadId,
          deviceFingerprint: getDeviceFingerprint(),
          rewindAnchorId: null,
          status: 'not_applicable',
          reason: 'no_file_anchor',
          affectedPaths: [],
          fingerprints: [],
        }),
        unrestorable: [],
      }
    }
    const checker = getDefaultPathAccessChecker()
    return previewControlDeviceFiles(threadId, anchorId, {
      getFileHistory: getOrResumeFileHistory,
      pathGuard: (absPath) => {
        const access = checker.check(absPath, 'write')
        return { allowed: access.allowed, reason: access.reason?.message }
      },
    })
  })

  /** 回退前 safety 快照：捕获当前 tracked 文件状态，供 unrevert 时 rewind 还原。 */
  guardedHandle('file-history:createSafetySnapshot', async (_event, threadId: string, safetyAnchorId: string) => {
    const svc = await getOrResumeFileHistory(threadId)
    if (!svc) {
      return { success: false, error: `No file-history for thread ${threadId} (no snapshot on disk)` }
    }
    try {
      await svc.createSafetySnapshot(safetyAnchorId)
      log.info('createSafetySnapshot 完成', { threadId, safetyAnchorId })
      return { success: true as const }
    } catch (error) {
      log.error('createSafetySnapshot failed:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /** 预览：回退到 anchorId 的文件 diff（与 rewind 同 anchor，）。
   *  只用于备份一致性校验 / 回退预览。Agent Turn 行级 Diff 不走这条路径
   *  （当前盘 vs 轮开始备份会混入用户手改，见 ）。 */
  guardedHandle('file-history:getRewindDiff', async (_event, threadId: string, anchorId: string) => {
    const svc = await getOrResumeFileHistory(threadId)
    if (!svc) {
      return { success: false, error: `No file-history for thread ${threadId}`, diffs: [] as const }
    }
    try {
      const diffs = await svc.getRewindDiff(anchorId)
      return { success: true as const, diffs }
    } catch (error) {
      log.error('getRewindDiff failed:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error), diffs: [] as const }
    }
  })

  registerFileHistoryStorageBucket()
  startFileHistoryGc()
}

// ─── storage-manager 注册（file-history）─────────────────────────────
// per-file 回退备份落盘形态：`~/.tabtin/file-history/<sha256(threadId)>/` 下
// 每个对话 thread 的"改前内容"备份 + manifest.json。这是 per-file 迁移后撤销
// 快照的实际占用（取代旧 `checkpoint:shadow-git`），注册成 bucket 让用户在存储
// 面板里看得到、清得掉，否则只有旧 shadow-git bucket、per-file 备份不可见。
//
// 反查项目名：thread 目录名是 sha256(threadId)（不可逆），故读目录内
// manifest.json 的 `workspaceRoot` 给用户认，而非反解 threadId。
// 清理：直接 fs.rm 对应 thread 目录——按 hash 无法重建 FileHistoryService 走其
// destroy()，host registry 也只按 threadId 寻址。这与旧 checkpoint bucket 的
// fs.rm 兜底同款；用户主动清理是显式 data 类 hard 确认操作，可接受。

const FILE_HISTORY_BUCKET_ID = 'checkpoint:file-history'
const FILE_HISTORY_SIZE_CACHE_TTL_MS = 5_000
// 磁盘 TTL（方案 §3.6：默认 30 天）。超过该时长未写入的 thread 备份目录由周期
// GC 回收——mtime 判定，与 file-history-core `FileHistoryService.gc(olderThanMs)`
// 完全同口径。
const FILE_HISTORY_GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const FILE_HISTORY_GC_INTERVAL_MS = 24 * 60 * 60 * 1000
const FILE_HISTORY_GC_INITIAL_DELAY_MS = 60_000

interface FileHistorySizeCache {
  scopeKey: string
  ts: number
  bytes: number
  itemCount: number
}
let _fileHistorySizeCache: FileHistorySizeCache | null = null

/** 递归累加目录字节数；不可读条目跳过，整体不抛错（与 checkpoint bucket 同口径）。 */
async function _calcDirSizeBest(dir: string): Promise<number> {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        total += await _calcDirSizeBest(full)
      } else if (entry.isFile()) {
        total += (await fsp.stat(full)).size
      }
    } catch { /* ignore unreadable */ }
  }
  return total
}

interface FileHistoryThread {
  /** sha256(threadId) —— file-history 根下的目录名，bucket item id */
  id: string
  threadHash: string
  organizationId: string
  workspaceId: string
  /** 绝对路径 */
  dir: string
  bytes: number
  mtimeMs: number | null
  /** manifest.json 记录的 canonical workspaceRoot；缺失/损坏则 null */
  workspaceRoot: string | null
}

/** 扫描 file-history 根，列出每个 thread 备份目录的占用与反查信息。 */
async function _listFileHistoryThreads(): Promise<FileHistoryThread[]> {
  const out: FileHistoryThread[] = []
  for (const { organizationId, workspaceId, historyRoot } of getCurrentUserFileHistoryRoots()) {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(historyRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(historyRoot, entry.name)
      let workspaceRoot: string | null = null
      try {
        const raw = await fsp.readFile(path.join(dir, 'manifest.json'), 'utf-8')
        const parsed = JSON.parse(raw) as { workspaceRoot?: unknown }
        if (typeof parsed.workspaceRoot === 'string') workspaceRoot = parsed.workspaceRoot
      } catch { /* manifest 缺失/损坏 → workspaceRoot 未知，仍计入占用 */ }
      let mtimeMs: number | null = null
      try {
        mtimeMs = (await fsp.stat(dir)).mtimeMs
      } catch { /* skip */ }
      const bytes = await _calcDirSizeBest(dir).catch(() => 0)
      out.push({
        id: Buffer.from(JSON.stringify([organizationId, workspaceId, entry.name])).toString('base64url'),
        threadHash: entry.name,
        organizationId,
        workspaceId,
        dir,
        bytes,
        mtimeMs,
        workspaceRoot,
      })
    }
  }
  return out
}

export function registerFileHistoryStorageBucket(): void {
  if (getBucket(FILE_HISTORY_BUCKET_ID)) return

  registerStorageBucket({
    id: FILE_HISTORY_BUCKET_ID,
    category: 'data',
    group: 'checkpoint',
    displayName: 'Agent 回退备份',
    description: '按对话轮次保存的文件改动备份，编辑消息「恢复并发送」回退依赖它',
    warnings: [
      '清掉后，这些对话将无法再通过「编辑消息并恢复」回退到改动前',
      '已经回退过的状态不受影响——只是后续无法再回到清理前的备份点',
      '建议先在项目里手动 git commit 一次再清',
    ],
    sizeFn: async () => {
      const now = Date.now()
      const scopeKey = getCurrentUserFileHistoryRoots()
        .map(item => item.historyRoot)
        .sort()
        .join('|')
      if (
        _fileHistorySizeCache?.scopeKey === scopeKey &&
        now - _fileHistorySizeCache.ts < FILE_HISTORY_SIZE_CACHE_TTL_MS
      ) {
        return {
          bytes: _fileHistorySizeCache.bytes,
          itemCount: _fileHistorySizeCache.itemCount,
        }
      }
      const threads = await _listFileHistoryThreads()
      const bytes = threads.reduce((sum, t) => sum + t.bytes, 0)
      const itemCount = threads.length
      _fileHistorySizeCache = { scopeKey, ts: now, bytes, itemCount }
      return { bytes, itemCount }
    },
    listFn: async () => {
      const threads = await _listFileHistoryThreads()
      return threads.map(t => ({
        id: t.id,
        label: t.workspaceRoot
          ? `${path.basename(t.workspaceRoot)}  (${t.workspaceRoot})`
          : `未知会话 ${t.id.slice(0, 8)}…`,
        bytes: t.bytes,
        metadata: {
          organizationId: t.organizationId,
          workspaceId: t.workspaceId,
          threadHash: t.threadHash,
          workspaceRoot: t.workspaceRoot,
          lastModified: t.mtimeMs,
        },
      }))
    },
    clearFn: async (options) => {
      const threads = await _listFileHistoryThreads()
      const targetIds = options?.itemIds && options.itemIds.length > 0
        ? new Set(options.itemIds)
        : null
      const targets = targetIds
        ? threads.filter(t => targetIds.has(t.id))
        : threads
      const freedBytes = targets.reduce((sum, t) => sum + t.bytes, 0)
      if (options?.dryRun) {
        return { clearedItemCount: targets.length, freedBytes }
      }
      // 批量清理回退备份 = 不可逆删除，记录发起范围
      log.warn('storage-bucket clearFn 开始清理 file-history 备份', {
        targetCount: targets.length,
        scope: targetIds ? 'selected' : 'all',
      })
      const errors: string[] = []
      let cleared = 0
      for (const t of targets) {
        try {
          await fsp.rm(t.dir, { recursive: true, force: true })
          cleared++
        } catch (err) {
          errors.push(`rm(${t.id}) 失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      _fileHistorySizeCache = null
      if (errors.length > 0) {
        log.warn('storage-bucket clearFn 部分清理失败', { cleared, failed: errors.length, errors })
      } else {
        log.info('storage-bucket clearFn 完成', { cleared, freedBytes })
      }
      return {
        clearedItemCount: cleared,
        freedBytes,
        ...(errors.length > 0 ? { errors } : {}),
      }
    },
  })
}

// ─── 磁盘 TTL GC（方案 §3.6：默认 30 天）─────────────────────────────
/**
 * 回收超过 maxAgeMs 未写入的整个 thread 备份目录。判定口径（目录 mtime 超时 →
 * 删整目录）与 `@tabtin/file-history-core` 的 `FileHistoryService.gc(olderThanMs)`
 * 完全一致。
 *
 * 为什么在 host 层做、不直接调 core 的 gc()：
 *   - core gc() 是 per-instance（需 threadId + workspaceRoot 构造 service），但磁盘
 *     上只有 sha256(threadId) 目录名、不可逆，无法据此重建 service 来逐个调；
 *   - FileHistoryRegistry 目前没有"遍历磁盘所有 thread 批量 gc"的入口，而
 *     file-history-core 是本批次禁改区（并行批次在改），不在此新增接口。
 *   ⇒ 故在 host 层按同一 mtime 口径直接回收。活跃 thread 每轮 trackEdit / flush 都
 *     会刷新目录 mtime，30 天 TTL 只会命中长期废弃的备份，与活跃实例无竞争。
 *
 * TODO（迁移收口后）：把"遍历 + 批量 gc"下沉为 file-history-core 的
 *   `FileHistoryRegistry.gcAll(olderThanMs)`（逐个走 service 的 withLock+gc），
 *   host 只调一次，删除此处的磁盘级重复实现。
 */
export async function gcStaleFileHistory(
  maxAgeMs: number = FILE_HISTORY_GC_MAX_AGE_MS,
): Promise<void> {
  const now = Date.now()
  let removed = 0
  for (const { historyRoot } of getCurrentUserFileHistoryRoots()) {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(historyRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(historyRoot, entry.name)
      try {
        const stat = await fsp.stat(dir)
        if (now - stat.mtimeMs > maxAgeMs) {
          await fsp.rm(dir, { recursive: true, force: true })
          removed++
        }
      } catch { /* 单目录失败不阻断整轮 */ }
    }
  }
  if (removed > 0) {
    _fileHistorySizeCache = null
    log.info(
      `file-history gc removed ${removed} stale thread backup(s) (> ${Math.round(maxAgeMs / 86_400_000)}d)`,
    )
  }
}

let _fileHistoryGcTimer: ReturnType<typeof setInterval> | null = null

/** 启动周期 TTL GC（unref，不阻塞进程退出）；幂等，重复调用不再起新定时器。 */
function startFileHistoryGc(): void {
  if (_fileHistoryGcTimer) return
  // 延迟首跑，避开冷启动 IO 高峰。
  const kick = setTimeout(() => {
    void gcStaleFileHistory().catch((err) => log.warn('file-history gc (initial) failed:', err))
  }, FILE_HISTORY_GC_INITIAL_DELAY_MS)
  kick.unref?.()
  _fileHistoryGcTimer = setInterval(() => {
    void gcStaleFileHistory().catch((err) => log.warn('file-history gc failed:', err))
  }, FILE_HISTORY_GC_INTERVAL_MS)
  _fileHistoryGcTimer.unref?.()
}
