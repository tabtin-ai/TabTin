/**
 * Project 动态流 API
 *
 * 只读分页列表：GET /context/projects/{projectId}/activities
 * 后端事件表 append-only，事件在源对象删除后仍可追溯。
 */
import { joinApiPath } from '@tabtin/config'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { apiRequest as adapterApiRequest, getAuthToken } from '@/adapters/api-adapter-instance'

export type SpaceActivityEventType =
  | 'space_created'
  | 'member_joined'
  | 'member_left'
  | 'member_role_changed'
  | 'asset_created'
  | 'asset_archived'
  | 'asset_restored'
  | 'agent_run_started'
  | 'agent_run_completed'
  | 'agent_run_failed'
  | 'settings_updated'
  | 'channel_created'
  | 'channel_renamed'
  | 'channel_archived'

export interface SpaceActivityEvent {
  id: string
  event_type: SpaceActivityEventType | string
  actor_user_id: string
  actor_name: string
  target_type: string
  target_id: string
  target_name: string
  metadata: Record<string, unknown>
  created_at: string
}

export interface SpaceActivityListResult {
  items: SpaceActivityEvent[]
  total: number
  page: number
  limit: number
}

type SpaceActivityApiResponse = {
  success?: boolean
  code?: string
  message?: string
  data?: SpaceActivityListResult
}

export class SpaceActivityApiError extends Error {
  readonly statusCode: number
  readonly errorCode?: string

  constructor(message: string, statusCode: number, errorCode?: string) {
    super(message)
    this.name = 'SpaceActivityApiError'
    this.statusCode = statusCode
    this.errorCode = errorCode
  }
}

export class SpaceActivityApiService {
  static async listActivities(
    projectId: string,
    params?: { page?: number; limit?: number },
  ): Promise<SpaceActivityListResult> {
    const url = new URL(joinApiPath(API_CONFIG.baseURL, API_ENDPOINTS.PROJECT.ACTIVITIES(projectId)))
    if (params?.page) url.searchParams.set('page', String(params.page))
    if (params?.limit) url.searchParams.set('limit', String(params.limit))

    const token = await getAuthToken().catch(() => null)
    const response = await adapterApiRequest({
      url: url.toString(),
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })

    const payload = (response?.data ?? null) as SpaceActivityApiResponse | null
    if (!response || response.status !== 200 || !payload?.success || !payload.data) {
      throw new SpaceActivityApiError(
        payload?.message || '动态流加载失败',
        response?.status ?? 0,
        payload?.code,
      )
    }
    return payload.data
  }
}
