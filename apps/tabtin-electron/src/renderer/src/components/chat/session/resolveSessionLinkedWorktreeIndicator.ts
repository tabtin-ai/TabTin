/**
 * 会话栏 linked worktree 展示模型。
 *
 * 只根据「active 会话代码根绑定 + git worktree list」判定是否显示标识：
 * - 无 active binding / 主工作树 / 路径不在列表中 → null
 * - 绑定路径是 list 非第一项 → `{ kind: 'linked', branch, path }`
 *
 * `git worktree list` 恒定把主工作树排在第一位（与 WorktreeSection / TabCodePaneHost 同口径）。
 */

import { normalizePathForCompare } from '@/components/tabcode/utils/worktreePaths'

export interface SessionLinkedWorktreeIndicator {
  kind: 'linked'
  branch: string | null
  path: string
}

export interface ResolveSessionLinkedWorktreeIndicatorInput {
  binding: {
    rootPath: string
    status: string
    branch?: string | null
  } | null
  worktrees: ReadonlyArray<{ path: string; branch: string | null }> | null | undefined
}

export function resolveSessionLinkedWorktreeIndicator(
  input: ResolveSessionLinkedWorktreeIndicatorInput,
): SessionLinkedWorktreeIndicator | null {
  const { binding, worktrees } = input
  if (!binding || binding.status !== 'active') return null
  const rootPath = binding.rootPath.trim()
  if (!rootPath || !worktrees?.length) return null

  const mainPath = worktrees[0]?.path
  if (!mainPath) return null

  const normalizedRoot = normalizePathForCompare(rootPath)
  const normalizedMain = normalizePathForCompare(mainPath)
  if (!normalizedRoot || normalizedRoot === normalizedMain) return null

  const match = worktrees.find(
    (item) => normalizePathForCompare(item.path) === normalizedRoot,
  )
  if (!match) return null

  return {
    kind: 'linked',
    branch: binding.branch ?? match.branch ?? null,
    path: rootPath,
  }
}
