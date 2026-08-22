import { describe, expect, it } from 'vitest'
import type { ConversationMember } from '@/services/tabchatApi'
import {
  agentOwnerDisplayName,
  countMemberBreakdown,
  isAgentExecutionOffline,
  isAgentMember,
  partitionConversationMembers,
} from './conversationMembers'

const human: ConversationMember = {
  member_type: 'user',
  user_id: 'u1',
  agent_id: null,
  nickname: 'Alice',
  username: 'alice',
  avatar: '',
  role: 1,
  is_muted: false,
  pinned: false,
  joined_at: null,
}

const agent: ConversationMember = {
  member_type: 'agent',
  user_id: null,
  agent_id: 'a1',
  nickname: 'Bot',
  username: '',
  avatar: '',
  role: 1,
  is_muted: false,
  pinned: false,
  joined_at: null,
}

describe('conversationMembers', () => {
  it('detects agent members by member_type or agent_id', () => {
    expect(isAgentMember(agent)).toBe(true)
    expect(isAgentMember(human)).toBe(false)
    expect(isAgentMember({ ...human, member_type: undefined, user_id: null, agent_id: 'a2' })).toBe(true)
  })

  it('partitions and counts humans vs agents', () => {
    const members = [human, agent, { ...human, user_id: 'u2', nickname: 'Bob' }]
    expect(partitionConversationMembers(members)).toEqual({
      humans: [human, { ...human, user_id: 'u2', nickname: 'Bob' }],
      agents: [agent],
    })
    expect(countMemberBreakdown(members)).toEqual({ human: 2, agent: 1 })
  })

  it('reads agent owner display name and ignores humans or blank names', () => {
    expect(agentOwnerDisplayName({
      ...agent,
      owner_display_name: '  张三  ',
    })).toBe('张三')
    expect(agentOwnerDisplayName(agent)).toBe('')
    expect(agentOwnerDisplayName({
      ...human,
      owner_display_name: '不该出现',
    })).toBe('')
    expect(agentOwnerDisplayName(undefined)).toBe('')
  })

  it('marks an agent offline only when execution is explicitly offline', () => {
    expect(isAgentExecutionOffline({ ...agent, is_execution_online: false })).toBe(true)
    expect(isAgentExecutionOffline({ ...agent, is_execution_online: true })).toBe(false)
    expect(isAgentExecutionOffline(agent)).toBe(false)
    expect(isAgentExecutionOffline(human)).toBe(false)
  })
})
