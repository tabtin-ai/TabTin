import { describe, expect, it } from 'vitest'
import {
  countSurvivingBackgroundSubagents,
  isSurvivingBackgroundSubagent,
  listSurvivingBackgroundSubagents,
  shouldNoteComposerStopBackgroundHint,
} from '../survivingBackgroundSubagents'
import type { SubagentRun } from '../../shared/types'

function run(partial: Partial<SubagentRun> & Pick<SubagentRun, 'subagentRunId' | 'status'>): SubagentRun {
  return partial
}

describe('survivingBackgroundSubagents', () => {
  it('only counts active background runs', () => {
    const runs = [
      run({ subagentRunId: 'a', status: 'running', background: true }),
      run({ subagentRunId: 'b', status: 'running', background: false }),
      run({ subagentRunId: 'c', status: 'completed', background: true }),
      run({ subagentRunId: 'd', status: 'queued', background: true }),
    ]
    expect(listSurvivingBackgroundSubagents(runs).map((r) => r.subagentRunId)).toEqual(['a', 'd'])
    expect(countSurvivingBackgroundSubagents(runs)).toBe(2)
    expect(isSurvivingBackgroundSubagent(runs[1]!)).toBe(false)
  })

  it.each([
    { mode: 'stop_only', surviving: 2, note: true },
    { mode: 'withdraw_and_restore', surviving: 1, note: true },
    { mode: 'stop_only', surviving: 0, note: false },
    { mode: 'withdraw_and_restore', surviving: 0, note: false },
  ] as const)(
    'ComposerStopMode=$mode surviving=$surviving → note=$note（与 mode 无关）',
    ({ surviving, note }) => {
      expect(shouldNoteComposerStopBackgroundHint(surviving)).toBe(note)
    },
  )
})
