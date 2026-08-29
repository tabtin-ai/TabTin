/**
 * sessionShareApi — 「共享任务」（ 文档协同式）会话侧 API client。
 *
 * 共享查看已改走主链路（getChatClient 的 session / messages 读端点 + WS 实时流，
 * 后端 `_get_session_with_shared_access` 放行 grantee），本模块只保留叠加权限位：
 * - POST /chat/sessions/{id}/shared-fork   接收人 fork 成自己的 Agent × Workspace 会话
 * - GET  /chat/sessions/{id}/shared-execution-status  can_chat 发送前执行机可达预检
 * - POST /chat/sessions/{id}/shared-chat   grantee 发言驱动 owner 会话（can_chat 档）
 * - POST /chat/session-shares              从 Agent 会话发起共享（发卡到双方 DM）
 *
 * 错误抛 ShareApiError（带 status），供调用方区分 403（共享已停止 / 无权）与其它失败。
 */

import { joinApiPath } from '@tabtin/config'
import { API_CONFIG } from '@/config/api'
import { apiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import { createLogger } from '@/utils/logger'
import type { TableHttpMethod } from '@tabtin/table-core'
import type { ChatSession } from '@tabtin/chat-client'

const log = createLogger('SessionShareApi')

interface ApiEnvelope<T = unknown> {
  success: boolean
  message: string
  data: T
  code: number | string
}

/** 带 HTTP / 业务 status 的错误：403 → 查看器空态「共享已停止或无权查看」。 */
export class ShareApiError extends Error {
  status: number
  code?: string
  data?: unknown

  constructor(message: string, status: number, code?: string, data?: unknown) {
    super(message)
    this.name = 'ShareApiError'
    this.status = status
    this.code = code
    this.data = data
  }
}

/**
 * 统一请求：兼容两类后端封装——
 * - conversation 侧 error_response_with_status：HTTP 4xx + body.success=false；
 * - tabchat 侧 ninja ApiResponse：恒 HTTP 200，body.code 带业务状态码。
 */
export async function shareApiRequest<T>(
  method: TableHttpMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await getAuthToken()
  const url = joinApiPath(API_CONFIG.baseURL, path)

  let serializedBody: string | undefined
  if (body !== undefined) {
    try {
      serializedBody = JSON.stringify(body)
    } catch (err) {
      throw new Error(`[shareApiRequest] Failed to serialize request body: ${err}`)
    }
  }

  const response = await apiRequest<ApiEnvelope<T>>({
    url,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(serializedBody !== undefined ? { body: serializedBody } : {}),
  })

  const data = response.data
  if (data == null || typeof data !== 'object') {
    throw new ShareApiError(
      `Session share API error: unexpected response shape (status=${response.status})`,
      response.status,
    )
  }
  if (!data.success) {
    const status = response.status >= 400
      ? response.status
      : (typeof data.code === 'number' ? data.code : response.status)
    log.warn('share api request failed', { path, status, message: data.message })
    throw new ShareApiError(
      data.message || `Session share API error: ${status}`,
      status,
      typeof data.code === 'string' ? data.code : undefined,
      data.data,
    )
  }
  return data.data
}

// ── 共享 fork ──────────────────────────────────────────────────────────

export async function sharedFork(
  sessionId: string,
  params: { agentId: string; workspaceId: string; shareId: string },
): Promise<ChatSession> {
  return shareApiRequest<ChatSession>('POST', `/chat/sessions/${sessionId}/shared-fork`, {
    agent_id: params.agentId,
    workspace_id: params.workspaceId,
    share_id: params.shareId,
  })
}

// ── 执行机可达预检（发送前） ───────────────────────────────────────────

/** GET shared-execution-status：与 PromptForward 投递成功条件同源的只读探测。 */
export interface SharedExecutionStatus {
  reachable: boolean
  error_category: string | null
  runtime: 'daemon' | 'electron' | null
}

/** can_chat 打开 / 刷新 / 发送前探测 owner 执行机是否在线。 */
export async function getSharedExecutionStatus(
  sessionId: string,
  shareId: string,
): Promise<SharedExecutionStatus> {
  return shareApiRequest<SharedExecutionStatus>(
    'GET',
    `/chat/sessions/${sessionId}/shared-execution-status?share_id=${encodeURIComponent(shareId)}`,
  )
}

// ── 共享对话（shared-chat 发言驱动） ───────────────────────────────────

/**
 * shared-chat 同步响应（对齐后端 `_SHARED_CHAT_RESULT_FIELDS`，与
 * ChatService.send_message_sync 兼容字典同构）。设备离线时
 * `error_category='device_offline'`，reply 为离线提示文案；长任务依赖
 * WS 实时流呈现，响应体不承诺完整回复。
 */
export interface SharedChatResult {
  message_id: string | null
  reply: string | null
  content: string | null
  model_id?: string | null
  model_name?: string | null
  trace_id?: string | null
  error_category: string | null
  error_message: string | null
  error_code?: string | null
}

/** grantee 在 owner 会话里发言驱动 Agent（需 active share 且 can_chat）。 */
export async function sharedChat(
  sessionId: string,
  shareId: string,
  text: string,
  clientMessageId: string,
): Promise<SharedChatResult> {
  return shareApiRequest<SharedChatResult>('POST', `/chat/sessions/${sessionId}/shared-chat`, {
    text,
    share_id: shareId,
    client_message_id: clientMessageId,
  })
}

/** v2 协作者经自建 Gateway 双向通道发言；卡片变化通过 Centrifugo 通知。 */
export async function sharedCollaborationChat(
  sessionId: string,
  shareId: string,
  version: number,
  accessEpoch: number,
  text: string,
): Promise<SharedChatResult> {
  const bridge = window.tabtin?.agentEngine
  if (!bridge?.gatewaySend) throw new Error('gateway-send bridge unavailable')

  const response = await bridge.gatewaySend({
    messageType: 'chat.send_message',
    payload: {
      session_id: sessionId,
      message: text,
      client_event_id: crypto.randomUUID(),
      collaboration_id: shareId,
      collaboration_version: version,
      access_epoch: accessEpoch,
    },
  })
  if (!response.ok) {
    const code = response.error?.code ?? 'gateway_error'
    return {
      message_id: null,
      reply: null,
      content: null,
      error_category: code === 'access_revoked' ? 'access_denied' : code,
      error_message: response.error?.message ?? code,
      error_code: code,
    }
  }
  return {
    message_id: typeof response.payload?.message_id === 'string'
      ? response.payload.message_id
      : null,
    reply: null,
    content: null,
    trace_id: typeof response.payload?.trace_id === 'string' ? response.payload.trace_id : null,
    error_category: null,
    error_message: null,
  }
}

// ── 发起共享（conversation 业务域编排端点） ─────────────────────────────

/** 创建响应 = serialize_share + 卡片落点（发到双方 DM 的会话 / 消息）。 */
export interface CreateSessionShareResult {
  id: string
  session_id: string
  session_title: string
  owner_user_id: string
  grantee_user_id: string
  can_fork: boolean
  can_chat: boolean
  status: 'pending' | 'active' | 'revoked'
  card_contract?: 'session_share_v2'
  version?: number
  access_epoch?: number
  forked_session_id: string | null
  created_at: string | null
  revoked_at: string | null
  conversation_id: string
  message_id: number | null
  message_ref: string
}

export interface CreateSessionShareParams {
  session_id: string
  grantee_user_id: string
  can_fork?: boolean
  can_chat?: boolean
  /** 当前组织内私聊；提供后复用该会话投递分享卡。 */
  conversation_id?: string
  /** 失败重试必须复用同一幂等键；未传时由调用方生成。 */
  client_request_id: string
}

export async function createSessionShareFromChat(
  params: CreateSessionShareParams,
): Promise<CreateSessionShareResult> {
  return shareApiRequest<CreateSessionShareResult>('POST', '/chat/session-shares', {
    session_id: params.session_id,
    grantee_user_id: params.grantee_user_id,
    can_fork: params.can_fork ?? false,
    can_chat: params.can_chat ?? false,
    access_mode: params.can_chat ? 'collaborate' : params.can_fork ? 'fork' : 'view',
    card_contract: 'session_share_v2',
    client_request_id: params.client_request_id,
  })
}

// ── 共享会话本地文件预览──────────────────────────────────────

export interface SharedFilePreviewInlineData {
  kind: string
  content?: string
  size?: number
  truncated?: boolean
  mime?: string
}

export interface SharedFilePreviewTransport {
  mode: 'inline' | 'signed_url'
  data?: SharedFilePreviewInlineData
  url?: string
  expires_in?: number
  accept_ranges?: boolean
}

export interface SharedFilePreviewResult {
  ref_id: string
  filename: string
  relative_path: string
  preview_kind: string
  content_version?: string
  size_bytes?: number | null
  mime_type?: string
  transport: SharedFilePreviewTransport
}

/** grantee / owner 按需预览会话结构化引用的工作区本地文件。 */
export async function sharedFilePreview(
  sessionId: string,
  path: string,
  shareId: string,
  timeoutSeconds = 25,
): Promise<SharedFilePreviewResult> {
  return shareApiRequest<SharedFilePreviewResult>(
    'POST',
    `/chat/sessions/${sessionId}/shared-file-preview`,
    {
      path,
      share_id: shareId,
      timeout_seconds: timeoutSeconds,
    },
  )
}
