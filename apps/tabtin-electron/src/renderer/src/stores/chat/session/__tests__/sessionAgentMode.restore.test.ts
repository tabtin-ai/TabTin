import { describe, expect, it } from 'vitest'
import { mergeRestoredSessionAgentMode } from '../sessionAgentModeRestore'

describe('mergeRestoredSessionAgentMode ', () => {
  it('live mode 已存在时不被历史 plan 盖回', () => {
    expect(mergeRestoredSessionAgentMode('agent', 'plan')).toBe('agent')
  })

  it('尚无 live mode 时用历史 metadata 回填', () => {
    expect(mergeRestoredSessionAgentMode(undefined, 'plan')).toBe('plan')
  })

  it('两边都空则仍为空', () => {
    expect(mergeRestoredSessionAgentMode(undefined, undefined)).toBeUndefined()
  })
})
