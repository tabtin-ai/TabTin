/**
 * Git 状态 Hook
 *
 * 通过按 rootPath 共享的调度层拉取 fullStatus：多组件共用一个 watcher、
 * 一套轮询与一次 in-flight 刷新（含 trailing coalesce）。
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { GitStatusMap } from '../components/TabCodeFileTree'
import type { GitBranchMeta } from '@shared/git-types'
import {
  getLocalGitStatusSnapshot,
  refreshLocalGitStatus,
  subscribeLocalGitStatus,
  type DiffStat,
} from './localGitStatusShared'

interface UseGitStatusOptions {
  /**
   * 外层已确认目录是 Git 仓库时传入 true，让首帧按仓库渲染（侧栏 Git 标签等），
   * 避免 fullStatus 返回前先画成「非仓库」再跳变。最终仍以 fullStatus 为准。
   */
  assumeRepo?: boolean
}

interface UseGitStatusResult {
  gitStatus: GitStatusMap
  stagedStatus: GitStatusMap
  unstagedStatus: GitStatusMap
  branch: string | null
  branchMeta: GitBranchMeta
  diffStat: DiffStat | null
  isGitRepo: boolean
  isLoading: boolean
  /**
   * 每次成功拉完 fullStatus（含空变更）后递增。
   * GitWorkflowPanel 等自管数据的 UI 用它跟目录侧状态对齐，避免只 refresh
   * 树徽章而 Changes 列表仍停在上一次 loadData。
   */
  statusRevision: number
  /** 相对路径 → 内容版本；单文件变更不会抬高无关路径 */
  contentRevisions: Record<string, number>
  refresh: () => void
}

export function useGitStatus(
  rootPath: string | null,
  options: UseGitStatusOptions = {},
): UseGitStatusResult {
  const assumeRepo = Boolean(options.assumeRepo)

  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeLocalGitStatus(rootPath, onStoreChange, { assumeRepo }),
    [rootPath, assumeRepo],
  )

  const getSnapshot = useCallback(
    () => getLocalGitStatusSnapshot(rootPath, { assumeRepo }),
    [rootPath, assumeRepo],
  )

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const refresh = useCallback(() => {
    refreshLocalGitStatus(rootPath)
  }, [rootPath])

  return {
    gitStatus: snapshot.gitStatus,
    stagedStatus: snapshot.stagedStatus,
    unstagedStatus: snapshot.unstagedStatus,
    branch: snapshot.branch,
    branchMeta: snapshot.branchMeta,
    diffStat: snapshot.diffStat,
    isGitRepo: snapshot.isGitRepo,
    isLoading: snapshot.isLoading,
    statusRevision: snapshot.statusRevision,
    contentRevisions: snapshot.contentRevisions,
    refresh,
  }
}
