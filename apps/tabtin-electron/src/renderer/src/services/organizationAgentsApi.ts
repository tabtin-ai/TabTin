/**
 * 组织 Agent 列表 API（ W2 IA・「我的 Agent」/ 任务页选择）。
 *
 * GET /agents?organization_id=…（正典身份列表；名字已由序列化层展开 {owner}）。
 */

import { apiClient } from './apiClient'
import { API_ENDPOINTS } from '@/config/api'

export interface OrganizationAgentSummary {
  id: string
  /** 前端统一后的展示名；模板 `{owner}` 占位符不会暴露给用户 */
  name: string
  /** 后端展开后的展示名；兼容旧接口响应时可缺省 */
  display_name?: string
  type?: string
  is_active?: boolean
  /** 用户在该组织的默认身份；不可删除 */
  is_default?: boolean
  /** Agent 目标一句话（模板 goal / 用户自填） */
  goal?: string
  /** icon slug（AgentOut 顶层投影，来自 settings['icon']） */
  icon?: string
  /** 来源模板 slug（冻结快照溯源；空串 = 纯自建） */
  template_id?: string
  updated_at?: string
  /** 模板实例化落的 icon / avatar_key / avatar_url 等（Agent.settings JSON，可能缺失） */
  settings?: {
    icon?: string | null
    avatar_key?: string | null
    avatar_url?: string | null
  } | null
}

/** 开号成功后乐观写入列表：避免选中新 id 时列表还没有它而被回落到默认分身。 */
export function organizationAgentSummaryFromAgent(agent: {
  id: string
  name: string
  display_name?: string
  type?: string
  is_active?: boolean
  is_default?: boolean
  goal?: string
  template_id?: string
  updated_at?: string
  settings?: OrganizationAgentSummary['settings']
}): OrganizationAgentSummary {
  const displayName = (agent.display_name || agent.name).trim() || agent.name
  return {
    id: agent.id,
    name: displayName,
    display_name: agent.display_name,
    type: agent.type,
    is_active: agent.is_active,
    is_default: agent.is_default,
    goal: agent.goal,
    icon: typeof agent.settings?.icon === 'string' ? agent.settings.icon : undefined,
    template_id: agent.template_id,
    updated_at: agent.updated_at,
    settings: agent.settings ?? null,
  }
}

interface OrganizationAgentsResponse {
  agents: OrganizationAgentSummary[]
  total: number
}

// stale-while-revalidate 缓存（ W4）：进程内存活期，只用于「切回页面先展示
// 上次已知列表、后台静默刷新」，不做持久化、不设 TTL——过期与否由调用方决定是否
// 触发刷新；这里只负责按 organizationId 存取最近一次成功响应。
const lastKnownAgentsByOrganizationId = new Map<string, OrganizationAgentSummary[]>()

/** 读取上次成功加载的列表快照；无缓存返回 null（调用方据此判断是否要展示骨架）。 */
export function getCachedOrganizationAgents(organizationId: string): OrganizationAgentSummary[] | null {
  return lastKnownAgentsByOrganizationId.get(organizationId) ?? null
}

export async function listOrganizationAgents(organizationId: string): Promise<OrganizationAgentSummary[]> {
  const { data } = await apiClient.get<OrganizationAgentsResponse>(
    API_ENDPOINTS.AGENT.LIST,
    { params: { organization_id: organizationId, page_size: 100 } },
  )
  const agents = (data?.agents ?? [])
    .filter(agent => agent.is_active !== false)
    .map(agent => ({
      ...agent,
      name: agent.display_name?.trim() || agent.name,
    }))
  lastKnownAgentsByOrganizationId.set(organizationId, agents)
  return agents
}
