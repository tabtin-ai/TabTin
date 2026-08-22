/**
 * API 适配器实例
 * 通过 @tabtin/table-host-runtime 统一初始化所有 runtime ports
 */

import { getApiAdapter } from '@tabtin/smartsheet-adapter-electron/renderer'
import {
  requireTableApiPort,
  setTableFetch,
  DEFAULT_TABLE_DATA_ENDPOINTS,
  type TableApiPort,
  type TableHttpRequest,
  type TableHttpResponse,
} from '@tabtin/table-core'
import { initializeTableHostRuntime } from '@tabtin/table-host-runtime'
import apiService, { ApiError, extractRetryAfterFromResponse } from '@/services/api'
import i18n from '@/i18n'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { electronSaveBlob } from '@/services/tableCoreRuntime'
import { electronFetch } from '@/services/electronFetch'
import { requestWithSessionGuard } from './request-session-guard'
import { createLogger } from '@/utils/logger'

const log = createLogger('TableApiPort')

const WINDOW_ID_STORAGE_KEY = 'tabtin:renderer-window-id'

const generateWindowId = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `electron-${Date.now()}-${Math.random().toString(36).slice(2)}`

/**
 * 窗口 id 用 sessionStorage 持久化：同一窗口刷新 / HMR reload 后保持不变，
 * 后端按 X-Window-Id 隔离的撤回栈才不会因为换了新 id 而变成孤儿（按钮永远灰）。
 * sessionStorage 按 top-level 浏览上下文隔离，多窗口天然各自独立。
 * 不可用时退回一次性随机值（至少同次加载内读写一致）。
 */
const resolveStableWindowId = (): string => {
  try {
    const store = globalThis.sessionStorage
    const existing = store?.getItem(WINDOW_ID_STORAGE_KEY)
    if (existing && existing.trim()) {
      return existing
    }
    const generated = generateWindowId()
    store?.setItem(WINDOW_ID_STORAGE_KEY, generated)
    return generated
  } catch {
    return generateWindowId()
  }
}

const RENDERER_WINDOW_ID = resolveStableWindowId()

export const initializeElectronApiAdapter = (): void => {
  const electronAdapter = getApiAdapter()

  const requestWithAutoRefresh = async <T = unknown>(
    options: TableHttpRequest
  ): Promise<TableHttpResponse<T>> => {
    const response = await electronAdapter.request<T>(options)

    if (response.status === 401) {
      log.info('收到 401，尝试刷新 Token 后重试...')
      const newToken = await apiService.tryRefreshTokens()
      if (newToken) {
        const retryOptions: TableHttpRequest = {
          ...options,
          headers: {
            ...options.headers,
            Authorization: `Bearer ${newToken}`,
          },
        }
        return electronAdapter.request<T>(retryOptions)
      }
    }

    return response
  }

  // 把 table-core 内部需要完整 Fetch 语义（FormData 导入导出 / 附件分片中转 /
  // 公开表单）的请求收口到主进程代理：electronFetch → window.tabtin.apiRequest →
  // 主进程 Node http，绕开生产包 renderer 自定义协议 origin 触发的业务 API CORS。
  setTableFetch(electronFetch)

  initializeTableHostRuntime({
    baseApiUrl: API_CONFIG.baseURL,
    windowId: RENDERER_WINDOW_ID,
    getAccessToken: () => electronAdapter.getAccessToken(),
    request: requestWithAutoRefresh,
    i18n: {
      t: (key: string, options?: Record<string, unknown>) =>
        String(i18n.t(key, options as any)),
    },
    file: {
      downloadBlob: electronSaveBlob,
    },
    endpoints: {
      ...DEFAULT_TABLE_DATA_ENDPOINTS,
      TABLE: API_ENDPOINTS.TABLE,
      VIEW: API_ENDPOINTS.VIEW,
      RECORD: API_ENDPOINTS.RECORD,
      FIELD: { ...DEFAULT_TABLE_DATA_ENDPOINTS.FIELD, ...API_ENDPOINTS.FIELD },
      LINK_FIELD: API_ENDPOINTS.LINK_FIELD,
      LLM_CATALOG: API_ENDPOINTS.LLM_CATALOG,
      // 与 FIELD 同款：默认表端点（含 ACCESS_URL）与宿主覆盖合并，避免 tip dist 漂移挡 typecheck
      ATTACHMENT: { ...DEFAULT_TABLE_DATA_ENDPOINTS.ATTACHMENT, ...API_ENDPOINTS.ATTACHMENT },
      IMPORT_EXPORT: API_ENDPOINTS.IMPORT_EXPORT,
      UNDO_REDO: API_ENDPOINTS.UNDO_REDO,
    },
  })
}

export function getAppApiAdapter(): TableApiPort {
  return requireTableApiPort()
}

export async function apiRequest<T = any>(options: TableHttpRequest): Promise<TableHttpResponse<T>> {
  const adapter = getAppApiAdapter()

  // ：401 走会话守卫——刷新成功重试一次；刷新失败（确定性会话过期，
  // 登出链路已在 tryRefreshTokens 内部触发）抛明确的「登录已过期」错误，
  // 让 app-shell service（如 AgentApiService.updateAgent）的调用方不再
  // 显示通用「更新失败」。
  const response = await requestWithSessionGuard<T>(
    {
      request: (opts) => adapter.request<T>(opts),
      tryRefreshTokens: () => apiService.tryRefreshTokens(),
      createSessionExpiredError: (data) =>
        new ApiError(i18n.t('common:errors.authExpired'), 401, data),
    },
    options,
  )

  // Wave 2A:命中限流时立即抛 ApiError 携带 retryAfter,业务层(useTrackerStore 等)
  // catch 后用动态秒数冷却,替代硬编码 5s。
  // 协议 §3.1 读取优先级:body.retry_after_seconds → Retry-After header → undefined。
  // 仅对 429 抛错;其它 status>=400 仍返回 response 由调用方自决(保持向后兼容)。
  if (response.status === 429) {
    const retryAfter = extractRetryAfterFromResponse(response as any)
    const data = response.data as any
    const message = (data && typeof data === 'object' && data.message)
      ? String(data.message)
      : `HTTP 429 Too Many Requests`
    throw new ApiError(message, 429, data, retryAfter)
  }

  return response
}

export async function getAuthToken(): Promise<string> {
  const adapter = getAppApiAdapter()
  const token = await adapter.getAccessToken()
  if (!token) {
    throw new Error(i18n.t('auth:errors.unauthorized'))
  }
  return token
}
