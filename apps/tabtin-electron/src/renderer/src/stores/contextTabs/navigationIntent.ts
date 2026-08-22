import type { ContextActiveKey } from './types'

/**
 * 导航 activeKey 写入者分类（全应用导航正典）。
 *
 * - user: 显式用户意图，可创建新 revision
 * - async_completion: 异步完成（如 browser selection），仅能提交仍为当前的意图
 * - restore / source_sync: 只能修复结构，不能覆盖仍有效的用户目标
 * - fallback: 仅在 active 明确关闭/删除/不可见/不可恢复时执行
 * - self_heal: 三元组自愈；不得因瞬时 items 未到而抹掉用户目标
 */
export type NavigationWriter =
  | 'user'
  | 'async_completion'
  | 'restore'
  | 'source_sync'
  | 'fallback'
  | 'self_heal'

export type NavigationIntent = {
  revision: number
  targetKey: ContextActiveKey
  writer: NavigationWriter
  reason: string
  at: number
}

export type SetActiveKeyOptions = {
  writer?: NavigationWriter
  reason?: string
  /** async_completion：异步启动时捕获的 revision */
  expectedRevision?: number
}

export type ActiveKeyCommitDecision = {
  allow: boolean
  reason: string
  bumpRevision: boolean
}

/**
 * 判定是否允许把 activeKey 从 current → next。
 * 纯函数，供 store / restore / tabSync / browser activation 共用。
 */
export function decideActiveKeyCommit(args: {
  writer: NavigationWriter
  currentActive: ContextActiveKey
  nextActive: ContextActiveKey
  intent: NavigationIntent | undefined
  expectedRevision?: number
  /** 当前 active 在 tabOrder∩items（或 canvas 组）中仍可用 */
  currentActiveStructurallyValid: boolean
}): ActiveKeyCommitDecision {
  const {
    writer,
    currentActive,
    nextActive,
    intent,
    expectedRevision,
    currentActiveStructurallyValid,
  } = args

  if (currentActive === nextActive) {
    return { allow: true, reason: 'noop-same-active', bumpRevision: false }
  }

  switch (writer) {
    case 'user':
      return { allow: true, reason: 'user-intent', bumpRevision: true }

    case 'async_completion': {
      // 仅用 revision 判定过期。从表格点开 URL 时启动瞬间前景仍是非 tabweb，
      // 那是合法首次提交；「中途又点了别的 tab」会 bump revision，由此拒绝。
      // activeKey 快照门禁仍由 shouldCommitBrowserSelection 负责。
      if (expectedRevision !== undefined && intent && expectedRevision !== intent.revision) {
        return {
          allow: false,
          reason: 'async-stale-revision',
          bumpRevision: false,
        }
      }
      return { allow: true, reason: 'async-still-current', bumpRevision: false }
    }

    case 'restore':
    case 'source_sync': {
      if (!currentActiveStructurallyValid) {
        return {
          allow: true,
          reason: `${writer}-repair-invalid-active`,
          bumpRevision: false,
        }
      }
      // 浏览器前景内跟随 activeView：tabweb→tabweb 不视作「覆盖用户目标」
      if (
        typeof currentActive === 'string'
        && currentActive.startsWith('tabweb:')
        && typeof nextActive === 'string'
        && nextActive.startsWith('tabweb:')
      ) {
        return {
          allow: true,
          reason: `${writer}-browser-view-follow`,
          bumpRevision: false,
        }
      }
      if (
        intent
        && intent.writer === 'user'
        && intent.targetKey === currentActive
        && currentActiveStructurallyValid
      ) {
        return {
          allow: false,
          reason: `${writer}-blocked-by-user-intent`,
          bumpRevision: false,
        }
      }
      // 无用户意图保护时允许结构 reconcile 改 active（冷启动 / 权威失效）
      return { allow: true, reason: `${writer}-structure-reconcile`, bumpRevision: false }
    }

    case 'fallback': {
      if (!currentActiveStructurallyValid) {
        return { allow: true, reason: 'fallback-invalid-active', bumpRevision: false }
      }
      return {
        allow: false,
        reason: 'fallback-blocked-valid-active',
        bumpRevision: false,
      }
    }

    case 'self_heal': {
      if (!currentActiveStructurallyValid) {
        return { allow: true, reason: 'self-heal-invalid-active', bumpRevision: false }
      }
      return {
        allow: false,
        reason: 'self-heal-keep-user-target',
        bumpRevision: false,
      }
    }

    default:
      return { allow: false, reason: 'unknown-writer', bumpRevision: false }
  }
}

export function nextNavigationIntent(
  prev: NavigationIntent | undefined,
  args: {
    writer: NavigationWriter
    targetKey: ContextActiveKey
    reason: string
    bumpRevision: boolean
    nowMs?: number
  },
): NavigationIntent {
  const revision = args.bumpRevision
    ? (prev?.revision ?? 0) + 1
    : (prev?.revision ?? 0)
  return {
    revision: Math.max(1, revision),
    targetKey: args.targetKey,
    writer: args.writer,
    reason: args.reason,
    at: args.nowMs ?? Date.now(),
  }
}
