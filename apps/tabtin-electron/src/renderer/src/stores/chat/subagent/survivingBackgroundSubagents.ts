/**
 * ：主 Composer Stop 后仍存活的后台子 Agent 判定。
 *
 * 产品语义：
 * - 前台子：挂在父 abortSignal 上，主 Stop 级联取消（runtime 已有）
 * - 后台子：故意不挂父 abort，主 Stop 后仍跑；靠 PendingTasksNotice 可感知
 */

import type { SubagentRun, SubagentStatus } from '../shared/types'

const ACTIVE: ReadonlySet<SubagentStatus> = new Set([
  'pending',
  'queued',
  'running',
])

export function isSurvivingBackgroundSubagent(run: SubagentRun): boolean {
  return run.background === true && ACTIVE.has(run.status)
}

export function listSurvivingBackgroundSubagents(
  runs: readonly SubagentRun[],
): SubagentRun[] {
  return runs.filter(isSurvivingBackgroundSubagent)
}

export function countSurvivingBackgroundSubagents(
  runs: readonly SubagentRun[],
): number {
  return listSurvivingBackgroundSubagents(runs).length
}

/**
 * ：Composer Stop（`stop_only` / `withdraw_and_restore`）共用门闩——
 * 与 mode 无关，存活后台子数 > 0 才切换 PendingTasksNotice 文案。
 */
export function shouldNoteComposerStopBackgroundHint(
  survivingBackgroundCount: number,
): boolean {
  return survivingBackgroundCount > 0
}
