import { describe, expect, it } from 'vitest'
import { shouldShowConversationAgentMeta } from './conversationMeta'

const makeSession = (id: string, agentId: string, agentName: string) => ({
  id,
  title: '新对话',
  status: 'active',
  organization_id: 'organization-1',
  created_at: '2026-03-26T09:00:00.000Z',
  updated_at: '2026-03-27T09:00:00.000Z',
  agent_id: agentId,
  agent_name: agentName,
})

describe('shouldShowConversationAgentMeta', () => {
  it('当前列表只有一个 Agent 时隐藏冗余元信息', () => {
    const sessions = [
      makeSession('session-1', 'agent-1', '小豆子'),
      makeSession('session-2', 'agent-1', '小豆子'),
    ]

    expect(shouldShowConversationAgentMeta(sessions, null)).toBe(false)
  })

  it('当前列表混合多个 Agent 且未筛选时显示 Agent 名称入口', () => {
    const sessions = [
      makeSession('session-1', 'agent-1', '小豆子'),
      makeSession('session-2', 'agent-2', '阿 Tin'),
    ]

    expect(shouldShowConversationAgentMeta(sessions, null)).toBe(true)
  })

  it('已按 Agent 过滤后不再重复展示 Agent 元信息', () => {
    const sessions = [
      makeSession('session-1', 'agent-1', '小豆子'),
      makeSession('session-2', 'agent-2', '阿 Tin'),
    ]

    expect(shouldShowConversationAgentMeta(sessions, 'agent-1')).toBe(false)
  })
})
