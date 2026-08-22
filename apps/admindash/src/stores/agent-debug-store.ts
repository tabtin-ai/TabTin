/**
 * Agent Debug 状态管理
 * 管理 Trace 和 Event 的全局状态
 */

import { agentDebugApi } from '@/api/agent-debug'
import type {
  Event,
  EventNode,
  ThreadListFilter,
  ThreadSummary,
  Trace,
  TraceFilter,
} from '@/types/agent-debug'
import { create } from 'zustand'

interface AgentDebugState {
  // Thread 列表（新增）
  threads: ThreadSummary[]
  threadsPagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
  threadsLoading: boolean
  threadsError: string | null

  // 当前选中的 Thread（新增）
  currentThread: ThreadSummary | null
  currentThreadLoading: boolean
  currentThreadError: string | null

  // Trace 列表
  traces: Trace[]
  tracesNextCursor: string | null // 游标分页（UUID）
  tracesLoading: boolean
  tracesError: string | null

  // 当前选中的 Trace
  currentTrace: Trace | null
  currentTraceLoading: boolean
  currentTraceError: string | null

  // 当前 Trace 的 Events
  events: Event[]
  eventsLoading: boolean
  eventsError: string | null
  eventTree: EventNode[] | null

  // 筛选条件
  filters: TraceFilter

  // Actions - Thread
  loadThreads: (filters?: ThreadListFilter) => Promise<void>
  loadThread: (threadId: string, options?: { silent?: boolean }) => Promise<boolean>

  // Actions - Trace
  loadTraces: (filters?: TraceFilter) => Promise<void>
  loadTrace: (traceId: string) => Promise<void>
  loadEvents: (traceId: string) => Promise<void>
  setFilters: (filters: TraceFilter) => void
  clearCurrentTrace: () => void
  clearCurrentThread: () => void
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const maybeError = error as { status?: unknown; message?: unknown }
  if (maybeError.status === 404) {
    return true
  }
  return typeof maybeError.message === 'string' && maybeError.message.includes('404')
}

function buildThreadsFromTraces(traces: Trace[]): ThreadSummary[] {
  const threadMap = new Map<string, ThreadSummary>()

  for (const trace of traces) {
    const key = trace.thread_id || trace.session_id || trace.trace_id
    let thread = threadMap.get(key)
    if (!thread) {
      thread = {
        threadId: key,
        sessionId: trace.session_id,
        sessionTitle: null,
        userId: trace.user_id ?? null,
        userName: null,
        userPhone: null,
        organizationId: trace.organization_id ?? null,
        organizationName: null,
        traces: [],
        traceCount: 0,
        firstStartedAt: trace.started_at,
        latestStartedAt: trace.started_at,
        totalDurationMs: 0,
        statusStats: { completed: 0, running: 0, error: 0 },
        totalToolCalls: 0,
        totalLLMCalls: 0,
      }
      threadMap.set(key, thread)
    }
    if (!thread.userId && trace.user_id) {
      thread.userId = trace.user_id
    }
    if (!thread.organizationId && trace.organization_id) {
      thread.organizationId = trace.organization_id
    }

    thread.traces.push(trace)
    thread.traceCount += 1

    if (new Date(trace.started_at) < new Date(thread.firstStartedAt)) {
      thread.firstStartedAt = trace.started_at
    }
    if (new Date(trace.started_at) > new Date(thread.latestStartedAt)) {
      thread.latestStartedAt = trace.started_at
    }

    if (trace.ended_at) {
      const durationMs = new Date(trace.ended_at).getTime() - new Date(trace.started_at).getTime()
      if (durationMs > 0) {
        thread.totalDurationMs += durationMs
      }
    }
    thread.statusStats[trace.status] += 1
  }

  return Array.from(threadMap.values()).sort(
    (a, b) => new Date(b.latestStartedAt).getTime() - new Date(a.latestStartedAt).getTime()
  )
}

function filterThreadSummaries(
  threads: ThreadSummary[],
  filters: ThreadListFilter
): ThreadSummary[] {
  const keyword = filters.keyword?.trim().toLowerCase()
  const userId = filters.userId?.trim().toLowerCase()
  const userName = filters.userName?.trim().toLowerCase()
  const organizationId = filters.organizationId?.trim().toLowerCase()
  const organizationName = filters.organizationName?.trim().toLowerCase()
  const sessionTitle = filters.sessionTitle?.trim().toLowerCase()
  const status = filters.status ?? 'all'
  return threads
    .filter((thread) => {
      if (!keyword) return true
      return (
        thread.threadId.toLowerCase().includes(keyword) ||
        thread.sessionId?.toLowerCase().includes(keyword)
      )
    })
    .filter((thread) => {
      if (!userId) return true
      return thread.userId?.toLowerCase().includes(userId) ?? false
    })
    .filter((thread) => {
      if (!userName) return true
      return thread.userName?.toLowerCase().includes(userName) ?? false
    })
    .filter((thread) => {
      if (!organizationId) return true
      return thread.organizationId?.toLowerCase().includes(organizationId) ?? false
    })
    .filter((thread) => {
      if (!organizationName) return true
      return thread.organizationName?.toLowerCase().includes(organizationName) ?? false
    })
    .filter((thread) => {
      if (!sessionTitle) return true
      return thread.sessionTitle?.toLowerCase().includes(sessionTitle) ?? false
    })
    .filter((thread) => {
      if (status === 'all') return true
      if (status === 'error') return thread.statusStats.error > 0
      if (status === 'running') return thread.statusStats.running > 0
      if (status === 'completed') {
        return (
          thread.statusStats.completed > 0 &&
          thread.statusStats.error === 0 &&
          thread.statusStats.running === 0
        )
      }
      return true
    })
}

/**
 * 构建 Event 树
 * 根据 parent_event_id 构建父子关系
 */
function buildEventTree(events: Event[]): EventNode[] {
  const eventMap = new Map<string, EventNode>() // 使用 UUID 作为 key
  const roots: EventNode[] = []

  // 第一遍：创建所有节点
  for (const event of events) {
    eventMap.set(event.id, {
      ...event,
      children: [],
      depth: 0,
      expanded: true, // 默认展开
    })
  }

  // 第二遍：建立父子关系并计算深度
  for (const event of events) {
    const node = eventMap.get(event.id)
    if (!node) {
      continue
    }
    if (event.parent_event_id !== null) {
      const parent = eventMap.get(event.parent_event_id)
      if (parent) {
        node.depth = parent.depth + 1
        parent.children.push(node)
      } else {
        // 找不到父节点，当作根节点
        roots.push(node)
      }
    } else {
      roots.push(node)
    }
  }

  // 按 seq 排序子节点
  function sortChildren(nodes: EventNode[]) {
    nodes.sort((a, b) => a.seq - b.seq)
    for (const node of nodes) {
      if (node.children.length > 0) {
        sortChildren(node.children)
      }
    }
  }
  sortChildren(roots)

  return roots
}

export const useAgentDebugStore = create<AgentDebugState>((set, get) => ({
  // 初始状态 - Thread
  threads: [],
  threadsPagination: {
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  },
  threadsLoading: false,
  threadsError: null,

  currentThread: null,
  currentThreadLoading: false,
  currentThreadError: null,

  // 初始状态 - Trace
  traces: [],
  tracesNextCursor: null,
  tracesLoading: false,
  tracesError: null,

  currentTrace: null,
  currentTraceLoading: false,
  currentTraceError: null,

  events: [],
  eventsLoading: false,
  eventsError: null,
  eventTree: null,

  filters: {
    limit: 50,
  },

  // 加载 Trace 列表
  loadTraces: async (filters?: TraceFilter) => {
    set({ tracesLoading: true, tracesError: null })
    try {
      const finalFilters = { ...get().filters, ...filters }
      const response = await agentDebugApi.getTraces(finalFilters)
      set({
        traces: response.items,
        tracesNextCursor: response.next_cursor,
        tracesLoading: false,
        filters: finalFilters,
      })
    } catch (error: unknown) {
      set({
        tracesLoading: false,
        tracesError: getErrorMessage(error, 'Failed to load traces'),
      })
    }
  },

  // 加载单个 Trace 详情
  loadTrace: async (traceId: string) => {
    set({ currentTraceLoading: true, currentTraceError: null })
    try {
      const trace = await agentDebugApi.getTrace(traceId)
      set({
        currentTrace: trace,
        currentTraceLoading: false,
      })
    } catch (error: unknown) {
      set({
        currentTraceLoading: false,
        currentTraceError: getErrorMessage(error, 'Failed to load trace'),
      })
    }
  },

  // 加载 Trace 的所有 Events
  loadEvents: async (traceId: string) => {
    set({ eventsLoading: true, eventsError: null })
    try {
      const response = await agentDebugApi.getAllTraceEvents(traceId)
      const tree = buildEventTree(response.items)
      set({
        events: response.items,
        eventTree: tree,
        eventsLoading: false,
      })
    } catch (error: unknown) {
      set({
        eventsLoading: false,
        eventsError: getErrorMessage(error, 'Failed to load events'),
      })
    }
  },

  // 设置筛选条件
  setFilters: (filters: TraceFilter) => {
    set({ filters: { ...get().filters, ...filters } })
  },

  // 清除当前 Trace
  clearCurrentTrace: () => {
    set({
      currentTrace: null,
      events: [],
      eventTree: null,
    })
  },

  // 加载 Thread 列表（服务端按 thread_id 聚合并分页）
  loadThreads: async (filters?: ThreadListFilter) => {
    set({ threadsLoading: true, threadsError: null })
    try {
      const finalFilters = {
        page: get().threadsPagination.page,
        pageSize: get().threadsPagination.pageSize,
        ...filters,
      }
      const response = await agentDebugApi.getThreads(finalFilters)
      const threads: ThreadSummary[] = response.items.map((item) => ({
        threadId: item.thread_id,
        sessionId: item.session_id,
        sessionTitle: item.session_title ?? null,
        userId: item.user_id ?? null,
        userName: item.user_name ?? null,
        userPhone: item.user_phone ?? null,
        organizationId: item.organization_id ?? null,
        organizationName: item.organization_name ?? null,
        traces: [],
        traceCount: item.trace_count,
        firstStartedAt: item.first_started_at,
        latestStartedAt: item.latest_started_at,
        totalDurationMs: item.total_duration_ms,
        statusStats: item.status_stats,
        totalToolCalls: item.total_tool_calls,
        totalLLMCalls: item.total_llm_calls,
      }))

      set({
        threads,
        threadsPagination: {
          page: response.pagination.page,
          pageSize: response.pagination.page_size,
          total: response.pagination.total,
          totalPages: response.pagination.total_pages,
        },
        threadsLoading: false,
      })
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        try {
          const finalFilters = {
            page: get().threadsPagination.page,
            pageSize: get().threadsPagination.pageSize,
            ...filters,
          }
          const response = await agentDebugApi.getTraces({ limit: 200 })
          const fallbackThreads = filterThreadSummaries(
            buildThreadsFromTraces(response.items),
            finalFilters
          )
          const pageSize = finalFilters.pageSize ?? 20
          const totalPages = Math.ceil(fallbackThreads.length / pageSize)
          const page = Math.min(finalFilters.page ?? 1, totalPages || 1)
          const offset = (page - 1) * pageSize

          set({
            threads: fallbackThreads.slice(offset, offset + pageSize),
            threadsPagination: {
              page,
              pageSize,
              total: fallbackThreads.length,
              totalPages,
            },
            threadsLoading: false,
          })
          return
        } catch (fallbackError: unknown) {
          set({
            threadsLoading: false,
            threadsError: getErrorMessage(fallbackError, 'Failed to load threads'),
          })
          return
        }
      }
      set({
        threadsLoading: false,
        threadsError: getErrorMessage(error, 'Failed to load threads'),
      })
    }
  },

  // 加载单个 Thread 详情；silent 用于页内手动刷新，避免整页 loading / 失败时清空已有内容
  loadThread: async (threadId: string, options?: { silent?: boolean }) => {
    const silent = options?.silent === true
    if (!silent) {
      set({ currentThreadLoading: true, currentThreadError: null })
    }
    try {
      // 与会话列表保持同一服务端过滤口径，避免老会话不在最近 200 条 trace 时详情打不开。
      const response = await agentDebugApi.getThreadTraces(threadId)
      const threadTraces = response.items

      if (threadTraces.length === 0) {
        throw new Error('Thread not found')
      }

      // 计算 Thread 摘要
      const thread: ThreadSummary = {
        threadId,
        sessionId: threadTraces[0].session_id,
        sessionTitle: null,
        userId: threadTraces[0].user_id ?? null,
        userName: null,
        userPhone: null,
        organizationId: threadTraces[0].organization_id ?? null,
        organizationName: null,
        traces: threadTraces,
        traceCount: threadTraces.length,
        firstStartedAt: threadTraces[0].started_at,
        latestStartedAt: threadTraces[0].started_at,
        totalDurationMs: 0,
        statusStats: { completed: 0, running: 0, error: 0 },
        totalToolCalls: 0,
        totalLLMCalls: 0,
      }

      for (const trace of threadTraces) {
        if (new Date(trace.started_at) < new Date(thread.firstStartedAt)) {
          thread.firstStartedAt = trace.started_at
        }
        if (new Date(trace.started_at) > new Date(thread.latestStartedAt)) {
          thread.latestStartedAt = trace.started_at
        }
        if (trace.ended_at) {
          const durationMs =
            new Date(trace.ended_at).getTime() - new Date(trace.started_at).getTime()
          if (durationMs > 0) {
            thread.totalDurationMs += durationMs
          }
        }
        thread.statusStats[trace.status] += 1
      }

      set({
        currentThread: thread,
        currentThreadLoading: false,
        currentThreadError: null,
      })
      return true
    } catch (error: unknown) {
      if (silent) {
        set({ currentThreadLoading: false })
      } else {
        set({
          currentThreadLoading: false,
          currentThreadError: getErrorMessage(error, 'Failed to load thread'),
        })
      }
      return false
    }
  },

  // 清除当前 Thread
  clearCurrentThread: () => {
    set({
      currentThread: null,
    })
  },
}))
