import { describe, expect, it } from 'vitest'
import { isAgentSwitchedSystemMessage } from '@stores/chat/presentation/messageBubble/timelineMessageVisibility'

describe('isAgentSwitchedSystemMessage', () => {
  it('识别 metadata.system_fact=agent_switched', () => {
    expect(isAgentSwitchedSystemMessage({
      content: '任意',
      metadata: { system_fact: 'agent_switched' },
    })).toBe(true)
  })

  it('识别旧文案「切换当前 Agent」', () => {
    expect(isAgentSwitchedSystemMessage({
      content: '切换当前 Agent',
      metadata: null,
    })).toBe(true)
  })

  it('识别曾写入的「Agent 已切换成…」文案', () => {
    expect(isAgentSwitchedSystemMessage({
      content: 'Agent 已切换成agent-1',
      metadata: {},
    })).toBe(true)
  })

  it('其它系统消息不命中', () => {
    expect(isAgentSwitchedSystemMessage({
      content: '上下文已压缩到此',
      metadata: { system_fact: 'other' },
    })).toBe(false)
  })
})
