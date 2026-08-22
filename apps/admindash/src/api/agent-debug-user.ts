/**
 * Agent Debug API 客户端 - 用户端点
 * 普通用户只能访问自己的数据
 */

import type {
  Event,
  EventListResponse,
  Trace,
  TraceFilter,
  TraceListResponse,
} from '@/types/agent-debug'
import { getApiClient } from './tabtin-client'

const USER_BASE_PATH = '/orchestration/user'

export const agentDebugUserApi = {
  /**
   * 查询自己的 Trace（普通用户）
   * GET /orchestration/user/traces
   */
  getMyTraces: async (filters?: TraceFilter): Promise<TraceListResponse> => {
    return getApiClient().raw<TraceListResponse>('GET', `${USER_BASE_PATH}/traces`, {
      params: filters as Record<string, string | number | boolean | undefined | null>,
    })
  },

  /**
   * 获取自己的 Trace 详情（普通用户）
   * GET /orchestration/user/traces/{trace_id}
   */
  getMyTrace: async (traceId: string): Promise<Trace> => {
    return getApiClient().raw<Trace>('GET', `${USER_BASE_PATH}/traces/${traceId}`)
  },

  /**
   * 获取自己的 Trace 的 Event 列表（普通用户）
   * GET /orchestration/user/traces/{trace_id}/events
   */
  getMyTraceEvents: async (
    traceId: string,
    cursor?: string,
    limit = 200
  ): Promise<EventListResponse> => {
    return getApiClient().raw<EventListResponse>(
      'GET',
      `${USER_BASE_PATH}/traces/${traceId}/events`,
      {
        params: { limit, cursor },
      }
    )
  },

  /**
   * 获取所有 Events（自动分页，普通用户）
   */
  getAllMyTraceEvents: async (traceId: string): Promise<EventListResponse> => {
    let allEvents: Event[] = []
    let cursor: string | undefined = undefined

    while (true) {
      const response = await agentDebugUserApi.getMyTraceEvents(traceId, cursor, 500)
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
}
