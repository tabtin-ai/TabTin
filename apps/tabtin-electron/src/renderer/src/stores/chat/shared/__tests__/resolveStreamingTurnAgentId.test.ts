import { describe, expect, it } from 'vitest'
import {
  resolveStreamingTurnAgentFace,
  resolveStreamingTurnAgentId,
} from '../resolveStreamingTurnAgentId'

describe('resolveStreamingTurnAgentId', () => {
  it('优先用 message.agent_id（历史 / 落库权威）', () => {
    expect(resolveStreamingTurnAgentId({
      messageAgentId: 'agent-from-message',
      sessionAgentId: 'agent-from-session',
      selectedAgentId: 'agent-from-selected',
    })).toBe('agent-from-message')
  })

  it('message 缺省时回退 session.agent_id（本轮执行身份）', () => {
    expect(resolveStreamingTurnAgentId({
      messageAgentId: null,
      sessionAgentId: 'agent-from-session',
      selectedAgentId: 'agent-from-selected',
    })).toBe('agent-from-session')
  })

  it('session 也缺省时回退 selectedAgent.id', () => {
    expect(resolveStreamingTurnAgentId({
      sessionAgentId: null,
      selectedAgentId: 'agent-from-selected',
    })).toBe('agent-from-selected')
  })

  it('三者皆空时返回 null，不编造身份', () => {
    expect(resolveStreamingTurnAgentId({})).toBeNull()
    expect(resolveStreamingTurnAgentId({
      messageAgentId: '  ',
      sessionAgentId: '',
      selectedAgentId: null,
    })).toBeNull()
  })

  it('消息与会话 Agent 一致时复用安全展示快照', () => {
    expect(resolveStreamingTurnAgentFace({
      messageAgentId: 'agent-owner',
      sessionAgentId: 'agent-owner',
      sessionAgentName: 'Owner Agent',
      sessionAgentAvatar: 'https://example.com/owner-agent.png',
    })).toEqual({
      agentId: 'agent-owner',
      agentName: 'Owner Agent',
      agentAvatar: 'https://example.com/owner-agent.png',
    })
  })

  it('消息与会话 Agent 不一致时不套用过期展示快照', () => {
    expect(resolveStreamingTurnAgentFace({
      messageAgentId: 'agent-new',
      sessionAgentId: 'agent-old',
      sessionAgentName: 'Old Agent',
      sessionAgentAvatar: 'https://example.com/old-agent.png',
    })).toEqual({
      agentId: 'agent-new',
      agentName: null,
      agentAvatar: null,
    })
  })
})
