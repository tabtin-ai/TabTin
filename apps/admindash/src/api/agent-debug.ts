/**
 * Agent Debug API 客户端
 * 管理员端点（超级管理员）
 */

import type {
  Event,
  EventListResponse,
  ThreadChatMessagesExport,
  ThreadListFilter,
  ThreadListResponse,
  ThreadOverview,
  Trace,
  TraceFilter,
  TraceListResponse,
} from '@/types/agent-debug'
import { getApiClient } from './tabtin-client'

const BASE_PATH = '/orchestration/debug'

export const agentDebugApi = {
  /**
   * 查询会话摘要（管理员）
   * GET /orchestration/debug/threads
   */
  getThreads: async (filters?: ThreadListFilter): Promise<ThreadListResponse> => {
    const params: Record<string, string | number | boolean | undefined | null> = {}
    if (filters?.keyword) {
      params.keyword = filters.keyword
    }
    if (filters?.user) {
      params.user = filters.user
    } else {
      if (filters?.userId) {
        params.user_id = filters.userId
      }
      if (filters?.userName) {
        params.user_name = filters.userName
      }
    }
    if (filters?.organization) {
      params.organization = filters.organization
    } else {
      if (filters?.organizationId) {
        params.organization_id = filters.organizationId
      }
      if (filters?.organizationName) {
        params.organization_name = filters.organizationName
      }
    }
    if (filters?.sessionTitle) {
      params.session_title = filters.sessionTitle
    }
    if (filters?.status && filters.status !== 'all') {
      params.status = filters.status
    }
    if (filters?.page) {
      params.page = filters.page
    }
    if (filters?.pageSize) {
      params.page_size = filters.pageSize
    }
    return getApiClient().raw<ThreadListResponse>('GET', `${BASE_PATH}/threads`, {
      params: Object.keys(params).length > 0 ? params : undefined,
    })
  },

  getThreadOverview: async (threadId: string, messageLimit = 200): Promise<ThreadOverview> => {
    return getApiClient().raw<ThreadOverview>(
      'GET',
      `${BASE_PATH}/threads/${encodeURIComponent(threadId)}/overview`,
      { params: { message_limit: messageLimit } }
    )
  },

  /**
   * 导出落库 chat_message（含 content_blocks_json）
   * GET /orchestration/debug/threads/{thread_id}/chat-messages
   */
  getThreadChatMessages: async (
    threadId: string,
    messageLimit = 500,
    snapshotLimit = 100
  ): Promise<ThreadChatMessagesExport> => {
    return getApiClient().raw<ThreadChatMessagesExport>(
      'GET',
      `${BASE_PATH}/threads/${encodeURIComponent(threadId)}/chat-messages`,
      { params: { message_limit: messageLimit, snapshot_limit: snapshotLimit } }
    )
  },

  getThreadTraces: async (threadId: string): Promise<TraceListResponse> => {
    return getApiClient().raw<TraceListResponse>(
      'GET',
      `${BASE_PATH}/threads/${encodeURIComponent(threadId)}/traces`
    )
  },

  /**
   * 查询所有 Trace（管理员）
   * GET /orchestration/debug/traces
   */
  getTraces: async (filters?: TraceFilter): Promise<TraceListResponse> => {
    const params: Record<string, string | number | boolean | undefined | null> = {}
    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null) {
          params[key] = value
        }
      }
    }
    return getApiClient().raw<TraceListResponse>('GET', `${BASE_PATH}/traces`, {
      params: Object.keys(params).length > 0 ? params : undefined,
    })
  },

  /**
   * 获取 Trace 详情（管理员）
   * GET /orchestration/debug/traces/{trace_id}
   */
  getTrace: async (traceId: string): Promise<Trace> => {
    return getApiClient().raw<Trace>('GET', `${BASE_PATH}/traces/${traceId}`)
  },

  /**
   * 获取 Trace 的 Event 列表（管理员）
   * GET /orchestration/debug/traces/{trace_id}/events
   *
   * @param traceId Trace UUID
   * @param cursor 游标（Event ID），可选
   * @param limit 每页数量，默认 200
   */
  getTraceEvents: async (
    traceId: string,
    cursor?: string,
    limit = 200
  ): Promise<EventListResponse> => {
    const params: Record<string, string | number | boolean | undefined | null> = {
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
    }
    return getApiClient().raw<EventListResponse>('GET', `${BASE_PATH}/traces/${traceId}/events`, {
      params,
    })
  },

  /**
   * 获取所有 Events（自动分页）
   * 内部会循环调用 getTraceEvents 直到 next_cursor = null
   */
  getAllTraceEvents: async (traceId: string): Promise<EventListResponse> => {
    let allEvents: Event[] = []
    let cursor: string | undefined = undefined

    while (true) {
      const response = await agentDebugApi.getTraceEvents(traceId, cursor, 500)
      allEvents = allEvents.concat(response.items)

      if (response.next_cursor === null) {
        break
      }
      cursor = response.next_cursor
    }

    return {
      items: allEvents,
      next_cursor: null,
    }
  },

  // --- Phase 2: 增强 Debug API ---

  getPromptSnapshots: async (traceId: string): Promise<EventListResponse> => {
    return getApiClient().raw<EventListResponse>(
      'GET',
      `${BASE_PATH}/traces/${traceId}/prompt-snapshots`
    )
  },

  getMiddlewareTiming: async (traceId: string): Promise<MiddlewareTimingResponse> => {
    return getApiClient().raw<MiddlewareTimingResponse>(
      'GET',
      `${BASE_PATH}/traces/${traceId}/middleware-timing`
    )
  },

  getTraceErrors: async (traceId: string): Promise<EventListResponse> => {
    return getApiClient().raw<EventListResponse>('GET', `${BASE_PATH}/traces/${traceId}/errors`)
  },

  getThreadState: async (threadId: string): Promise<ThreadStateResponse> => {
    return getApiClient().raw<ThreadStateResponse>('GET', `${BASE_PATH}/threads/${threadId}/state`)
  },

  getErrorStats: async (hours = 24): Promise<ErrorStatsResponse> => {
    return getApiClient().raw<ErrorStatsResponse>('GET', `${BASE_PATH}/stats/errors`, {
      params: { hours },
    })
  },

  toggleDebugMode: async (
    threadId: string,
    enabled: boolean
  ): Promise<{ thread_id: string; debug_mode: boolean }> => {
    return getApiClient().raw<{ thread_id: string; debug_mode: boolean }>(
      'POST',
      `${BASE_PATH}/threads/${threadId}/debug-mode`,
      { body: { enabled } }
    )
  },

  getHealthCheck: async (): Promise<AgentHealthResponse> => {
    return getApiClient().raw<AgentHealthResponse>('GET', '/orchestration/health')
  },
}

// --- Phase 2: 新增类型 ---

export interface MiddlewareTimingResponse {
  thread_id: string
  middleware_timing: Record<string, Record<string, number>>
}

export interface ThreadStateResponse {
  thread_id: string
  messages_count: number
  messages_roles: Record<string, number>
  state_keys: string[]
  state: Record<string, unknown>
}

export interface ErrorStatsResponse {
  period_hours: number
  total_errors: number
  by_category: Record<string, number>
  total_traces: number
  error_traces: number
  error_rate: number
}

export interface AgentHealthResponse {
  redis: string
  postgresql: string
  // W10: ``agents`` / ``tools`` / ``middleware_count`` were removed from the
  // backend health endpoint together with the builtin ReAct engine. Agent
  // execution health is now reported by client-side runtime (Electron /
  // Daemon) via the relay event stream — AdminDash只展示 Django 自身依赖。
  agents?: Record<string, string>
  tools?: Record<string, { status: string; sanitized_name?: string } | string>
  middleware_count?: number
}
