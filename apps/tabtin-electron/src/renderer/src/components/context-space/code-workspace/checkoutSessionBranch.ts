/**
 * 会话绑定 worktree 上的分支切换：脏树需显式确认暂存后再切，不静默 stash。
 * 仅未跟踪新文件时先尝试直接切换；若目标分支会覆盖这些文件，再要求确认 stash。
 */

import {
  asLocalizedGitError,
  formatGitErrorForToast,
} from '@components/tabcode/components/git-workflow/gitErrorMessage'
import type { TFunction } from 'i18next'

export type CheckoutSessionBranchPhase =
  | 'stash'
  | 'checkout'
  | 'checkout-after-stash'

export interface CheckoutSessionBranchResult {
  success: boolean
  error?: string
  needsStashConfirm?: boolean
  /** 失败发生在哪一阶段；成功时为空 */
  phase?: CheckoutSessionBranchPhase
  /** stash 已成功写入，但后续 checkout 失败 */
  stashed?: boolean
}

function localizeCheckoutError(
  error: unknown,
  t: TFunction,
  opts: { afterStash: boolean },
): string {
  const reason = formatGitErrorForToast(error, t as never)
  if (!opts.afterStash) return asLocalizedGitError(reason)
  return asLocalizedGitError(
    t('gitFlow.gitErrors.checkoutAfterStashFailed', {
      reason,
      defaultValue: '变更已暂存到 stash，但分支未能切换：{{reason}}',
    }),
  )
}

function isOverwriteOrDirtyCheckoutError(error: unknown): boolean {
  const raw = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : error && typeof error === 'object' && 'error' in error && typeof (error as { error: unknown }).error === 'string'
        ? (error as { error: string }).error
        : ''
  const lower = raw.toLowerCase()
  return [
    'local changes would be overwritten',
    'would be overwritten by checkout',
    'working tree has uncommitted changes',
    'please commit your changes or stash them',
    'please commit or stash',
  ].some((needle) => lower.includes(needle))
}

export function isUntrackedOnlyDirty(input: {
  stagedCount: number
  unstagedCount: number
  dirtyFileCount?: number
  untrackedCount?: number
}): boolean {
  const dirty =
    typeof input.dirtyFileCount === 'number'
      ? input.dirtyFileCount
      : input.stagedCount + input.unstagedCount
  const untracked = Math.max(0, input.untrackedCount ?? 0)
  if (dirty <= 0 || untracked <= 0) return false
  if (input.stagedCount > 0) return false
  // 未跟踪计入 unstaged；有已跟踪未暂存改动时 unstaged > untracked
  if (input.unstagedCount > untracked) return false
  // 冲突等只出现在 dirty、不进 staged/unstaged 时也不算「仅未跟踪」
  if (dirty > input.unstagedCount) return false
  return untracked === dirty
}

export async function checkoutSessionBranch(input: {
  rootPath: string
  branch: string
  stagedCount: number
  unstagedCount: number
  /**
   * 含冲突在内的工作树改动总数（对齐 useGitStatus.gitStatus.size）。
   * 冲突不进 staged/unstaged 计数，缺省时仅看 staged+unstaged 会漏拦。
   */
  dirtyFileCount?: number
  /** 未跟踪文件数（status `?`），用于「仅新文件时先直切」 */
  untrackedCount?: number
  /** 已确认暂存并切换时传 true */
  confirmedStash?: boolean
  t: TFunction
}): Promise<CheckoutSessionBranchResult> {
  const branch = input.branch.trim()
  if (!branch) {
    return {
      success: false,
      error: asLocalizedGitError(formatGitErrorForToast('branch is required', input.t as never)),
      phase: 'checkout',
    }
  }

  const dirty =
    (typeof input.dirtyFileCount === 'number'
      ? input.dirtyFileCount
      : input.stagedCount + input.unstagedCount) > 0
  const untrackedOnly = isUntrackedOnlyDirty(input)

  // 有已跟踪改动 / 冲突：先确认再 stash。仅未跟踪则先尝试直切。
  if (dirty && !input.confirmedStash && !untrackedOnly) {
    return { success: false, needsStashConfirm: true }
  }

  let stashed = false
  try {
    if (dirty && input.confirmedStash) {
      const stashResult = await window.tabtin.git.stash(input.rootPath, 'save', {
        message: input.t('gitFlow.stashMessage', { branch }),
        includeUntracked: true,
      })
      if (!stashResult?.success) {
        return {
          success: false,
          phase: 'stash',
          error: asLocalizedGitError(formatGitErrorForToast(stashResult?.error, input.t as never)),
        }
      }
      stashed = true
    }

    // 已确认暂存，或仅未跟踪直切：跳过 main 二次脏树策略，交给 Git CLI。
    const allowDirty = stashed || (untrackedOnly && !input.confirmedStash)
    const result = await window.tabtin.git.checkoutBranch(input.rootPath, {
      branch,
      ...(allowDirty ? { allowDirty: true } : {}),
    })
    if (!result?.success) {
      // 仅未跟踪直切被覆盖拦截 → 再弹 stash 确认，而不是直接报错结束。
      if (
        untrackedOnly
        && !input.confirmedStash
        && !stashed
        && isOverwriteOrDirtyCheckoutError(result?.error)
      ) {
        return { success: false, needsStashConfirm: true }
      }
      return {
        success: false,
        phase: stashed ? 'checkout-after-stash' : 'checkout',
        stashed,
        error: localizeCheckoutError(result?.error, input.t, { afterStash: stashed }),
      }
    }
    return { success: true }
  } catch (error) {
    if (
      untrackedOnly
      && !input.confirmedStash
      && !stashed
      && isOverwriteOrDirtyCheckoutError(error)
    ) {
      return { success: false, needsStashConfirm: true }
    }
    return {
      success: false,
      phase: stashed ? 'checkout-after-stash' : dirty && input.confirmedStash ? 'stash' : 'checkout',
      stashed,
      error: localizeCheckoutError(error, input.t, { afterStash: stashed }),
    }
  }
}
