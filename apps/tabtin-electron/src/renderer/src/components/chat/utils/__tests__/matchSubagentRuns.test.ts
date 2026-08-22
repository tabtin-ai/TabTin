import { describe, it, expect } from 'vitest'
import { matchSubagentRunsByIds, extractSubagentRunIdFromResult } from '../matchSubagentRuns'
import type { SubagentRun } from '../../../../stores/chat/shared/types'

function run(partial: Partial<SubagentRun> & { subagentRunId: string }): SubagentRun {
  return { status: 'running', ...partial }
}

describe('matchSubagentRunsByIds', () => {
  it('parentToolCallId 反查限定在派发 owner 内', () => {
    const runs = [
      run({ subagentRunId: 'main-child', parentToolCallId: 'agent_0', dispatchedByRunId: '' }),
      run({ subagentRunId: 'nested-child', parentToolCallId: 'agent_0', dispatchedByRunId: 'leader-a' }),
    ]
    expect(matchSubagentRunsByIds(runs, ['agent_0'], '').map(r => r.subagentRunId)).toEqual(['main-child'])
    expect(matchSubagentRunsByIds(runs, ['agent_0'], 'leader-a').map(r => r.subagentRunId)).toEqual(['nested-child'])
  })

  it('同一 owner 下重复 parentToolCallId 按 store 顺序 FIFO', () => {
    const runs = [
      run({ subagentRunId: 'run-a', parentToolCallId: 'agent_0', dispatchedByRunId: '' }),
      run({ subagentRunId: 'run-b', parentToolCallId: 'agent_0', dispatchedByRunId: '' }),
    ]
    expect(
      matchSubagentRunsByIds(runs, ['agent_0', 'agent_0'], '').map(r => r.subagentRunId),
    ).toEqual(['run-a', 'run-b'])
  })

  it('subagentRunId 精确命中不看 owner', () => {
    const runs = [
      run({ subagentRunId: 'uuid-1', parentToolCallId: 'agent_0', dispatchedByRunId: 'leader-a' }),
    ]
    expect(matchSubagentRunsByIds(runs, ['uuid-1'], '').map(r => r.subagentRunId)).toEqual(['uuid-1'])
  })

  it('同一个 subagentRunId 被 resume 复用时，父卡片按 parentToolCallId 命中对应运行', () => {
    const runs = [
      run({ subagentRunId: 'child-session', parentToolCallId: 'toolu_first', status: 'completed', summary: 'first' }),
      run({ subagentRunId: 'child-session', parentToolCallId: 'toolu_resume', status: 'completed', summary: 'resume' }),
    ]

    const matched = matchSubagentRunsByIds(runs, ['toolu_first', 'toolu_resume'], '')

    expect(matched.map(r => r.parentToolCallId)).toEqual(['toolu_first', 'toolu_resume'])
    expect(matched.map(r => r.summary)).toEqual(['first', 'resume'])
  })
})

describe('extractSubagentRunIdFromResult', () => {
  it('解析 [子 Agent ID: uuid] 标记', () => {
    expect(extractSubagentRunIdFromResult('done\n\n[子 Agent ID: abc-123]')).toBe('abc-123')
  })
})
