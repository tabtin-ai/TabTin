import type { Agent, AgentType } from '@tabtin/app-shell'

export type { AgentType }

/**
 * OrganizationAgent — 与 Agent 字段完全一致，保留类型别名以便未来扩展独有字段。
 */
export interface OrganizationAgent extends Agent {}

export interface SpaceMembership {
  id: string
  space_id: string
  agent_id?: string | null
  user_id?: string | null
  role: 'owner' | 'admin' | 'editor' | 'viewer'
  permissions: Record<string, unknown>
  is_active: boolean
  joined_at: string
  updated_at: string
}

export interface SpaceMembershipListResponse {
  memberships: SpaceMembership[]
  total: number
}

export interface OrganizationAgentListResponse {
  agents: OrganizationAgent[]
  total: number
}

export interface CreateSpaceMembershipRequest {
  agent_id?: string
  user_id?: string
  role: 'admin' | 'editor' | 'viewer'
}

export interface AvailableTool {
  name: string
  description: string
}

export interface AvailableToolsResponse {
  tools: AvailableTool[]
}
