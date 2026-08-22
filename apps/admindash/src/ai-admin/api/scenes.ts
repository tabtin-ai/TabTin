import { getApiClient } from '@/api/tabtin-client'

export interface SceneBinding {
  id: string
  scene_key: string
  primary_model: { id: string; display_name: string; model_name: string } | null
  fallback_models: unknown[]
  default_params: Record<string, unknown>
  timeout_sec: number | null
  created_at: string | null
  updated_at: string | null
}

export interface SceneItem {
  scene_key: string
  display_name: string
  description: string
  capability_domain: string
  capability_requirements: Record<string, unknown>
  is_system: boolean
  binding: SceneBinding | null
  capability_validation: 'satisfied' | 'unsatisfied'
  last_call_at: string | null
}

export interface SceneDetailData {
  scene_key: string
  spec: {
    display_name: string
    description: string
    capability_domain: string
    is_system: boolean
    capability_requirements: Record<string, unknown>
    default_params: Record<string, unknown>
  }
  binding: SceneBinding | null
  prompt_bundle: {
    bundle_path: string
    has_system_md: boolean
    has_user_template: boolean
  } | null
  recent_usage: {
    total_calls_24h: number
    success_rate: number
    avg_latency_ms: number
    total_cost_usd: string
  }
  recent_audit: Array<{
    id: string
    action: string
    operator: string
    changed_fields: string[] | null
    created_at: string | null
  }>
}

export interface ScenePromptData {
  scene_key: string
  frontmatter: Record<string, unknown>
  system_md: string
  user_template: string
  variables_detected: string[]
}

export interface BulkSceneBindingUpdate {
  scene_key: string
  primary_model_id: string
}

export interface BulkBindingCandidateModel {
  id: string
  display_name: string
  model_name: string
}

export interface BulkBindingCandidateGroup {
  capability_domain: string
  scene_keys: string[]
  models: BulkBindingCandidateModel[]
}

export const scenesApi = {
  async list(params?: {
    domain?: string
    include_system?: boolean
    keyword?: string
  }): Promise<{ scenes: SceneItem[]; total: number }> {
    return getApiClient().raw('GET', '/services/llm/admin/scenes', { params })
  },

  async detail(sceneKey: string): Promise<SceneDetailData> {
    return getApiClient().raw('GET', `/services/llm/admin/scenes/${sceneKey}`)
  },

  async updateBinding(
    sceneKey: string,
    data: {
      primary_model_id?: string
      fallback_models?: unknown[]
      default_params?: Record<string, unknown>
      timeout_sec?: number | null
    }
  ): Promise<{ binding: SceneBinding }> {
    return getApiClient().raw('PATCH', `/services/llm/admin/scenes/${sceneKey}/binding`, {
      body: data,
    })
  },

  async updateBindings(
    bindings: BulkSceneBindingUpdate[]
  ): Promise<{ updated_count: number; scene_keys: string[] }> {
    return getApiClient().raw('PATCH', '/services/llm/admin/scenes/bindings/bulk', {
      body: { bindings },
    })
  },

  async listBindingCandidates(
    sceneKeys: string[]
  ): Promise<{ groups: BulkBindingCandidateGroup[] }> {
    return getApiClient().raw('POST', '/services/llm/admin/scenes/bindings/bulk/candidates', {
      body: { scene_keys: sceneKeys },
    })
  },

  async getPrompt(sceneKey: string): Promise<ScenePromptData> {
    return getApiClient().raw('GET', `/services/llm/admin/scenes/${sceneKey}/prompt`)
  },

  async previewPrompt(
    sceneKey: string,
    variables: Record<string, unknown>,
    mode?: string
  ): Promise<{
    rendered_system: string
    rendered_user: string
    variables_missing: string[]
  }> {
    return getApiClient().raw('POST', `/services/llm/admin/scenes/${sceneKey}/prompt-preview`, {
      body: { variables, mode },
    })
  },
}
