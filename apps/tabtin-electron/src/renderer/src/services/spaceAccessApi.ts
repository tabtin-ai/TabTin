import { joinApiPath } from '@tabtin/config'
import {
  type AvailableToolsResponse,
  type CreateSpaceMembershipRequest,
  type SpaceMembership,
  type SpaceMembershipListResponse,
  type OrganizationAgentListResponse,
} from '@/types/space-access'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { apiRequest as adapterApiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import i18n from '@/i18n'
import { createLogger } from '@/utils/logger'

const log = createLogger('SpaceAccessApi')

type SpaceAccessApiResponse<T> = {
  success?: boolean
  code?: string
  error_code?: string
  message?: string
  data?: T
}

interface OrganizationAgentSearchParams {
  page?: number
  pageSize?: number
}

export class SpaceAccessApiError extends Error {
  readonly statusCode: number
  readonly errorCode?: string
  readonly responseData?: unknown

  constructor(message: string, statusCode: number, errorCode?: string, responseData?: unknown) {
    super(message)
    this.name = 'SpaceAccessApiError'
    this.statusCode = statusCode
    this.errorCode = errorCode
    this.responseData = responseData
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function getErrorCode(value: unknown): string | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const code = record.code ?? record.error_code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

function getErrorMessage(value: unknown): string | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const message = record.message
  return typeof message === 'string' && message.length > 0 ? message : undefined
}

function createSpaceAccessApiError(
  payload: unknown,
  statusCode: number,
  fallbackMessage: string,
): SpaceAccessApiError {
  return new SpaceAccessApiError(
    getErrorMessage(payload) || fallbackMessage,
    statusCode,
    getErrorCode(payload),
    payload,
  )
}

function buildSpaceAccessApiError(
  response: { status?: number; data?: unknown } | null | undefined,
  fallbackMessage: string,
): SpaceAccessApiError {
  return createSpaceAccessApiError(response?.data, response?.status ?? 0, fallbackMessage)
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const token = await getAuthToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch (error) {
    log.warn(i18n.t('common:logs.tokenFetchFailed'), error)
    return {}
  }
}

async function apiRequest(options: {
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  body?: string
}) {
  const authHeaders = await getAuthHeaders()
  return adapterApiRequest({
    ...options,
    headers: {
      ...authHeaders,
      ...options.headers,
    },
  })
}

export class SpaceAccessApiService {
  static async listOrganizationAgents(organizationId: string, params?: OrganizationAgentSearchParams): Promise<OrganizationAgentListResponse> {
    const url = new URL(joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.ORGANIZATION_AGENT.LIST(organizationId)}`))
    if (params?.page) url.searchParams.set('page', String(params.page))
    if (params?.pageSize) url.searchParams.set('page_size', String(params.pageSize))

    const response = await apiRequest({
      url: url.toString(),
      method: 'GET',
    })
    if (!response || response.status !== 200) {
      throw buildSpaceAccessApiError(response, i18n.t('space:access.errors.fetchAgentsFailed'))
    }
    const responseData = response.data as SpaceAccessApiResponse<OrganizationAgentListResponse>
    if (!responseData?.success || !responseData.data?.agents) {
      throw createSpaceAccessApiError(responseData, response.status, i18n.t('space:access.errors.fetchAgentsInvalid'))
    }
    return responseData.data as OrganizationAgentListResponse
  }

  /**
   * ：成员读写走 Project 正式路径。
   * 当前调用方均为团队协作场（Project.id）；个人工作空间请改用 WORKSPACE.MEMBERSHIPS。
   */
  static async listSpaceMemberships(projectId: string): Promise<SpaceMembershipListResponse> {
    const response = await apiRequest({
      url: joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.PROJECT.MEMBERSHIPS(projectId)}`),
      method: 'GET',
    })
    if (!response || response.status !== 200) {
      throw buildSpaceAccessApiError(response, i18n.t('space:access.errors.fetchMembershipsFailed'))
    }
    const responseData = response.data as SpaceAccessApiResponse<SpaceMembershipListResponse>
    if (!responseData?.success || !responseData.data?.memberships) {
      throw createSpaceAccessApiError(responseData, response.status, i18n.t('space:access.errors.fetchMembershipsInvalid'))
    }
    return responseData.data as SpaceMembershipListResponse
  }

  static async addSpaceMembership(projectId: string, payload: CreateSpaceMembershipRequest): Promise<SpaceMembership> {
    const response = await apiRequest({
      url: joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.PROJECT.MEMBERSHIPS(projectId)}`),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response || response.status !== 201) {
      throw buildSpaceAccessApiError(response, i18n.t('space:access.errors.addMembershipFailed'))
    }
    const responseData = response.data as SpaceAccessApiResponse<SpaceMembership>
    if (!responseData?.success || !responseData.data?.id) {
      throw createSpaceAccessApiError(responseData, response.status, i18n.t('space:access.errors.addMembershipInvalid'))
    }
    return responseData.data as SpaceMembership
  }

  static async removeSpaceMembership(projectId: string, membershipId: string): Promise<void> {
    const response = await apiRequest({
      url: joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.PROJECT.MEMBERSHIP_REMOVE(projectId, membershipId)}`),
      method: 'DELETE',
    })
    if (!response || response.status !== 200) {
      throw buildSpaceAccessApiError(response, i18n.t('space:access.errors.removeMembershipFailed'))
    }
    const responseData = response.data as SpaceAccessApiResponse<null>
    if (!responseData?.success) {
      throw createSpaceAccessApiError(responseData, response.status, i18n.t('space:access.errors.removeMembershipFailed'))
    }
  }

  /** ：可用工具列表走工作空间正式路径（执行现场能力）。 */
  static async listAvailableTools(workspaceId: string): Promise<AvailableToolsResponse> {
    const response = await apiRequest({
      url: joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.WORKSPACE.AVAILABLE_TOOLS(workspaceId)}`),
      method: 'GET',
    })
    if (!response || response.status !== 200) {
      throw buildSpaceAccessApiError(response, i18n.t('space:access.errors.fetchToolsFailed', { defaultValue: '获取工具列表失败' }))
    }
    const responseData = response.data as SpaceAccessApiResponse<AvailableToolsResponse>
    if (!responseData?.success || !responseData.data?.tools) {
      throw createSpaceAccessApiError(
        responseData,
        response.status,
        i18n.t('space:access.errors.fetchToolsInvalid', { defaultValue: '工具列表数据格式错误' }),
      )
    }
    return responseData.data as AvailableToolsResponse
  }
}
