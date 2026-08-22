/**
 * 按仓库共享 `git.listWorktrees` 结果，避免会话虚拟列表每行重复 IPC。
 *
 * 缓存键：主工作树路径（list 第一项）；查询任意 worktree 路径时，先扫已有列表是否包含该路径。
 */

import { normalizePathForCompare } from '@/components/tabcode/utils/worktreePaths'
import type { GitWorktreeInfo } from '@shared/git-types'
import { createLogger } from '@/utils/logger'

const log = createLogger('SessionLinkedWorktreeCache')

const cacheByMainPath = new Map<string, GitWorktreeInfo[]>()
const inflightByQueryPath = new Map<string, Promise<GitWorktreeInfo[] | null>>()

function findCachedWorktrees(rootPath: string): GitWorktreeInfo[] | null {
  const normalized = normalizePathForCompare(rootPath)
  if (!normalized) return null
  for (const worktrees of cacheByMainPath.values()) {
    if (worktrees.some((item) => normalizePathForCompare(item.path) === normalized)) {
      return worktrees
    }
  }
  return null
}

function rememberWorktrees(worktrees: GitWorktreeInfo[]): void {
  const mainPath = worktrees[0]?.path
  if (!mainPath) return
  cacheByMainPath.set(normalizePathForCompare(mainPath), worktrees)
}

/** 测试用：清空模块缓存。 */
export function clearSessionLinkedWorktreeCacheForTests(): void {
  cacheByMainPath.clear()
  inflightByQueryPath.clear()
}

export async function loadWorktreesForSessionRoot(
  rootPath: string,
): Promise<GitWorktreeInfo[] | null> {
  const trimmed = rootPath.trim()
  if (!trimmed) return null

  const cached = findCachedWorktrees(trimmed)
  if (cached) return cached

  const queryKey = normalizePathForCompare(trimmed)
  const pending = inflightByQueryPath.get(queryKey)
  if (pending) return pending

  const task = (async (): Promise<GitWorktreeInfo[] | null> => {
    try {
      const result = await window.tabtin?.git?.listWorktrees?.(trimmed)
      if (!result?.success || !result.worktrees?.length) return null
      const worktrees = result.worktrees as GitWorktreeInfo[]
      rememberWorktrees(worktrees)
      return worktrees
    } catch (err) {
      log.warn('listWorktrees failed for session indicator', {
        errorType: err instanceof Error ? err.name : typeof err,
      })
      return null
    } finally {
      inflightByQueryPath.delete(queryKey)
    }
  })()

  inflightByQueryPath.set(queryKey, task)
  return task
}

export function peekCachedWorktreesForSessionRoot(
  rootPath: string,
): GitWorktreeInfo[] | null {
  return findCachedWorktrees(rootPath)
}
