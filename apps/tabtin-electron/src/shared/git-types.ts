/**
 * Git 共享类型定义
 *
 * main / preload / renderer 三端共享，避免重复定义。
 */

import type { GitActionWarning, GitErrorCode } from './git-action-result'

// ─── 分支 ────────────────────────────────────────────

export interface GitBranchMeta {
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  isDetached: boolean
}

export interface GitBranchItem {
  name: string
  upstream: string | null
  isCurrent: boolean
  commitHash: string | null
}

// ─── Remote ──────────────────────────────────────────

export interface GitRemoteInfo {
  name: string
  fetchUrl: string | null
  pushUrl: string | null
}

// ─── Worktree ────────────────────────────────────────

export interface GitWorktreeInfo {
  path: string
  branch: string | null
  commitHash: string | null
  isCurrent: boolean
  /** 主工作树与调用 Git IPC 的 cwd 无关。 */
  isMainWorktree?: boolean
  isDetached: boolean
  isBare: boolean
  isLocked: boolean
  lockReason?: string
}

export type WorktreeRemoveBlockReason =
  | 'invalid_cwd'
  | 'path_required'
  | 'worktree_not_found'
  | 'main_worktree'
  | 'current_worktree'
  | 'worktree_locked'
  | 'worktree_dirty'
  | 'session_bound'
  | 'session_busy'
  | 'runtime_unavailable'
  | 'bindings_unknown'
  | 'path_access_denied'
  | 'working_tree_unknown'

export interface WorktreeSessionBindingRef {
  sessionId: string
  branch?: string
  title?: string
  busy: boolean
  revision: number
}

export interface WorktreeRemovePreflightResult {
  success: boolean
  canRemove?: boolean
  canForce?: boolean
  reason?: WorktreeRemoveBlockReason
  error?: string
  code?: GitErrorCode
  detail?: string
  targetPath?: string
  branch?: string | null
  isMainWorktree?: boolean
  isCurrentWorktree?: boolean
  isLocked?: boolean
  lockReason?: string
  dirty?: boolean
  bindings?: WorktreeSessionBindingRef[]
  assessmentToken?: string
}

export interface WorktreeRemoveResult {
  success: boolean
  error?: string
  code?: GitErrorCode
  detail?: string
  clearedSessionIds?: string[]
  warnings?: GitActionWarning[]
  assessmentToken?: string
}

// ─── Diff ────────────────────────────────────────────

export interface GitDiffFileSummary {
  path: string
  status: string
  added: number
  deleted: number
}

export interface GitDiffSummary {
  range: string
  filesChanged: number
  insertions: number
  deletions: number
  files: GitDiffFileSummary[]
}

export interface GitDiffStatGroup {
  added: number
  deleted: number
  changed: number
}

export interface GitDiffStatResult {
  total: GitDiffStatGroup
  unstaged: GitDiffStatGroup
  staged: GitDiffStatGroup
}

// ─── File Status ─────────────────────────────────────

export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | null

// ─── Status ──────────────────────────────────────────

export interface GitStatusEntry {
  x: string
  y: string
  status: string
}

export interface GitStatusResult {
  files: Record<string, string>
  entries: Record<string, GitStatusEntry>
}

// ─── Merge ───────────────────────────────────────────

export interface GitWorktreeMergeResult {
  success: boolean
  hasConflicts?: boolean
  conflictingFiles?: string[]
  sourceBranch?: string
  targetBranch?: string
  beforeHash?: string
  afterHash?: string
  diffSummary?: GitDiffSummary | null
  warnings?: string[]
  error?: string
}

// ─── Stash ───────────────────────────────────────────

export interface GitStashEntry {
  index: number
  message: string
  branch?: string
}

// ─── Full Status (聚合 IPC) ──────────────────────────

export interface GitFullStatusResult {
  success: boolean
  isRepo: boolean
  branch: string
  branchMeta: GitBranchMeta
  status: GitStatusResult
  diffStat: GitDiffStatResult
}

// ─── Commit history（真实 git log，非 checkpoint） ────

export type GitCommitRefKind = 'head' | 'branch' | 'remote' | 'tag'

export interface GitCommitRef {
  kind: GitCommitRefKind
  name: string
}

export interface GitCommitListItem {
  hash: string
  shortHash: string
  subject: string
  authorName: string
  authoredAt: string
  /** 仅 graph 模式：父母提交 hash，用于画分叉/合并 */
  parents?: string[]
  /** 仅 graph 模式：HEAD / 分支 / 远程 / 标签 */
  refs?: GitCommitRef[]
}

export interface GitCommitListResult {
  success: boolean
  commits: GitCommitListItem[]
  error?: string
  reason?: 'invalid_cwd' | 'path_not_found' | 'permission_denied' | 'git_error'
  /** 仅 graph 模式：当前 HEAD hash */
  headHash?: string
}

export interface GitLogOptions {
  limit?: number
  /** true 时拉 --all 拓扑 + parents/refs，默认命令保持不变 */
  graph?: boolean
}

export interface GitCommitDetailResult {
  success: boolean
  commit?: GitCommitListItem
  files?: GitDiffFileSummary[]
  insertions?: number
  deletions?: number
  error?: string
}

// ─── 内部类型（仅 main 使用） ────────────────────────

export interface ParsedRemoteUrl {
  provider: 'github' | 'gitlab' | 'unknown'
  webRepoUrl: string | null
}

export interface PullRequestContext {
  provider: 'github' | 'gitlab'
  remoteName: string
  baseBranch: string
  headBranch: string
  webRepoUrl: string
}
