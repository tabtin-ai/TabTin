/**
 * Changes 连续审阅纯逻辑：未提交文件列表、统计与导航锚点。
 */

import type { ChangeFile } from '@components/tabcode/components/git-workflow/useGitWorkflowData'
import type { GitDiffFileSummary } from '@shared/git-types'
import type { CodeChangesViewId } from './codeWorkspaceTab'
import type { EditorTurnFinalFile } from './agentTurnEditorOps'

export function joinRootPath(rootPath: string, filePath: string): string {
  const separator = rootPath.includes('\\') ? '\\' : '/'
  return `${rootPath.replace(/[\\/]+$/, '')}${separator}${filePath.replace(/^[\\/]+/, '')}`
}

/** 实时主视图始终是全部未提交；staged/unstaged 入口收敛到 uncommitted。 */
export function normalizeLiveView(view: CodeChangesViewId): CodeChangesViewId {
  if (view === 'staged' || view === 'unstaged') return 'uncommitted'
  return view
}

export function filterFilesForChangesView(
  files: ChangeFile[],
  view: CodeChangesViewId,
): ChangeFile[] {
  const live = normalizeLiveView(view)
  if (live === 'uncommitted') return files
  return []
}

export interface UncommittedDiffTotals {
  fileCount: number
  added: number
  deleted: number
}

export function aggregateUncommittedTotals(files: ChangeFile[]): UncommittedDiffTotals {
  let added = 0
  let deleted = 0
  for (const file of files) {
    added += file.added
    deleted += file.deleted
  }
  return { fileCount: files.length, added, deleted }
}

export function resolveNavigationAnchor(
  files: ChangeFile[],
  prevRelativePath: string | null,
): string | null {
  if (files.length === 0) return null
  if (prevRelativePath && files.some((file) => file.path === prevRelativePath)) {
    return prevRelativePath
  }
  return files[0]?.path ?? null
}

/**
 * 提交详情文件清单 → 连续审阅 / 文件树用的 ChangeFile（只读假值）。
 */
export function mapCommitFilesToChangeFiles(
  files: GitDiffFileSummary[] | undefined | null,
): ChangeFile[] {
  if (!files?.length) return []
  return files.map((file) => {
    const status = (file.status || 'M').charAt(0).toUpperCase()
    return {
      path: file.path,
      status,
      staged: false,
      unstaged: false,
      partiallyStaged: false,
      added: file.added ?? 0,
      deleted: file.deleted ?? 0,
      untracked: false,
      conflict: status === 'U',
    }
  })
}

/** 提交审阅：为每个路径提供稳定 contentRevision（与 commitHash 绑定） */
export function buildCommitContentRevisions(
  files: ChangeFile[],
  commitHash: string,
): Record<string, number> {
  // 用短 hash 的稳定数值作 revision，切换提交时整表失效
  let seed = 0
  for (let i = 0; i < commitHash.length; i += 1) {
    seed = (seed * 31 + commitHash.charCodeAt(i)) >>> 0
  }
  const revision = seed || 1
  const map: Record<string, number> = {}
  for (const file of files) {
    map[file.path] = revision
  }
  return map
}

export function mapEditorTurnFinalsToChangeFiles(
  files: EditorTurnFinalFile[],
): ChangeFile[] {
  return files.map((file) => {
    const status = file.status === 'added'
      ? 'A'
      : file.status === 'deleted'
        ? 'D'
        : 'M'
    return {
      path: file.relativePath,
      status,
      staged: false,
      unstaged: false,
      partiallyStaged: false,
      added: file.insertions,
      deleted: file.deletions,
      untracked: file.status === 'added',
      conflict: false,
    }
  })
}

export function collectAgentFrozenDiffs(files: EditorTurnFinalFile[]): {
  frozenTextsByPath: Record<string, { leftText: string; rightText: string }>
  unreadablePaths: Set<string>
  contentRevisions: Record<string, number>
} {
  const frozenTextsByPath: Record<string, { leftText: string; rightText: string }> = {}
  const unreadablePaths = new Set<string>()
  const contentRevisions: Record<string, number> = {}
  for (const file of files) {
    contentRevisions[file.relativePath] = 1
    if (!file.displayable) {
      unreadablePaths.add(file.relativePath)
      continue
    }
    frozenTextsByPath[file.relativePath] = {
      leftText: file.before ?? '',
      rightText: file.after ?? '',
    }
  }
  return { frozenTextsByPath, unreadablePaths, contentRevisions }
}
