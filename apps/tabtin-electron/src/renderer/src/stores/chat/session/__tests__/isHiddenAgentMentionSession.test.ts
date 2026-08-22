import { describe, expect, it } from 'vitest'
import { isHiddenAgentMentionSession } from '../isHiddenAgentMentionSession'

describe('isHiddenAgentMentionSession', () => {
  it('认会话自身的 is_agent_mention_session', () => {
    expect(isHiddenAgentMentionSession({
      id: 's-mention',
      is_agent_mention_session: true,
    })).toBe(true)
  })

  it('认侧栏 list 明确排除的 id', () => {
    expect(isHiddenAgentMentionSession(
      { id: 's-excluded' },
      new Set(['s-excluded']),
    )).toBe(true)
  })

  it('不用标题判断', () => {
    expect(isHiddenAgentMentionSession({
      id: 's-title',
      title: '[私信@小Tin]',
    } as { id: string; is_agent_mention_session?: boolean; title: string })).toBe(false)
  })
})
