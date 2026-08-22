/**
 * CheckpointSummaryExport — D-5 §4 "Checkpoint 摘要"导出 bucket。
 *
 * ## 设计决策
 *
 * G2 已经在 `checkpoint-ipc.ts` 注册了 `checkpoint:shadow-git`（含 sizeFn /
 * listFn / clearFn），但**没有 exportFn**。本任务是 W3.3，边界约束"不动
 * 51 个 bucket 的注册文件"，因此采用**独立 bucket** 方案：
 *
 *   - 新建 `checkpoint:summary-export`（`hideFromList: true`）
 *   - 仅暴露 sizeFn（与 G2 的 sizeFn 同口径）+ exportFn
 *   - UI 渲染 checkpoint:shadow-git 卡片时额外加"导出摘要"按钮，
 *     按钮调本 bucket 的 exportFn
 *
 * ## 导出内容
 *
 * **不含 git pack 文件**（D-5 §4 严格要求）。只导：
 *   - 每个项目（cwdHash）的 projectPath / 总容量 / 提交数
 *   - 最近 N 个提交点的 hash / 时间 / message
 *
 * 用户能据此知道：
 *   - 自己有哪些项目在用 Checkpoint
 *   - 最近做过哪些 Checkpoint（即使 shadow git 数据被清，导出文件还能
 *     当作 audit trail 给排查问题）
 *
 * ## 性能
 *
 * 用户可能有 50+ 个项目。`git log` 调用并行化（限制并发 4），单项目限
 * 100 条最近提交点（D-5 §4 约束）。整体 < 5s 可接受。
 */

import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import simpleGit from 'simple-git'
import { getBucket, registerStorageBucket } from '@tabtin/storage-manager'
import { createLogger } from '../logger'
import { getCurrentUserCheckpointRoots } from '../checkpoint/CheckpointService'

const log = createLogger('CheckpointSummaryExport')

const SUMMARY_BUCKET_ID = 'checkpoint:summary-export'
const RECENT_COMMITS_LIMIT = 100
const SCAN_CONCURRENCY = 4

interface ProjectCommitInfo {
  hash: string
  /** ISO 时间字符串 */
  time: string
  message: string
}

interface ProjectSummary {
  organizationId: string
  cwdHash: string
  projectPath: string | null
  /** Shadow git 仓库占用字节数 */
  bytes: number
  /** 总提交数（含初始 commit） */
  commitsCount: number
  lastCommitTime: string | null
  recentCommits: ProjectCommitInfo[]
  /** 反查 worktree 失败时的原因 */
  unavailableReason?: 'worktree-config-missing' | 'project-path-not-exist' | 'config-read-failed'
  errorMessage?: string
}

async function _calcDirSize(dir: string): Promise<number> {
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
        total += await _calcDirSize(full)
      } else if (entry.isFile()) {
        total += (await fsp.stat(full)).size
      }
    } catch { /* ignore unreadable */ }
  }
  return total
}

async function _summarizeProject(
  projectDir: string,
  cwdHash: string,
  organizationId: string,
): Promise<ProjectSummary> {
  const summary: ProjectSummary = {
    organizationId,
    cwdHash,
    projectPath: null,
    bytes: 0,
    commitsCount: 0,
    lastCommitTime: null,
    recentCommits: [],
  }

  // 反查 worktree
  try {
    const git = simpleGit(projectDir, { timeout: { block: 5_000 } })
    const cfg = await git.getConfig('core.worktree')
    summary.projectPath = cfg.value || null
    if (!summary.projectPath) {
      summary.unavailableReason = 'worktree-config-missing'
    } else if (!fs.existsSync(summary.projectPath)) {
      summary.unavailableReason = 'project-path-not-exist'
    }
  } catch (err) {
    summary.unavailableReason = 'config-read-failed'
    summary.errorMessage = err instanceof Error ? err.message : String(err)
  }

  summary.bytes = await _calcDirSize(projectDir).catch(() => 0)

  // 拉提交点：即使 worktree 反查失败仍尝试 log（日志在 shadow git 内是独立的）
  try {
    const git = simpleGit(projectDir, { timeout: { block: 5_000 } })
    const logResult = await git.log({
      maxCount: RECENT_COMMITS_LIMIT,
      format: { hash: '%H', time: '%aI', message: '%s' },
    })
    summary.commitsCount = logResult.total ?? logResult.all.length
    summary.recentCommits = logResult.all.map((c) => ({
      hash: String(c.hash ?? ''),
      time: String(c.time ?? ''),
      message: String(c.message ?? ''),
    }))
    if (summary.recentCommits.length > 0) {
      summary.lastCommitTime = summary.recentCommits[0]!.time || null
    }
  } catch (err) {
    if (!summary.errorMessage) {
      summary.errorMessage = err instanceof Error ? err.message : String(err)
    }
  }

  return summary
}

async function _enumerateProjectDirs(): Promise<Array<{
  organizationId: string
  cwdHash: string
  projectDir: string
}>> {
  const out: Array<{ organizationId: string; cwdHash: string; projectDir: string }> = []
  for (const { organizationId, checkpointsRoot } of getCurrentUserCheckpointRoots()) {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(checkpointsRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const projectDir = path.join(checkpointsRoot, entry.name)
      if (!fs.existsSync(path.join(projectDir, '.git'))) continue
      out.push({ organizationId, cwdHash: entry.name, projectDir })
    }
  }
  return out
}

async function _summarizeAllProjects(): Promise<ProjectSummary[]> {
  const projects = await _enumerateProjectDirs()
  const summaries: ProjectSummary[] = []
  // 限并发：避免同时 spawn 50+ 个 git 进程
  for (let i = 0; i < projects.length; i += SCAN_CONCURRENCY) {
    const slice = projects.slice(i, i + SCAN_CONCURRENCY)
    const batch = await Promise.all(
      slice.map((p) => _summarizeProject(p.projectDir, p.cwdHash, p.organizationId)),
    )
    summaries.push(...batch)
  }
  return summaries
}

/**
 * 注册 checkpoint:summary-export bucket。幂等：重复调用安全。
 *
 * 在 startup-services.ts 启动期被调用。
 */
export function registerCheckpointSummaryExportBucket(): void {
  if (getBucket(SUMMARY_BUCKET_ID)) return

  registerStorageBucket({
    id: SUMMARY_BUCKET_ID,
    category: 'data',
    group: 'checkpoint',
    displayName: 'Agent 撤销快照 · 摘要导出',
    description: '导出每个项目的 Checkpoint 元信息（项目路径 / 容量 / 提交点列表，不含 git pack 数据）',
    warnings: [
      '本桶仅做导出——清理请到 "Agent 撤销快照" 卡片操作',
      '导出文件不包含 git pack / objects 数据，仅含项目列表与 commit 元信息',
    ],
    requiresConfirmation: 'hard',
    hideFromList: true,
    sizeFn: async () => {
      // R3 P1：sizeFn 只需 bytes/itemCount，**不跑 git log**（避免 50 项目
      // × 2 spawn = 100 次 git 子进程开销）。仅枚举目录 + 算 .git 容量。
      try {
        const projects = await _enumerateProjectDirs()
        let totalBytes = 0
        for (let i = 0; i < projects.length; i += SCAN_CONCURRENCY) {
          const slice = projects.slice(i, i + SCAN_CONCURRENCY)
          const sizes = await Promise.all(
            slice.map((p) => _calcDirSize(p.projectDir).catch(() => 0)),
          )
          totalBytes += sizes.reduce((s, v) => s + v, 0)
        }
        return { bytes: totalBytes, itemCount: projects.length }
      } catch (err) {
        log.error('sizeFn failed:', err)
        return { bytes: 0, itemCount: 0 }
      }
    },
    exportFn: async () => {
      const exportedAt = new Date().toISOString()
      const summaries = await _summarizeAllProjects()

      const totalBytes = summaries.reduce((sum, s) => sum + s.bytes, 0)
      const totalCommits = summaries.reduce((sum, s) => sum + s.commitsCount, 0)

      const payload = {
        schemaVersion: 1,
        exportedAt,
        source: 'tabtin-electron',
        bucketId: SUMMARY_BUCKET_ID,
        scope: 'current-user-all-organizations',
        checkpointRoots: getCurrentUserCheckpointRoots(),
        recentCommitsLimitPerProject: RECENT_COMMITS_LIMIT,
        totalProjects: summaries.length,
        totalCommits,
        totalBytes,
        notes: [
          'recentCommits 按时间倒序，每个项目最多 100 条',
          '本导出不含 git pack / objects 二进制数据，仅含元信息',
          'unavailableReason 表示反查 worktree 失败的原因（如项目目录已被移走）',
        ],
        projects: summaries.map((s) => ({
          organizationId: s.organizationId,
          cwdHash: s.cwdHash,
          projectPath: s.projectPath,
          bytes: s.bytes,
          commitsCount: s.commitsCount,
          lastCommitTime: s.lastCommitTime,
          recentCommits: s.recentCommits,
          ...(s.unavailableReason ? { unavailableReason: s.unavailableReason } : {}),
          ...(s.errorMessage ? { errorMessage: s.errorMessage } : {}),
        })),
      }

      const ts = exportedAt.replace(/[:.]/g, '-')
      return {
        filename: `tabtin-checkpoint-summary-${ts}.json`,
        data: JSON.stringify(payload, null, 2),
        mimeType: 'application/json',
      }
    },
  })
}
