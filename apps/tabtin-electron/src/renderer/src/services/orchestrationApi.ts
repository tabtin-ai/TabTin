/**
 * Orchestration API — unified HTTP client for /api/orchestration/* endpoints.
 *
 * ⚠️ DEPRECATED (L2): Django 编排层已下线，本地 Runtime 接管。
 * 下方函数保留签名兼容，但在 ORCHESTRATION_OFFLINE=true 时直接返回安全默认值，
 * 避免对已摘除路由的无谓 404 请求。orchestrationClient 仍被
 * subagentTemplateApi.ts 等模块引用，待后续迁移到独立 API 后移除。
 */

import { joinApiPath } from '@tabtin/config'
import { API_CONFIG } from '../config/api'
import { useAuthStore, authReadyPromise } from '../stores/useAuthStore'
import { electronFetch } from './electronFetch'
import type { SubagentStatus } from '../stores/chat/shared/types'

const ORCHESTRATION_OFFLINE = true

// ─── Internal helpers ──────────────────────────────────────────────────

/**
 * Async token resolver — if the store has no token yet (e.g. right after
 * page refresh before loadAuthFromStorage completes), we await the
 * one-time authReadyPromise instead of failing immediately.
 */
async function resolveToken(): Promise<string> {
  let token = useAuthStore.getState().accessToken
  if (token) return token

  await authReadyPromise

  token = useAuthStore.getState().accessToken
  if (!token) throw new Error('Missing auth token')
  return token
}

async function buildHeaders(tokenOverride?: string): Promise<Record<string, string>> {
  const t = tokenOverride ?? await resolveToken()
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }
}

/**
 * Unified response parser.
 * Handles both flat JSON and `{ success, data, code }` wrapper format.
 */
async function parseResponse<T>(resp: Response): Promise<T> {
  let body: any = null
  try { body = await resp.json() } catch { body = null }

  const isWrapped = body && typeof body === 'object' && 'data' in body && 'code' in body
  const data = isWrapped ? body.data : body
  const errorDetail = data?.message || data?.detail || body?.message || body?.detail

  if (!resp.ok) {
    throw new Error(errorDetail || `HTTP ${resp.status}`)
  }
  if (data && typeof data === 'object' && 'success' in data && !data.success) {
    throw new Error(errorDetail || 'Request failed')
  }
  if (data == null && resp.status !== 204) {
    throw new Error('Invalid or empty response')
  }
  return data as T
}

// ─── Orchestration HTTP Client ─────────────────────────────────────────

interface RequestOptions {
  signal?: AbortSignal
  /** Override the auto-resolved token (e.g. when caller uses ensureAccessToken). */
  token?: string
}

/**
 * Lightweight HTTP client scoped to `/orchestration` endpoints.
 * All `path` arguments are relative:
 *   `/runs/123` → `${API_CONFIG.baseURL}/orchestration/runs/123`
 */
export const orchestrationClient = {
  async get<T>(path: string, opts?: RequestOptions): Promise<T> {
    const resp = await electronFetch(joinApiPath(API_CONFIG.baseURL, `/orchestration${path}`), {
      headers: await buildHeaders(opts?.token),
      signal: opts?.signal,
    })
    return parseResponse<T>(resp)
  },

  async post<T = void>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    const resp = await electronFetch(joinApiPath(API_CONFIG.baseURL, `/orchestration${path}`), {
      method: 'POST',
      headers: await buildHeaders(opts?.token),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: opts?.signal,
    })
    return parseResponse<T>(resp)
  },

  async put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    const resp = await electronFetch(joinApiPath(API_CONFIG.baseURL, `/orchestration${path}`), {
      method: 'PUT',
      headers: await buildHeaders(opts?.token),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: opts?.signal,
    })
    return parseResponse<T>(resp)
  },

  async delete(path: string, opts?: RequestOptions): Promise<void> {
    const resp = await electronFetch(joinApiPath(API_CONFIG.baseURL, `/orchestration${path}`), {
      method: 'DELETE',
      headers: await buildHeaders(opts?.token),
      signal: opts?.signal,
    })
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`
      try {
        const errBody = await resp.json()
        detail = errBody?.detail || errBody?.message || detail
      } catch { /* noop */ }
      throw new Error(detail)
    }
  },
}

// ─── Subagent ──────────────────────────────────────────────────────────
// W5-a（2026-05-30）：旧 `cancelSubagent`（POST /subagent/:id/cancel，编排层下线后
// 恒返回 false 的死路）已删除——子 Agent 取消改走 renderer 的 WS gateway
// `subagent.cancel` 上行（见 useChatRuntimeStore.cancelSubagentRun），不再走 HTTP。

/**
 * 取消指定 session 下所有活跃的 run。
 * 用于 checkpoint 回滚前确保后端 Agent 已停止。
 */
export async function cancelActiveRunForSession(sessionId: string): Promise<boolean> {
  if (ORCHESTRATION_OFFLINE) return true
  try {
    const threadId = `chat-session-${sessionId}`
    const data = await orchestrationClient.get<{ items: Array<{ run_id: string }> }>(
      `/runs?thread_id=${encodeURIComponent(threadId)}&status=running&limit=10`,
    )
    const runs = data?.items
    if (!Array.isArray(runs) || runs.length === 0) return true

    await Promise.allSettled(
      runs.map(run =>
        orchestrationClient.post(`/runs/${run.run_id}/cancel`, { reason: 'checkpoint_rollback' }),
      ),
    )
    return true
  } catch {
    return false
  }
}

interface ServerSubagentItem {
  subagent_run_id: string
  status: string
  task?: string
  label?: string
  app_id?: string
  child_thread_id?: string
  result_summary?: string
  error?: string
  stats?: Record<string, unknown>
  started_at?: unknown
  ended_at?: unknown
}

const STATUS_MAP: Record<string, SubagentStatus> = {
  pending: 'pending', running: 'running', completed: 'completed',
  error: 'failed', failed: 'failed', timeout: 'failed',
  cancelled: 'cancelled', archived: 'completed',
}

function parseTimestampToSeconds(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value === 'number') {
    return value > 1e12 ? value / 1000 : value
  }
  if (typeof value === 'string') {
    const ms = new Date(value).getTime()
    return Number.isNaN(ms) ? undefined : ms / 1000
  }
  return undefined
}

export interface NormalizedSubagentRun {
  subagentRunId: string
  status: SubagentStatus
  task?: string
  label?: string
  appId?: string
  childThreadId?: string
  summary?: string
  error?: string
  stats?: Record<string, unknown>
  startedAt?: number
  endedAt?: number
}

export async function fetchSubagentRuns(threadId: string): Promise<NormalizedSubagentRun[]> {
  if (ORCHESTRATION_OFFLINE) return []
  try {
    const data = await orchestrationClient.get<{ items: ServerSubagentItem[] }>(
      `/subagents?parent_thread_id=${encodeURIComponent(threadId)}&limit=50`,
    )
    const items = Array.isArray(data?.items) ? data.items : []
    return items
      .filter(item => item.subagent_run_id)
      .map(item => ({
        subagentRunId: item.subagent_run_id,
        status: STATUS_MAP[item.status] || 'pending',
        task: item.task,
        label: item.label,
        appId: item.app_id,
        childThreadId: item.child_thread_id,
        summary: item.result_summary,
        error: item.error,
        stats: item.stats,
        startedAt: parseTimestampToSeconds(item.started_at),
        endedAt: parseTimestampToSeconds(item.ended_at),
      }))
  } catch {
    return []
  }
}

// ─── Tool Retry ────────────────────────────────────────────────────────

export async function retryToolCall(
  sessionId: string,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ success: boolean; tool_call_id?: string; result?: unknown; error?: string }> {
  if (ORCHESTRATION_OFFLINE) return { success: false, error: '本地模式暂不支持工具重试，请重新发送消息' }
  return orchestrationClient.post('/tool-retry', {
    session_id: sessionId,
    tool_call_id: toolCallId,
    tool_name: toolName,
    args,
  })
}

// ─── Session Status ────────────────────────────────────────────────────

export async function fetchSessionStatus(sessionId: string): Promise<{
  status: string
  run_id?: string
  last_event_at?: string
}> {
  if (ORCHESTRATION_OFFLINE) return { status: 'idle' }
  const threadId = `chat-session-${sessionId}`
  return orchestrationClient.get(
    `/agent/session-status?thread_id=${encodeURIComponent(threadId)}`,
  )
}
