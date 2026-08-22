/**
 * pendingTasks —— 「异步任务感知」B：pending 任务聚合 + 预告条显隐判定（纯函数）。
 *
 * 子 Agent / 后台终端命令是异步任务：Agent 可能先回正文但任务在后台跑，
 * 完成后通过 push 通知唤起 Agent 新一轮继续。输入框上方预告条告诉用户
 * 「下列任务完成后，Agent 会继续回复你」。
 *
 * 两个数据源（renderer 侧汇合）：
 *   - **子 Agent**：`subagentRunsBySessionId` 中 status ∈ {pending, queued, running}
 *   - **后台终端**：`agent-engine:list-running-background-tasks` IPC 的 running 命令
 *
 * 显隐：只要 pending 非空就显示。短后台任务（如 sleep 3）常在 turn 结束前就跑完，
 * 若仍要求 phase===done 才拉/才显示，用户永远看不到预告条。
 */

import type { RunPhase } from '../../../stores/chat/shared/types'
import { SUBAGENT_ACTIVE_STATUSES } from '../subagent/subagentMarkerStatus'

export interface PendingTaskItem {
  /** 列表稳定 key：子 Agent = subagentRunId；后台终端 = PTY session id。 */
  id: string
  kind: 'subagent' | 'shell'
  /** 显示标题（子 Agent: role/label/task 最佳可用；后台终端: command）。可能为空串，组件兜底。 */
  title: string
  /** 状态原值（子 Agent: pending/queued/running；后台终端: running）。 */
  status: string
}

/** 聚合入参——子 Agent run 子集 + 后台终端 IPC 返回项。 */
export interface AggregatePendingInput {
  subagentRuns: ReadonlyArray<{
    subagentRunId: string
    role?: string
    label?: string
    task?: string
    status: string
  }>
  backgroundTasks: ReadonlyArray<{ sessionId: string; command: string; startedAt: number }>
}

/** 子 Agent run 的最佳显示标题（role 优先，回落 label/task；都空返回空串）。 */
function subagentTitle(run: AggregatePendingInput['subagentRuns'][number]): string {
  return (run.role || run.label || run.task || '').replace(/\s+/g, ' ').trim()
}

/**
 * 聚合两源 pending 任务：子 Agent active 在前（叙事上「派出去的人」先于「跑的命令」），
 * 后台终端在后。返回顺序稳定。
 */
export function aggregatePendingTasks(input: AggregatePendingInput): PendingTaskItem[] {
  const items: PendingTaskItem[] = []
  for (const run of input.subagentRuns) {
    if (!SUBAGENT_ACTIVE_STATUSES.has(run.status)) continue
    items.push({ id: run.subagentRunId, kind: 'subagent', title: subagentTitle(run), status: run.status })
  }
  for (const task of input.backgroundTasks) {
    items.push({ id: task.sessionId, kind: 'shell', title: (task.command || '').trim(), status: 'running' })
  }
  return items
}

/**
 * 预告条显隐：pending 非空即显示。
 * `phase` 保留入参以兼容调用方；不再用 phase===done 门控（短后台任务竞态）。
 */
export function shouldShowPendingNotice(
  _phase: RunPhase | undefined | null,
  pendingCount: number,
): boolean {
  return pendingCount > 0
}
