/**
 * Checkpoint IPC Handlers
 *
 * Registers IPC handlers for the checkpoint system,
 * bridging renderer ↔ main process via `checkpoint:*` channels.
 */

import path from 'path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import {
  getCheckpointService,
  destroyCheckpointService,
  destroyCheckpointServiceAtRoot,
  getCurrentUserCheckpointRoots,
} from './CheckpointService'
import { createLogger } from '../logger'
import { guardedHandle } from '../utils/guarded-handle'
import { getBucket, registerStorageBucket } from '@tabtin/storage-manager'
import {
  parseShadowCoreWorktreeFromConfig,
  type CheckpointCommitPolicy,
  type CheckpointRestoreOptions,
} from '@tabtin/checkpoint-core'
import { getDefaultPathAccessChecker } from '../security/path-access-checker'

const log = createLogger('CheckpointIPC')

/**
 * 路径权限治理 Wave 2：checkpoint IPC 路径权限单源化。
 *
 * 老模型 O14（旧名 isProjectPathSafe，只允许 home 子树）已退役——它比
 * fs / git 的兄弟版还要简单（连 deny 列表都没），让"用户在外接盘
 * `/Volumes/外接盘/项目/` 上 init checkpoint"这种场景永远撞墙。
 *
 * 新实现走 path-access-checker 与 fs / git 同源消费 v3 snapshot.allowedPaths
 * + 平台基础路径（home / spacesRoot / platformDataRoot），跨盘项目自动放行。
 *
 * checkpoint 操作既读又写——按 'write' 走最严语义（allowedPaths boundary +
 * 红线 + sensitive 全检查）。read-only 的 listCommits / diff 等也走 'write'
 * 是有意为之：checkpoint 的整体语义是"项目级写权限"，列 commits 的前提也是
 * 用户对该项目目录有完整控制权，按读放行反而违反"snapshot 可信任 = 项目可
 * 访问"的语义内聚。
 *
 * Wave 2 第一轮 Review B1 修复：返回 result envelope 而非纯 boolean——把
 * path-access-checker 的 actionable 错误信息（"Open this folder in
 * TabFolder/TabCode to authorize..."）原样透传给 renderer，与 fs / git IPC
 * 的错误文案语义对齐。旧 `'invalid project path'` 五字常量被吞掉，用户在
 * `/Volumes/外接盘/项目/` 上点 Init Checkpoint 时既不知道是路径错还是没
 * 授权、也不知道破解方法是去 TabFolder 打开它。
 */
interface CheckpointAccessOk {
  ok: true
  resolvedPath: string
}
interface CheckpointAccessDenied {
  ok: false
  error: string
}
type CheckpointAccessResult = CheckpointAccessOk | CheckpointAccessDenied

function checkCheckpointProjectAccess(projectPath: unknown): CheckpointAccessResult {
  if (!projectPath || typeof projectPath !== 'string') {
    log.warn('checkpoint 访问被拒绝：projectPath 缺失或非字符串')
    return { ok: false, error: 'project path is required and must be a non-empty string' }
  }
  const resolved = path.resolve(projectPath)
  const access = getDefaultPathAccessChecker().check(resolved, 'write')
  if (access.allowed) {
    return { ok: true, resolvedPath: resolved }
  }
  // 路径权限被拒绝是排查"Init Checkpoint 无反应"的关键信号——basename 足够定位，
  // 不打完整路径（家目录用户名脱敏兜底 + 源头最小化）。
  log.warn('checkpoint 访问被拒绝', { project: path.basename(resolved), reason: access.reason?.message })
  return {
    ok: false,
    error: access.reason?.message ?? 'invalid project path',
  }
}

/**
 * DI-006: 将 checkpoint 异常分类为可操作的错误类型，
 * 使 Agent 能区分「已建立 checkpoint」和具体的失败原因。
 */
export type CheckpointErrorType =
  | 'disk_full'
  | 'lock_conflict'
  | 'lock_timeout'
  | 'worktree_mismatch'
  | 'project_path_not_exist'
  | 'git_corrupted'
  | 'unknown'

export function categorizeCheckpointError(error: unknown): CheckpointErrorType {
  const msg = error instanceof Error ? error.message : String(error)
  if (msg.includes('ENOSPC') || msg.includes('No space left')) return 'disk_full'
  if (msg.includes('index.lock') || msg.includes('Another git process')) return 'lock_conflict'
  if (msg.includes('Lock acquisition timed out')) return 'lock_timeout'
  // 项目目录不存在 —— CheckpointService._doInit() 抛的明确错；
  // 也兜住 git 进程在 setup 阶段 fatal 出来的"Invalid path ... No such file or directory"
  // （理论上 _doInit 提前拦截了这种情况就不会冒这条，但保留作为深度防御）。
  if (
    msg.includes('Project path does not exist') ||
    (msg.includes('Invalid path') && msg.includes('No such file or directory'))
  ) return 'project_path_not_exist'
  if (msg.includes('worktree mismatch')) return 'worktree_mismatch'
  if (
    (msg.includes('HEAD') && (msg.includes('invalid') || msg.includes('bad object'))) ||
    msg.includes('corrupt') ||
    msg.includes('Shadow repo recovery failed')
  ) return 'git_corrupted'
  return 'unknown'
}

export function registerCheckpointIpcHandlers(): void {
  /**
   * Initialize shadow git repo for a project directory.
   */
  guardedHandle(
    'checkpoint:init',
    async (_event, projectPath: string) => {
      const access = checkCheckpointProjectAccess(projectPath)
      if (!access.ok) return { success: false, error: access.error }
      try {
        const service = getCheckpointService(projectPath)
        await service.init()
        log.info('init 完成', { project: path.basename(access.resolvedPath) })
        return { success: true }
      } catch (error) {
        log.error('init failed:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          errorType: categorizeCheckpointError(error),
        }
      }
    },
  )

  /**
   * Create a checkpoint (git commit) and return the commit hash.
   * DI-006: 返回 errorType 使调用方能区分磁盘满/锁冲突/git 损坏等具体失败原因。
   */
  guardedHandle(
    'checkpoint:commit',
    async (_event, projectPath: string, policy?: CheckpointCommitPolicy) => {
      const access = checkCheckpointProjectAccess(projectPath)
      if (!access.ok) return { success: false, error: access.error, commitHash: null }
      try {
        const service = getCheckpointService(projectPath)
        const commitHash = await service.commit(policy)
        // 创建快照（数据完整性节点）：记录 project + commitHash 便于回溯 Rewind 链
        log.info('commit 完成', {
          project: path.basename(access.resolvedPath),
          commitHash: commitHash ?? null,
        })
        return { success: true, commitHash: commitHash ?? null }
      } catch (error) {
        log.error('commit failed:', error)
        return {
          success: false,
          commitHash: null,
          error: error instanceof Error ? error.message : String(error),
          errorType: categorizeCheckpointError(error),
        }
      }
    },
  )

  /**
   * 轻量级工作区快照：git add + write-tree，不创建 commit。
   */
  guardedHandle(
    'checkpoint:writeTree',
    async (_event, projectPath: string) => {
      const access = checkCheckpointProjectAccess(projectPath)
      if (!access.ok) return { success: false, error: access.error, treeHash: null }
      try {
        const service = getCheckpointService(projectPath)
        const treeHash = await service.writeTree()
        return { success: true, treeHash: treeHash ?? null }
      } catch (error) {
        log.error('writeTree failed:', error)
        return {
          success: false,
          treeHash: null,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  )

  /**
   * Get the initial checkpoint hash (root commit) for a organization.
   */
  guardedHandle(
    'checkpoint:initial',
    async (_event, projectPath: string) => {
      const access = checkCheckpointProjectAccess(projectPath)
      if (!access.ok) return { success: false, error: access.error, commitHash: null }
      try {
        const service = getCheckpointService(projectPath)
        const commitHash = await service.getInitialCommitHash()
        return { success: true, commitHash }
      } catch (error) {
        log.error('initial failed:', error)
        return {
          success: false,
          commitHash: null,
          error: error instanceof Error ? error.message : String(error),
          errorType: categorizeCheckpointError(error),
        }
      }
    },
  )

  /**
   * Restore organization files to a previous checkpoint.
   */
  guardedHandle(
    'checkpoint:restore',
    async (_event, projectPath: string, commitHash: string, options?: CheckpointRestoreOptions) => {
      const access = checkCheckpointProjectAccess(projectPath)
      if (!access.ok) return { success: false, error: access.error }
      // 恢复 = 回滚 + 覆盖工作区（不可逆的数据完整性操作），起止都必须留痕
      log.info('restore 开始', {
        project: path.basename(access.resolvedPath),
        commitHash,
        options,
      })
      try {
        const service = getCheckpointService(projectPath)
        await service.restore(commitHash, options)
        log.info('restore 完成', {
          project: path.basename(access.resolvedPath),
          commitHash,
        })
        return { success: true }
      } catch (error) {
        log.error('restore failed:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          errorType: categorizeCheckpointError(error),
        }
      }
    },
  )

  /**
   * Get file diffs between two checkpoints (or checkpoint vs working dir).
   */
  guardedHandle(
    'checkpoint:diff',
    async (_event, projectPath: string, fromHash: string, toHash?: string) => {
      const access = checkCheckpointProjectAccess(projectPath)
      if (!access.ok) return { success: false, error: access.error, diffs: [] }
      try {
        const service = getCheckpointService(projectPath)
        const diffs = await service.getDiff(fromHash, toHash)
        return { success: true, diffs }
      } catch (error) {
        log.error('diff failed:', error)
        return {
          success: false,
          diffs: [],
          error: error instanceof Error ? error.message : String(error),
          errorType: categorizeCheckpointError(error),
        }
      }
    },
  )

  /**
   * 获取指定 commit 的变更摘要统计（文件数、行增删）。
   * 可选 baseHash 参数指定对比基线，不提供则对比父 commit。
   */
  guardedHandle(
    'checkpoint:diffSummary',
    async (_event, projectPath: string, commitHash: string, baseHash?: string) => {
      const empty = { files: [], summary: { changed: 0, insertions: 0, deletions: 0 } }
      const access = checkCheckpointProjectAccess(projectPath)
      if (!access.ok) return { success: false, error: access.error, ...empty }
      try {
        const service = getCheckpointService(projectPath)
        const result = await service.getDiffSummary(commitHash, baseHash)
        return { success: true, ...result }
      } catch (error) {
        log.error('diffSummary failed:', error)
        return {
          success: false,
          ...empty,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  )

  /**
   * 获取 Shadow Git 的 commit 历史列表，支持分页。
   */
  guardedHandle(
    'checkpoint:listCommits',
    async (_event, projectPath: string, options?: { limit?: number; skip?: number }) => {
      const access = checkCheckpointProjectAccess(projectPath)
      if (!access.ok) return { success: false, error: access.error, commits: [] }
      try {
        const service = getCheckpointService(projectPath)
        const commits = await service.listCommits(options)
        return { success: true, commits }
      } catch (error) {
        log.error('listCommits failed:', error)
        return {
          success: false,
          commits: [],
          error: error instanceof Error ? error.message : String(error),
          errorType: categorizeCheckpointError(error),
        }
      }
    },
  )

  /**
   * Run garbage collection on the shadow git repo.
   */
  guardedHandle(
    'checkpoint:gc',
    async (_event, projectPath: string) => {
      const access = checkCheckpointProjectAccess(projectPath)
      if (!access.ok) return { success: false, error: access.error }
      try {
        const service = getCheckpointService(projectPath)
        await service.gc()
        return { success: true }
      } catch (error) {
        log.error('gc failed:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          errorType: categorizeCheckpointError(error),
        }
      }
    },
  )

  /**
   * 获取 Shadow Git 仓库的磁盘占用。
   */
  guardedHandle(
    'checkpoint:diskUsage',
    async (_event, projectPath: string) => {
      const access = checkCheckpointProjectAccess(projectPath)
      if (!access.ok) return { success: false, error: access.error, sizeBytes: 0, sizeHuman: '0 B' }
      try {
        const service = getCheckpointService(projectPath)
        const usage = await service.getDiskUsage()
        return { success: true, ...usage }
      } catch (error) {
        log.error('diskUsage failed:', error)
        return {
          success: false,
          sizeBytes: 0,
          sizeHuman: '0 B',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  )

  /**
   * Destroy the shadow git repo for a project (full cleanup).
   */
  guardedHandle(
    'checkpoint:destroy',
    async (_event, projectPath: string) => {
      const access = checkCheckpointProjectAccess(projectPath)
      if (!access.ok) return { success: false, error: access.error }
      // 销毁 shadow git repo = 永久删除该项目全部快照（Rewind 能力随之消失）
      log.warn('destroy 开始（将永久删除项目快照）', { project: path.basename(access.resolvedPath) })
      try {
        await destroyCheckpointService(projectPath)
        log.info('destroy 完成', { project: path.basename(access.resolvedPath) })
        return { success: true }
      } catch (error) {
        log.error('destroy failed:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          errorType: categorizeCheckpointError(error),
        }
      }
    },
  )

  registerCheckpointStorageBucket()
}

// ─── storage-manager 注册（checkpoint:shadow-git） ─────────────
// W2.2-G2：~/.tabtin/checkpoints/<cwdHash>/.git/ 下每个项目的 shadow git
// repo——按项目（cwdHash）分组聚合。listFn 反查 git config core.worktree
// 还原 projectPath 给用户认。clearFn 单条调 destroyCheckpointService(projectPath)。
//
// data 类强警告——清掉等于失去 Rewind / restoreAndEdit 能力。
// sizeFn 必须 < 1s：500MB+ 的目录递归 stat 在 macOS HDD 上可能超时，
// 因此带 5s 缓存兜底；listFn 拿到 cwdHash 后再 lazy 查 worktree 名。
const CHECKPOINT_BUCKET_ID = 'checkpoint:shadow-git'
const CHECKPOINT_SIZE_CACHE_TTL_MS = 5_000

interface CheckpointSizeCache {
  scopeKey: string
  ts: number
  bytes: number
  itemCount: number
}
let _checkpointSizeCache: CheckpointSizeCache | null = null

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
        const stat = await fsp.stat(full)
        total += stat.size
      }
    } catch { /* ignore unreadable */ }
  }
  return total
}

async function _scanCheckpointRoot(
  root: string | null,
): Promise<{ bytes: number; itemCount: number }> {
  if (!root || !fs.existsSync(root)) return { bytes: 0, itemCount: 0 }
  let totalBytes = 0
  let count = 0
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return { bytes: 0, itemCount: 0 }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const projectDir = path.join(root, entry.name)
    if (!fs.existsSync(path.join(projectDir, '.git'))) continue
    count++
    totalBytes += await _calcDirSizeBest(projectDir)
  }
  return { bytes: totalBytes, itemCount: count }
}

async function _listCheckpointProjects(
  root: string,
  organizationId: string,
): Promise<Array<{
  organizationId: string
  checkpointsRoot: string
  cwdHash: string
  projectPath: string | null
  bytes: number
  lastModified: number | null
  reason?: 'worktree-config-missing' | 'project-path-not-exist' | 'config-read-failed'
}>> {
  if (!fs.existsSync(root)) return []
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Array<{
    organizationId: string
    checkpointsRoot: string
    cwdHash: string
    projectPath: string | null
    bytes: number
    lastModified: number | null
    reason?: 'worktree-config-missing' | 'project-path-not-exist' | 'config-read-failed'
  }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const projectDir = path.join(root, entry.name)
    const gitDir = path.join(projectDir, '.git')
    if (!fs.existsSync(gitDir)) continue
    let projectPath: string | null = null
    let reason: 'worktree-config-missing' | 'project-path-not-exist' | 'config-read-failed' | undefined
    // 直接读 .git/config 文件 parse worktree —— 不走 simpleGit() 子进程。
    // 关键原因：当 worktree 路径已不存在时（项目被 mv / rm，外接盘 unmount），
    // git 子命令在 setup_git_directory 阶段就会 fatal "Invalid path"，
    // 连只读的 `git config core.worktree` 都跑不动 —— 整个 listFn 拿不到
    // worktree 反查值，存储清理面板里所有的孤儿 shadow git 都会显示成
    // "config-read-failed" 而不是更精确的 "project-path-not-exist"。
    let configContent: string | null = null
    try {
      configContent = await fsp.readFile(path.join(gitDir, 'config'), 'utf-8')
    } catch {
      reason = 'config-read-failed'
    }
    if (configContent !== null) {
      const wt = parseShadowCoreWorktreeFromConfig(configContent)
      if (!wt) {
        reason = 'worktree-config-missing'
      } else {
        projectPath = wt
        if (!fs.existsSync(wt)) {
          // 项目目录已不存在 —— 常见于"项目被移走 / 删除 / 外接盘 unmount"
          reason = 'project-path-not-exist'
        }
      }
    }
    const bytes = await _calcDirSizeBest(projectDir).catch(() => 0)
    let lastModified: number | null = null
    try {
      lastModified = (await fsp.stat(gitDir)).mtimeMs
    } catch { /* skip */ }
    out.push({
      organizationId,
      checkpointsRoot: root,
      cwdHash: entry.name,
      projectPath,
      bytes,
      lastModified,
      ...(reason ? { reason } : {}),
    })
  }
  return out
}

export function registerCheckpointStorageBucket(): void {
  if (getBucket(CHECKPOINT_BUCKET_ID)) return

  registerStorageBucket({
    id: CHECKPOINT_BUCKET_ID,
    category: 'data',
    group: 'checkpoint',
    displayName: 'Agent 撤销快照',
    description: '每个项目的撤销快照（Rewind / Restore 能力依赖它）',
    warnings: [
      'Agent 接下来如果改坏文件，你将无法一键撤销',
      '已经撤销过的状态不受影响——只是后续无法再回到清理前的快照点',
      '建议在你的项目里先手动 git commit 一次再清',
    ],
    sizeFn: async () => {
      const now = Date.now()
      const roots = getCurrentUserCheckpointRoots()
      const scopeKey = roots.map(item => `${item.organizationId}:${item.checkpointsRoot}`).sort().join('|')
      if (roots.length === 0) return { bytes: 0, itemCount: 0 }
      if (
        _checkpointSizeCache?.scopeKey === scopeKey &&
        now - _checkpointSizeCache.ts < CHECKPOINT_SIZE_CACHE_TTL_MS
      ) {
        return {
          bytes: _checkpointSizeCache.bytes,
          itemCount: _checkpointSizeCache.itemCount,
        }
      }
      const scans = await Promise.all(
        roots.map(({ checkpointsRoot }) => _scanCheckpointRoot(checkpointsRoot)),
      )
      const bytes = scans.reduce((sum, scan) => sum + scan.bytes, 0)
      const itemCount = scans.reduce((sum, scan) => sum + scan.itemCount, 0)
      _checkpointSizeCache = { scopeKey, ts: now, bytes, itemCount }
      return { bytes, itemCount }
    },
    listFn: async () => {
      const projects = (
        await Promise.all(
          getCurrentUserCheckpointRoots().map(({ organizationId, checkpointsRoot }) =>
            _listCheckpointProjects(checkpointsRoot, organizationId),
          ),
        )
      ).flat()
      // R2 修复：reason 三档分别给文案——"已删除" 误导（外接盘 unmount
      // / 网络盘掉线时也走 project-path-not-exist 但用户插回盘/连回网就回来了）。
      const reasonLabel = (r: NonNullable<typeof projects[number]['reason']>): string => {
        switch (r) {
          case 'project-path-not-exist':
            return '项目目录暂时找不到（可能被移走或在外接盘里）'
          case 'worktree-config-missing':
            return '快照配置不完整（可能是老版本遗留）'
          case 'config-read-failed':
            return '快照配置读不出来（文件可能损坏）'
        }
      }
      return projects.map(p => ({
        id: Buffer.from(JSON.stringify([p.organizationId, p.cwdHash])).toString('base64url'),
        label: p.projectPath && !p.reason
          ? `${path.basename(p.projectPath)}  (${p.projectPath})`
          : `未知项目 ${p.cwdHash.slice(0, 8)}…（${p.reason ? reasonLabel(p.reason) : '配置异常'}）`,
        bytes: p.bytes,
        metadata: {
          organizationId: p.organizationId,
          cwdHash: p.cwdHash,
          projectPath: p.projectPath,
          lastModified: p.lastModified,
          ...(p.reason ? { reason: p.reason } : {}),
        },
      }))
    },
    clearFn: async (options) => {
      const projects = (
        await Promise.all(
          getCurrentUserCheckpointRoots().map(({ organizationId, checkpointsRoot }) =>
            _listCheckpointProjects(checkpointsRoot, organizationId),
          ),
        )
      ).flat()
      const targetIds = options?.itemIds && options.itemIds.length > 0
        ? new Set(options.itemIds)
        : null
      const targets = targetIds
        ? projects.filter(p => targetIds.has(
          Buffer.from(JSON.stringify([p.organizationId, p.cwdHash])).toString('base64url'),
        ))
        : projects
      const freedBytes = targets.reduce((sum, p) => sum + p.bytes, 0)
      if (options?.dryRun) {
        return { clearedItemCount: targets.length, freedBytes }
      }
      // 批量清理快照仓库 = 不可逆删除，记录发起范围（数量），逐条失败在结束时汇总
      log.warn('storage-bucket clearFn 开始清理 checkpoint 快照', {
        targetCount: targets.length,
        scope: targetIds ? 'selected' : 'all',
      })
      const errors: string[] = []
      let cleared = 0
      for (const p of targets) {
        if (p.projectPath) {
          // 走标准 destroyCheckpointService —— 清缓存 + cache manager 同步摘除
          try {
            await destroyCheckpointServiceAtRoot(p.projectPath, p.checkpointsRoot)
            cleared++
            continue
          } catch (err) {
            errors.push(
              `destroy(${p.projectPath}) 失败：${err instanceof Error ? err.message : String(err)}`,
            )
            // 落地兜底：直接 rm 该 shadow 目录
          }
        }
        // worktree 配置缺失或 destroyCheckpointService 失败 → fs.rm 兜底
        const projectDir = path.join(p.checkpointsRoot, p.cwdHash)
        try {
          await fsp.rm(projectDir, { recursive: true, force: true })
          cleared++
        } catch (err) {
          errors.push(
            `rm(${p.cwdHash}) 失败：${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      _checkpointSizeCache = null
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
