/**
 * resource_ref 卡片打开结果是否需要给用户可见反馈。
 *
 * ：type 别名未归一化时会静默落到 system_app_opened，画布不展开、无 toast，
 * 用户感知「点了毫无反应」。⌘/Ctrl 点击故意走系统应用时不提示。
 */

import type { OpenOutcome } from '@tabtin/resource-router'

export function shouldToastRichResourceOpenFailure(
  outcome: OpenOutcome | null | undefined,
  opts?: { modifierExternal?: boolean },
): boolean {
  if (opts?.modifierExternal) return false
  if (!outcome) return false
  if (outcome.outcome === 'error' || outcome.outcome === 'denied_known_bad') return true
  if (outcome.outcome === 'system_app_opened') return true
  return false
}
