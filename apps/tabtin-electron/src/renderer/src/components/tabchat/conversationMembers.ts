import type { ConversationMember } from '@/services/tabchatApi'

export interface MemberBreakdown {
  human: number
  agent: number
}

export function isAgentMember(member: ConversationMember): boolean {
  return member.member_type === 'agent' || (!member.user_id && !!member.agent_id)
}

export function partitionConversationMembers(members: ConversationMember[]) {
  const humans: ConversationMember[] = []
  const agents: ConversationMember[] = []
  for (const member of members) {
    if (isAgentMember(member)) agents.push(member)
    else humans.push(member)
  }
  return { humans, agents }
}

export function countMemberBreakdown(members: ConversationMember[]): MemberBreakdown {
  const { humans, agents } = partitionConversationMembers(members)
  return { human: humans.length, agent: agents.length }
}

export function agentOwnerDisplayName(member: ConversationMember | undefined): string {
  if (!member || !isAgentMember(member)) return ''
  return (member.owner_display_name || '').trim()
}

export function isAgentExecutionOffline(member: ConversationMember | undefined): boolean {
  if (!member || !isAgentMember(member)) return false
  return member.is_execution_online === false
}
