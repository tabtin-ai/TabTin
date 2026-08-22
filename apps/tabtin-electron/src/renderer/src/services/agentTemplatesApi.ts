/**
 * Agent 模板与创建 API（ Agent-first IA・「新建 Agent」入口）。
 *
 * - listAgentTemplates：精品 Agent 模板列表（GET /agents/templates）。
 * - createBotAgent：只建 Agent 身份（POST /agents）。Workspace 独立供给，
 *   与 Agent 解耦，开号不再强制建/切执行现场（principle/workspace-project.md）。
 */

import { apiClient } from './apiClient'
import { API_ENDPOINTS } from '@/config/api'
import type { Agent } from '@tabtin/app-shell'

export interface AgentTemplate {
  /** 模板 slug（实例化时作为 template_id 传给创建接口） */
  id: string
  name: string
  /** emoji 图标 */
  icon?: string | null
  /** 平台品牌头像标识；客户端映射到随包资源 */
  avatar_key?: string | null
  /** 一句话卖点 */
  tagline?: string | null
  description?: string | null
  version?: string | null
}

/** 自建 bot Agent 配额超限（后端 MAX_CUSTOM_BOT_AGENTS=5）的错误 code。 */
export const AGENT_LIMIT_EXCEEDED_CODE = 'AGENT_LIMIT_EXCEEDED'

export async function listAgentTemplates(): Promise<AgentTemplate[]> {
  const { data } = await apiClient.get<{ templates: AgentTemplate[]; total: number }>(
    API_ENDPOINTS.AGENT.TEMPLATES,
  )
  return data?.templates ?? []
}

export interface CreateBotAgentInput {
  organizationId: string
  name: string
  /** 模板 slug；缺省 = 从空白自建（占自建配额） */
  templateId?: string
  /** 平台品牌头像标识；从空白创建时由用户从随包预设中选择。 */
  avatarKey?: string
}

/** bot 类型创建响应：仅 Agent 身份。 */
export type CreateBotAgentResult = Agent

export async function createBotAgent(input: CreateBotAgentInput): Promise<CreateBotAgentResult> {
  const { data: agent } = await apiClient.post<Agent>(API_ENDPOINTS.AGENT.CREATE, {
    organization_id: input.organizationId,
    name: input.name,
    type: 'bot',
    ...(input.templateId ? { template_id: input.templateId } : {}),
    ...(input.avatarKey ? { avatar_key: input.avatarKey } : {}),
  })
  if (!agent?.id) {
    throw new Error('Invalid create agent response')
  }
  return agent
}
