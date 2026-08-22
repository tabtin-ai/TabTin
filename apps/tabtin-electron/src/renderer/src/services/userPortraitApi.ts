/**
 * UserPortrait API 服务（/#4118 画像 per-Agent 化）
 *
 * 封装与后端 user_portrait 模块的端点（每个端点必须带 organizationId + agentId）：
 *   GET    /user-portrait/me/{organization_id}?agent_id=...                获取当前用户在指定 (Organization, Agent) 的画像
 *   POST   /user-portrait/me/{organization_id}/hint?agent_id=...           提交 hint（D7：实时触发蒸馏）
 *   POST   /user-portrait/me/{organization_id}/distill?agent_id=...        主动触发蒸馏
 *   GET    /user-portrait/me/{organization_id}/snapshots?agent_id=...      画像历史快照
 *
 * 错误码（来自后端 ErrorCode）：
 *   PORTRAIT_NOT_FOUND / INVALID_HINT / INVALID_ORGANIZATION_ID / INVALID_AGENT_ID /
 *   AGENT_ACCESS_DENIED / MEMORY_DISABLED / INVALID_INPUT / DISTILL_IN_PROGRESS /
 *   DISTILL_FAILED / UNAUTHORIZED / PERMISSION_DENIED
 *
 * 画像 per-Agent 化关键变更：
 *   - 所有方法必须传 organizationId + agentId——画像按 Agent 完全隔离，
 *     不再是 per-(user, organization) 共用一份。
 *   - GET 允许 agentId 为空字符串（过渡兼容旧调用点）：后端 fail-closed 返回
 *     空画像（不落库、不泄漏跨 Agent 数据），不是错误。
 *   - 不存在"调整 Organization 范围"功能（决策已删除）
 */

import { joinApiPath } from '@tabtin/config'
import { API_CONFIG } from '@/config/api'
import { apiRequest as adapterApiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import { createLogger } from '@/utils/logger'

const log = createLogger('UserPortraitApi')

const BASE = '/user-portrait'

// ── 类型 ──────────────────────────────────────────

export type DistillStatus = 'idle' | 'pending' | 'failed'

export interface UserPortrait {
  id: string
  user_id: string
  organization_id: string
  /** 画像所属 Agent；空字符串表示旧过渡态请求（未传 agentId）返回的 fail-closed 空画像 */
  agent_id: string
  /** 5 段 markdown 叙事；空字符串表示未蒸馏或记忆总闸关闭 */
  content_md: string
  version: number
  /** ISO 时间字符串；null 表示从未蒸馏 */
  last_distilled_at: string | null
  last_distill_status: DistillStatus
  last_distill_error: string
  pending_hints_count: number
  /** 记忆总闸是否开启；关闭时 content_md 恒为空，用于区分"真的空"与"关闭看不到" */
  memory_enabled: boolean
  created_at: string
  updated_at: string
  /** 仅 hint 端点会附带 */
  soft_warning?: string
  /** 仅 hint / distill 端点会附带 */
  distill_dispatched?: boolean
  /** 仅 distill 端点会附带 */
  accepted?: boolean
  /** 仅 distill 端点会附带 */
  message?: string
}

export interface PortraitSnapshot {
  id: string
  version_at_snapshot: number
  content_md: string
  trigger_reason: 'scheduled' | 'hint' | 'manual'
  input_summary: Record<string, unknown>
  created_at: string
}

export interface SnapshotListResponse {
  items: PortraitSnapshot[]
  count: number
}

// ── 错误处理 ──────────────────────────────────────

export class UserPortraitApiError extends Error {
  readonly statusCode: number
  readonly errorCode?: string

  constructor(message: string, statusCode: number, errorCode?: string) {
    super(message)
    this.name = 'UserPortraitApiError'
    this.statusCode = statusCode
    this.errorCode = errorCode
  }
}

interface ApiResponse<T = unknown> {
  success: boolean
  code?: string
  message?: string
  data?: T
  error?: { code: string; message: string }
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const token = await getAuthToken()
    if (token) return { Authorization: `Bearer ${token}` }
    return {}
  } catch (err) {
    log.warn('failed to get auth token:', err)
    return {}
  }
}

async function request<T>(opts: {
  path: string
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  params?: Record<string, string | number | boolean | undefined>
}): Promise<T> {
  const url = new URL(joinApiPath(API_CONFIG.baseURL, `${BASE}${opts.path}`))
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
    }
  }

  const authHeaders = await getAuthHeaders()
  const headers: Record<string, string> = { ...authHeaders }
  if (opts.method !== 'GET') {
    headers['Content-Type'] = 'application/json'
  }

  const response = await adapterApiRequest<ApiResponse<T>>({
    url: url.toString(),
    method: opts.method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })

  const body = response.data
  if (!body?.success) {
    const message = body?.message || body?.error?.message || body?.code || 'Request failed'
    const errorCode = body?.error?.code || body?.code
    throw new UserPortraitApiError(message, response.status, errorCode)
  }
  return body.data as T
}

function _validateOrganizationId(organizationId: string): void {
  if (!organizationId) {
    throw new UserPortraitApiError('organizationId is required', 400, 'INVALID_ORGANIZATION_ID')
  }
}

/**
 * 写入类端点（hint/distill/snapshots）强制要求 agentId——画像按 Agent 完全隔离，
 * 缺失时后端会 400。GET 端点故意不走这个校验：允许 agentId 为空字符串，
 * 后端 fail-closed 返回空画像，兼容尚未透传 agentId 的旧调用点。
 */
function _requireAgentId(agentId: string): void {
  if (!agentId) {
    throw new UserPortraitApiError('agentId is required', 400, 'INVALID_AGENT_ID')
  }
}

// ── API 函数 ──────────────────────────────────────

export const UserPortraitApi = {
  /**
   * 获取当前用户在指定 (Organization, Agent) 的画像。
   * 不存在则后端会自动创建空 portrait。
   * 用户必须是该 Organization 的成员/所有者 + 该 Agent 的 owner，否则后端返回 403。
   * agentId 允许传空字符串（过渡兼容）——后端 fail-closed 返回空画像。
   */
  async getMyPortrait(organizationId: string, agentId: string): Promise<UserPortrait> {
    _validateOrganizationId(organizationId)
    return request<UserPortrait>({
      path: `/me/${encodeURIComponent(organizationId)}`,
      method: 'GET',
      params: { agent_id: agentId || undefined },
    })
  },

  /**
   * 提交一条 hint（D7）—— 该 (Organization, Agent) 画像范围内
   * 后端会立即触发蒸馏；返回的 portrait 中 distill_dispatched 表示是否成功调度
   */
  async submitHint(organizationId: string, agentId: string, text: string): Promise<UserPortrait> {
    _validateOrganizationId(organizationId)
    _requireAgentId(agentId)
    return request<UserPortrait>({
      path: `/me/${encodeURIComponent(organizationId)}/hint`,
      method: 'POST',
      params: { agent_id: agentId },
      body: { text },
    })
  },

  /** 主动触发当前 (Organization, Agent) 画像的蒸馏（D5 路径 1） */
  async triggerDistill(organizationId: string, agentId: string): Promise<UserPortrait> {
    _validateOrganizationId(organizationId)
    _requireAgentId(agentId)
    return request<UserPortrait>({
      path: `/me/${encodeURIComponent(organizationId)}/distill`,
      method: 'POST',
      params: { agent_id: agentId },
      body: {},
    })
  },

  /** 获取指定 (Organization, Agent) 画像的历史快照列表 */
  async listSnapshots(organizationId: string, agentId: string, limit = 20): Promise<SnapshotListResponse> {
    _validateOrganizationId(organizationId)
    _requireAgentId(agentId)
    return request<SnapshotListResponse>({
      path: `/me/${encodeURIComponent(organizationId)}/snapshots`,
      method: 'GET',
      params: { agent_id: agentId, limit },
    })
  },
}

// ── 工具函数 ──────────────────────────────────────

/**
 * 把 5 段 markdown 解析为段落数组，便于 UI 分别渲染。
 * 失败时返回单段 fallback。
 */
export function parsePortraitSections(contentMd: string): Array<{
  title: string
  body: string
}> {
  if (!contentMd || !contentMd.trim()) return []

  const sections: Array<{ title: string; body: string }> = []
  const parts = contentMd.split(/^##\s+/m).filter(Boolean)

  for (const part of parts) {
    const newlineIdx = part.indexOf('\n')
    if (newlineIdx === -1) {
      sections.push({ title: part.trim(), body: '' })
    } else {
      sections.push({
        title: part.slice(0, newlineIdx).trim(),
        body: part.slice(newlineIdx + 1).trim(),
      })
    }
  }

  return sections
}
