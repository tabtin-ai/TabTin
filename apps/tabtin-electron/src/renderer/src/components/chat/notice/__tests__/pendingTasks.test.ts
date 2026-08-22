/**
 * pendingTasks 单测 —— 覆盖 B「pending 任务预告条」的聚合 + 显隐矩阵。
 *
 * 聚合：子 Agent active（pending/queued/running）过滤 + 后台终端合并 + 顺序 + title 选取。
 * 显隐：pending 非空即显示（不限 phase，避免短后台任务竞态）。
 */

import { describe, it, expect } from 'vitest'
import type { RunPhase } from '../../../../stores/chat/shared/types'
import { aggregatePendingTasks, shouldShowPendingNotice } from '../pendingTasks'

describe('aggregatePendingTasks — 子 Agent active 过滤', () => {
  it('只纳入 pending/queued/running，终态被过滤', () => {
    const items = aggregatePendingTasks({
      subagentRuns: [
        { subagentRunId: 'r1', label: '助手1', status: 'pending' },
        { subagentRunId: 'r2', label: '助手2', status: 'queued' },
        { subagentRunId: 'r3', label: '助手3', status: 'running' },
        { subagentRunId: 'r4', label: '助手4', status: 'completed' },
        { subagentRunId: 'r5', label: '助手5', status: 'failed' },
        { subagentRunId: 'r6', label: '助手6', status: 'cancelled' },
      ],
      backgroundTasks: [],
    })
    expect(items.map((i) => i.id)).toEqual(['r1', 'r2', 'r3'])
    expect(items.every((i) => i.kind === 'subagent')).toBe(true)
  })

  it('title 选取优先级：role > label > task；都空返回空串', () => {
    const items = aggregatePendingTasks({
      subagentRuns: [
        { subagentRunId: 'r1', role: '科普撰稿人', label: 'L', task: 'T', status: 'running' },
        { subagentRunId: 'r2', label: '只有 label', task: 'T', status: 'running' },
        { subagentRunId: 'r3', task: '只有 task', status: 'running' },
        { subagentRunId: 'r4', status: 'running' },
      ],
      backgroundTasks: [],
    })
    expect(items.map((i) => i.title)).toEqual(['科普撰稿人', '只有 label', '只有 task', ''])
  })
})

describe('aggregatePendingTasks — 后台终端 + 合并顺序', () => {
  it('后台终端命令以 running 纳入，PTY sessionId 作 key', () => {
    const items = aggregatePendingTasks({
      subagentRuns: [],
      backgroundTasks: [
        { sessionId: 'pty-1', command: 'npm run dev', startedAt: 1 },
        { sessionId: 'pty-2', command: 'sleep 30', startedAt: 2 },
      ],
    })
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ id: 'pty-1', kind: 'shell', title: 'npm run dev', status: 'running' })
    expect(items[1]).toMatchObject({ id: 'pty-2', kind: 'shell', title: 'sleep 30', status: 'running' })
  })

  it('子 Agent 在前、后台终端在后，顺序稳定', () => {
    const items = aggregatePendingTasks({
      subagentRuns: [{ subagentRunId: 'r1', label: '助手', status: 'running' }],
      backgroundTasks: [{ sessionId: 'pty-1', command: 'ls', startedAt: 1 }],
    })
    expect(items.map((i) => i.kind)).toEqual(['subagent', 'shell'])
  })

  it('两源皆空 → 空数组', () => {
    expect(aggregatePendingTasks({ subagentRuns: [], backgroundTasks: [] })).toEqual([])
  })
})

describe('shouldShowPendingNotice — pending 非空即显示', () => {
  const PHASES: Array<RunPhase | undefined | null> = [
    'planning',
    'tool_calls',
    'synthesizing',
    'done',
    'error',
    'cancelled',
    undefined,
    null,
  ]

  it.each(PHASES)('phase=%s 且 pending>0 → 显示', (phase) => {
    expect(shouldShowPendingNotice(phase, 1)).toBe(true)
  })

  it.each(PHASES)('phase=%s 且 pending===0 → 不显示', (phase) => {
    expect(shouldShowPendingNotice(phase, 0)).toBe(false)
  })
})
