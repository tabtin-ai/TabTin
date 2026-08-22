/**
 * SubAgent Template API
 *
 * CRUD for user-defined sub-agent templates (Space-scoped).
 * Backed by orchestrationClient for unified auth / error handling.
 */

import { orchestrationClient } from './orchestrationApi'

export interface SubAgentTemplate {
  id: string
  space_id: string
  name: string
  description: string
  icon: string
  system_prompt: string
  subagent_type: 'explore' | 'plan' | 'execute'
  allowed_tools: string[]
  denied_tools: string[]
  model_id: string
  thinking_level: string
  default_mode: 'wait' | 'background'
  app_id: string
  is_enabled: boolean
  order: number
  display_color: string
  max_turns: number
  max_active: number
  version: number
  created_at: string | null
  updated_at: string | null
}

export type SubAgentTemplateCreate = Omit<SubAgentTemplate, 'id' | 'space_id' | 'max_turns' | 'version' | 'created_at' | 'updated_at'>
export type SubAgentTemplateUpdate = Partial<SubAgentTemplateCreate>

export const SubAgentTemplateApi = {
  async list(spaceId: string): Promise<SubAgentTemplate[]> {
    const data = await orchestrationClient.get<{ items: SubAgentTemplate[] }>(
      `/spaces/${spaceId}/subagent-templates`,
    )
    return data.items
  },

  async create(spaceId: string, payload: SubAgentTemplateCreate): Promise<SubAgentTemplate> {
    return orchestrationClient.post(`/spaces/${spaceId}/subagent-templates`, payload)
  },

  async update(spaceId: string, templateId: string, payload: SubAgentTemplateUpdate): Promise<SubAgentTemplate> {
    return orchestrationClient.put(`/spaces/${spaceId}/subagent-templates/${templateId}`, payload)
  },

  async remove(spaceId: string, templateId: string): Promise<void> {
    return orchestrationClient.delete(`/spaces/${spaceId}/subagent-templates/${templateId}`)
  },
}
