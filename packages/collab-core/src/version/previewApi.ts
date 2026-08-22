import { joinApiPath } from '@tabtin/config'

import type { ConversationSegmentResponse, SubConversationRef } from './types'

export interface VersionPreviewData {
  type: string
  preview_unavailable?: boolean
  reason?: string
  // docs
  markdown?: string
  plaintext_preview?: string
  content_type?: string
  // slide —— pages 为后端 rebuild_data 输出的完整页面（含 elements），
  // 由 tabslide 的 convertBackendToPresentation 消费渲染真实缩略图。
  // 这里刻意用宽松结构，避免 collab-core 反向依赖 @tabtin/tabslide。
  page_count?: number
  pages?: Array<Record<string, unknown>>
  theme?: Record<string, unknown> | null
  preset?: string | null
  // design（canvas_width/canvas_height 与 slide 复用，单位均为画布像素）
  canvas_width?: number
  canvas_height?: number
  ai_version?: number
  components_count?: number
  // video
  width?: number
  height?: number
  fps?: number
  track_count?: number
  // canvas
  node_count?: number
  edge_count?: number
}

export async function fetchVersionPreview(
  apiBase: string,
  versionId: string,
  token: string,
): Promise<VersionPreviewData | null> {
  try {
    const res = await fetch(joinApiPath(apiBase, `/versions/${versionId}/preview`), {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    if (!res.ok) {
      console.warn(`[VersionPreview] HTTP ${res.status} for version ${versionId}`)
      return null
    }
    const json = await res.json()
    return json?.data ?? null
  } catch (err) {
    console.warn('[VersionPreview] fetch failed:', err)
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// ConversationAnchors（PRD §4.3.2 / §5.2）
// ─────────────────────────────────────────────────────────────

/**
 * 单条 ChangeLog 关联的对话上下文（对齐后端
 * `apps.collab.schemas.ConversationAnchorContext`）。
 */
export interface ConversationAnchorContext {
  session_id?: string | null
  assistant_message_id?: string | null
  user_message_id?: string | null
  user_prompt?: string | null
  intent_summary?: string | null
  has_sub_conversations: boolean
  /**
   * 子 Agent 对话引用列表。仅在请求时显式传 `includeSubConversations=true`
   * 时由后端填充；其他场景为 null（对应后端"未展开"语义）。
   */
  sub_conversations?: SubConversationRef[] | null
}

/**
 * conversation-anchors 列表中的单条记录（对齐后端
 * `apps.collab.schemas.ConversationAnchorItem`）。
 */
export interface ConversationAnchorItem {
  changelog_id: string
  checkpoint_commit_hash?: string | null
  change_type: string
  summary: string
  created_at: string | null
  editor_type: string
  editor_name: string
  agent_run_id: string
  context: ConversationAnchorContext | null
}

/**
 * conversation-anchors 完整响应（对齐后端
 * `apps.collab.schemas.ConversationAnchorsResponse`）。
 */
export interface ConversationAnchorsResponse {
  items: ConversationAnchorItem[]
  has_more: boolean
  next_before: string | null
}

export interface FetchConversationAnchorsOptions {
  /** 单页最多返回条数，默认 20（后端上限 50） */
  limit?: number
  /** 分页游标：ISO 8601 时间戳，仅返回此时间之前的记录 */
  before?: string
  /**
   * 是否同时展开子 Agent 对话引用（PRD §4.3.2）。
   * 默认 false，避免单页多条记录都 O(N) 展开子对话。
   */
  includeSubConversations?: boolean
  /** 取消信号，用于组件卸载时中止请求 */
  signal?: AbortSignal
}

/**
 * 查询某个资源的所有变更记录及关联的对话上下文（PRD §4.3.2）。
 *
 * 对应后端 `GET /collab/v1/resource/{resource_type}/{resource_id}/conversation-anchors`。
 * 按 `created_at` 倒序分页返回，每条记录附带产生该变更的对话锚点（session_id、
 * assistant_message_id、user_message_id、user_prompt 预览等）。
 *
 * 典型使用场景：
 * - 版本面板点击"查看对话"时拉取锚点列表
 * - TabCode 代码版本追溯 `resource_type='file'` / `resource_id=UUID5(path)`
 * - US-3 子 Agent 追溯：`includeSubConversations=true` 批量展开
 *
 * @param collabApiBase `/collab/v1` 前缀，e.g. `${API_CONFIG.baseURL}/collab/v1`
 * @param resourceType `docs` / `table` / `slide` / `video` / `canvas` / `file`
 * @param resourceId 资源 UUID（对 `file` 资源类型为文件路径的 UUID5）
 * @param token 访问 token（JWT）
 * @param opts 分页与展开选项
 * @returns 响应 data（含 items/has_more/next_before）；失败返回 null（不抛异常，
 *   调用方按"无锚点信息"降级）
 */
export async function fetchConversationAnchors(
  collabApiBase: string,
  resourceType: string,
  resourceId: string,
  token: string,
  opts?: FetchConversationAnchorsOptions,
): Promise<ConversationAnchorsResponse | null> {
  try {
    const params = new URLSearchParams()
    if (opts?.limit != null) params.set('limit', String(Math.max(1, Math.min(opts.limit, 50))))
    if (opts?.before) params.set('before', opts.before)
    if (opts?.includeSubConversations) params.set('include_sub_conversations', 'true')

    const query = params.toString()
    const url =
      joinApiPath(
        collabApiBase,
        `/resource/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}/conversation-anchors`,
      ) + (query ? `?${query}` : '')

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: opts?.signal,
    })
    if (!res.ok) {
      console.warn(
        `[ConversationAnchors] HTTP ${res.status} for ${resourceType}:${resourceId}`,
      )
      return null
    }
    const json = await res.json()
    const data = (json?.data ?? json) as ConversationAnchorsResponse | null
    if (!data || !Array.isArray(data.items)) return null
    return {
      items: data.items,
      has_more: !!data.has_more,
      next_before: data.next_before ?? null,
    }
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'AbortError') return null
    console.warn('[ConversationAnchors] fetch failed:', err)
    return null
  }
}

/**
 * 获取对话片段（around_message_id 前后若干条消息）。
 * 用于 ConversationSegmentPopover 浮层预览。
 */
export async function fetchConversationSegment(
  chatApiBase: string,
  sessionId: string,
  messageId: string,
  token: string,
  opts?: { before?: number; after?: number },
): Promise<ConversationSegmentResponse | null> {
  try {
    const params = new URLSearchParams({
      around_message_id: messageId,
      before: String(opts?.before ?? 3),
      after: String(opts?.after ?? 2),
    })
    const res = await fetch(
      joinApiPath(chatApiBase, `/sessions/${sessionId}/conversation-segment?${params}`),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    )
    if (!res.ok) {
      if (res.status === 404) {
        return { messages: [], has_more_before: false, has_more_after: false, session_archived: true }
      }
      console.warn(`[ConversationSegment] HTTP ${res.status} for session ${sessionId}`)
      return null
    }
    const json = await res.json()
    return json?.data ?? null
  } catch (err) {
    console.warn('[ConversationSegment] fetch failed:', err)
    return null
  }
}
