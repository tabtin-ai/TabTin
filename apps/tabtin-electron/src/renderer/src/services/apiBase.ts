import { apiRequest as adapterApiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import i18n from '@/i18n'
import { createLogger } from '@/utils/logger'

const log = createLogger('ApiBase')

export async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const token = await getAuthToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch (error) {
    // 拿不到 token → 降级为无鉴权头（后端会 401），记录以便诊断"请求为何没带 token"。
    log.warn(i18n.t('common:logs.tokenFetchFailed'), error)
    return {}
  }
}

export async function apiRequest(options: {
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  headers?: Record<string, string>
  body?: string
}): Promise<any> {
  const authHeaders = await getAuthHeaders()
  return adapterApiRequest({
    ...options,
    headers: {
      ...authHeaders,
      ...options.headers,
    },
  })
}

/**
 * 服务被组织管理员禁用时抛出的错误，携带结构化信息便于前端精确处理。
 */
export class ServiceDisabledError extends Error {
  readonly code = 'SERVICE_DISABLED' as const
  readonly serviceKey: string
  readonly organizationId: string

  constructor(message: string, serviceKey: string, organizationId: string) {
    super(message)
    this.name = 'ServiceDisabledError'
    this.serviceKey = serviceKey
    this.organizationId = organizationId
  }
}

type ErrorResponseBody = {
  detail?: string
  message?: string
  code?: string
  data?: { service_key?: string; organization_id?: string }
}

/**
 * 检查响应体是否为 SERVICE_DISABLED 错误，是则抛出 ServiceDisabledError。
 */
const throwIfServiceDisabled = (body: ErrorResponseBody | undefined): void => {
  if (body?.code === 'SERVICE_DISABLED') {
    throw new ServiceDisabledError(
      body.message || i18n.t('settings:organizationServices.serviceDisabled'),
      body.data?.service_key || '',
      body.data?.organization_id || '',
    )
  }
}

/**
 * 校验 HTTP 200 后直接返回 response.data。
 * 适用于后端直接返回数据（非 {success, data} 包裹）的接口。
 */
export const ensureSuccessResponse = <T>(response: any, fallbackMessage: string): T => {
  if (!response || response.status !== 200) {
    const body = response?.data as ErrorResponseBody | undefined
    throwIfServiceDisabled(body)
    throw new Error(body?.message || fallbackMessage)
  }
  return response.data as T
}

type StandardResponse<T> = {
  success: boolean
  message?: string
  data?: T
  code?: string
}

/**
 * 校验 HTTP 200 + data.success + data.data 后返回内层 data。
 * 适用于后端返回 {success, message, data} 包裹的接口。
 */
export const unwrapData = <T>(response: any, fallbackMessage: string): T => {
  if (!response || response.status !== 200) {
    const body = response?.data as ErrorResponseBody | undefined
    throwIfServiceDisabled(body)
    throw new Error(body?.detail || body?.message || fallbackMessage)
  }

  const data = response.data as StandardResponse<T>
  if (!data?.success || data.data === undefined) {
    throwIfServiceDisabled(data as unknown as ErrorResponseBody)
    throw new Error(
      (data as unknown as ErrorResponseBody)?.detail || data?.message || fallbackMessage,
    )
  }
  return data.data
}
