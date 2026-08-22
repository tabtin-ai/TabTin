import { getApiClient } from '@/api/tabtin-client'

// ─── Types ──────────────────────────────────────────────────────────────

export interface MultimodalDomainOverview {
  active_scenes: number
  active_bindings: number
  healthy_models: number
}

export type MultimodalDomain =
  | 'vision'
  | 'asr'
  | 'tts'
  | 'image_gen'
  | 'video_gen'
  | 'audio_gen'

export type MultimodalOverview = Record<MultimodalDomain, MultimodalDomainOverview>

export interface MultimodalModelLite {
  id: string
  model_name: string
  display_name: string
  provider_name: string
  provider_display_name: string
  supports_vision?: boolean
}

export interface MultimodalVoice {
  voice_id: string
  display_name: string
  gender: string
  language: string
}

export interface MultimodalSceneBinding {
  id: string
  primary_model: {
    id: string
    model_name: string
    display_name: string
    provider_name: string
    provider_display_name: string
  }
  fallback_models: unknown[]
  default_params: Record<string, unknown>
  timeout_sec: number | null
  updated_at: string | null
}

export interface MultimodalSceneItem {
  scene_key: string
  display_name: string
  description: string
  capability_domain: string
  capability_requirements: Record<string, unknown>
  is_system: boolean
  binding: MultimodalSceneBinding | null
  available_voices: MultimodalVoice[]
  capability_validation: 'satisfied' | 'unsatisfied'
  capability_issues: string[]
}

export interface SpeechSubPageData {
  tts: {
    scenes: MultimodalSceneItem[]
    active_provider_ids: string[]
    available_models: MultimodalModelLite[]
  }
  asr: {
    scenes: MultimodalSceneItem[]
    active_provider_ids: string[]
    available_models: MultimodalModelLite[]
  }
}

export interface VisionSubPageData {
  scenes: MultimodalSceneItem[]
  available_models: MultimodalModelLite[]
}

export type MediaTaskStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type MediaCapabilityDomain =
  | 'image_gen'
  | 'video_gen'
  | 'audio_gen'
  | 'unknown'

export interface MediaTaskItem {
  id: string
  task_id: string
  task_type: string
  capability_domain: MediaCapabilityDomain
  scene_key: string
  status: MediaTaskStatus
  organization_id: string
  user_id: string
  model_name: string
  model_display_name: string
  prompt: string
  error_code: string
  error_message: string
  created_at: string | null
  completed_at: string | null
}

export interface MediaTaskListResponse {
  tasks: MediaTaskItem[]
  total: number
  page: number
  page_size: number
}

export interface MediaTaskDetail extends MediaTaskItem {
  provider_name: string
  stored_urls: string[]
  result_urls: string[]
  result_metadata: Record<string, unknown>
  /** MediaTask 真实字段名 — 任务被 provider 接收时填 */
  submitted_at: string | null
}

export interface ListTasksParams {
  capability_domain?: MediaCapabilityDomain
  status?: MediaTaskStatus
  organization_id?: string
  // 注：MediaTask v0.1 没有 scene_key 字段，filter 暂不支持。
  // 待 v0.2 migration 给 MediaTask 加 scene_key 后再在此扩展。
  page?: number
  page_size?: number
}

// ─── Endpoints ──────────────────────────────────────────────────────────

export const multimodalApi = {
  async overview(): Promise<MultimodalOverview> {
    return getApiClient().raw<MultimodalOverview>(
      'GET',
      '/services/llm/admin/multimodal/overview'
    )
  },

  async speech(): Promise<SpeechSubPageData> {
    return getApiClient().raw<SpeechSubPageData>(
      'GET',
      '/services/llm/admin/multimodal/speech'
    )
  },

  async vision(): Promise<VisionSubPageData> {
    return getApiClient().raw<VisionSubPageData>(
      'GET',
      '/services/llm/admin/multimodal/vision'
    )
  },

  async listTasks(params: ListTasksParams = {}): Promise<MediaTaskListResponse> {
    const queryParams: Record<string, string | number | boolean> = {}
    if (params.capability_domain) queryParams.capability_domain = params.capability_domain
    if (params.status) queryParams.status = params.status
    if (params.organization_id) queryParams.organization_id = params.organization_id
    if (params.page) queryParams.page = params.page
    if (params.page_size) queryParams.page_size = params.page_size
    return getApiClient().raw<MediaTaskListResponse>(
      'GET',
      '/services/llm/admin/multimodal/tasks',
      { params: queryParams }
    )
  },

  async taskDetail(taskId: string): Promise<MediaTaskDetail> {
    return getApiClient().raw<MediaTaskDetail>(
      'GET',
      `/services/llm/admin/multimodal/tasks/${taskId}`
    )
  },

  async retryTask(taskId: string): Promise<{ task_id: string; status: string; message: string }> {
    return getApiClient().raw(
      'POST',
      `/services/llm/admin/multimodal/tasks/${taskId}/retry`
    )
  },
}
