/**
 * TabChat API Service
 *
 * 封装 Django IM 数据面与会话控制面。
 */

import { joinApiPath } from '@tabtin/config'
import { API_CONFIG } from '@/config/api'
import { apiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import { ApiError } from '@/services/api'
import { createLogger } from '@/utils/logger'
import type { TableHttpMethod } from '@tabtin/table-core'
import {
  createDefaultIMProviderRegistry,
  createClientRequestId,
  createMessageRef,
  type Conversation,
  type ConversationLabel,
  type IMMessage,
  type IMMessageLocator,
  type IMMessageMetadata,
  type IMProviderEventListener,
  type IMProviderStartContext,
  type IMProviderUnsubscribe,
} from './im'
import { createDjangoIMProvider } from './im/providers/djangoProvider'
import { shareApiRequest } from './sessionShareApi'

export type {
  Conversation,
  ConversationLabel,
  ForwardedFrom,
  IMMessage,
  IMMessageMetadata,
  IMProviderEvent,
  MessageAttachmentDownloadUrl,
  MessageReadReceipts,
  ReadReceiptMember,
  ReplyToPreview,
  UnreadSnapshot,
} from './im'
export { createClientRequestId, createMessageRef } from './im'

const log = createLogger('TabChatApi')
import {
  CHAT_CONTENT_FILTER_MESSAGE,
  type ChatContentFilter,
  MESSAGE_TYPE_FILE,
  MESSAGE_TYPE_TEXT,
  MESSAGES_PAGE_SIZE,
  SEARCH_PAGE_SIZE,
} from '@/constants/tabchat'

// ── Types ────────────────────────────────────────────────────────────

export interface ConversationMember {
  /** TC-8: 'user' | 'agent'。旧数据无此字段时按 user 处理 */
  member_type?: 'user' | 'agent'
  /** Agent 成员时为 null */
  user_id: string | null
  /** TC-8: AI Agent 成员的 id（与 user_id 互斥） */
  agent_id?: string | null
  /** Agent 主人；人类成员为空 */
  owner_user_id?: string | null
  owner_display_name?: string
  /** Agent 执行设备对主人是否可派发；缺省视为未知，不置灰 */
  is_execution_online?: boolean | null
  nickname?: string
  username?: string
  avatar?: string
  role: number
  is_muted: boolean
  pinned: boolean
  joined_at: string | null
  participant_organization_id: string
  is_external?: boolean
  organization_name?: string
}

export interface ExternalContact {
  contact_id: string
  organization_id: string
  peer_organization_id: string
  peer_user_id: string
  display_name: string
  avatar_url: string
  relationship: 'friend' | 'blocked' | 'suspended' | 'removed'
  suspended_reason?: string
  is_restorable: boolean
  updated_at: string
  peer_organization_name: string
}

export interface ExternalContactCandidate {
  user_id: string
  display_name: string
  avatar_url: string
  relationship: 'none' | 'pending' | ExternalContact['relationship']
  external_contact_id?: string
  pending_invitation_id?: string
}

export interface ContactInvitation {
  invitation_id: string
  direction: 'incoming' | 'outgoing'
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired'
  peer_user_id: string
  peer_organization_id?: string
  display_name: string
  avatar_url: string
  created_at: string
  expires_at: string
  resolved_at?: string
  note?: string
  peer_organization_name?: string
}

export interface UserProfile {
  id: string
  nickname: string
  username: string
  avatar: string
  /** 头像源变更标识，用于绕过浏览器/CDN 对旧 URL 的缓存。 */
  avatar_version?: string
  /** 服务端单调递增的公开资料版本，用于拒绝乱序响应。 */
  revision?: number
}

export interface ConversationDetail extends Conversation {
  dm_hash: string | null
  created_by: string
  members: ConversationMember[]
  participant_organization_id: string
  directory_scope_id: string
  /** TC-37：是否有未读 @me（详情接口返回） */
  has_unread_mention?: boolean
}

export interface TeamSpaceAgentTaskThreadResult {
  session_id: string
  thread_id?: string | null
  space_id: string
  organization_id: string
  title: string
  session: Record<string, unknown>
  default_prompt: string
  source_message_ids: number[]
}

interface ApiResponse<T = unknown> {
  success: boolean
  message: string
  data: T
  code: number
  error_code?: string
}

function getApiErrorCode(data: ApiResponse<unknown>): string | undefined {
  const nestedData = data.data
  const nestedCode = nestedData && typeof nestedData === 'object'
    ? (nestedData as { error_code?: unknown; errorCode?: unknown }).error_code
      ?? (nestedData as { errorCode?: unknown }).errorCode
    : undefined
  const errorCode = nestedCode ?? data.error_code
  return typeof errorCode === 'string' && errorCode.trim() ? errorCode.trim() : undefined
}

// ── Internal request helper ──────────────────────────────────────────

class IMRequestTransportError extends Error {
  constructor(readonly originalError: unknown) {
    super('TabChat API transport is unavailable')
    this.name = 'IMRequestTransportError'
  }
}

function emptyContactItems<T>(): { items: T[] } {
  return { items: [] }
}

async function requestIM<T>(
  baseURL: string,
  method: TableHttpMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await getAuthToken()
  const url = joinApiPath(
    baseURL,
    `/im${path}`,
  )

  const upperMethod = method.toUpperCase()
  if (body !== undefined && (upperMethod === 'GET' || upperMethod === 'HEAD')) {
    log.warn(`imRequest ${upperMethod} request should not carry a body, ignoring:`, path)
    body = undefined
  }

  let serializedBody: string | undefined
  if (body !== undefined) {
    try {
      serializedBody = JSON.stringify(body)
    } catch (err) {
      throw new Error(`[imRequest] Failed to serialize request body: ${err}`)
    }
  }

  const response = await (async () => {
    try {
      return await apiRequest<ApiResponse<T>>({
        url,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-TabTin-IM-Protocol': '2',
        },
        ...(serializedBody !== undefined ? { body: serializedBody } : {}),
      })
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new IMRequestTransportError(error)
    }
  })()

  const data = response.data
  if (data == null || typeof data !== 'object') {
    throw new ApiError(
      `TabChat API error: unexpected response shape (status=${response.status})`,
      response.status,
      data,
    )
  }
  if (!data.success) {
    const message = data.message || `TabChat API error: ${response.status}`
    log.warn('TabChat API request failed', {
      method: upperMethod,
      path,
      status: response.status,
      errorCode: getApiErrorCode(data),
    })
    throw new ApiError(message, response.status, data)
  }
  return data.data
}

function djangoIMRequest<T>(
  method: TableHttpMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  return requestIM(API_CONFIG.baseURL, method, path, body)
}

/** 资源 ACL 正典 API（不走 /im 前缀）。 */
async function djangoDomainRequest<T>(
  method: TableHttpMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await getAuthToken()
  const url = joinApiPath(API_CONFIG.baseURL, path)
  const upperMethod = method.toUpperCase()
  let serializedBody: string | undefined
  if (body !== undefined && upperMethod !== 'GET' && upperMethod !== 'HEAD') {
    serializedBody = JSON.stringify(body)
  }
  const response = await apiRequest<{ success: boolean; message?: string; data: T }>({
    url,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(serializedBody !== undefined ? { body: serializedBody } : {}),
  })
  const data = response.data
  if (data == null || typeof data !== 'object' || !data.success) {
    throw new ApiError(
      data?.message || `Resource access API error: ${response.status}`,
      response.status,
      data,
    )
  }
  return data.data
}

const imProviderRegistry = createDefaultIMProviderRegistry({
  djangoProvider: createDjangoIMProvider({
    request: djangoIMRequest,
  }),
})

const organizationProviderStarts = new Map<
  string,
  { userId: string; promise: Promise<void> }
>()
const organizationProviderStates = new Map<
  string,
  'pending' | 'ready' | 'failed'
>()
let imLifecycleGeneration = 0
let imLifecycleTail: Promise<void> = Promise.resolve()

function enqueueIMLifecycle<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const result = imLifecycleTail.then(operation, operation)
  imLifecycleTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/**
 * provider 生命周期交接（stop → start）时最多跟随几代，避免异常情况下无限等待。
 */
const PROVIDER_START_HANDOVER_LIMIT = 3

async function waitForOrganizationProviderStart(
  organizationId: string,
): Promise<void> {
  // 等待期间生命周期可能被 stopIMProvider 取代——dev 下 React StrictMode 的
  // mount → cleanup → mount 必然触发，登出登入、组织列表变化同样会。
  // 被取代的那次 start 走 generation 不匹配的提前 return：promise **静默
  // resolve 而不是 reject**。只 await 它的调用方会拿着「假就绪」直接打
  // provider，此时 session 尚未建立，冷启动第一屏的会话 / 标签加载会整片抛
  // IMProviderUnavailableError。所以这里等到状态真正 ready 为止，中途被取代
  // 就跟到新一代的 start 上。
  for (let attempt = 0; attempt <= PROVIDER_START_HANDOVER_LIMIT; attempt += 1) {
    if (organizationProviderStates.get(organizationId) === 'ready') return

    let current = organizationProviderStarts.get(organizationId)
    if (!current) {
      // Django provider 在渲染层同步就绪；记录缺失时不伪造未就绪。
      await Promise.resolve()
      current = organizationProviderStarts.get(organizationId)
    }
    if (!current) {
      return
    }

    // start 真的失败时 promise 会 reject，原样抛给调用方，不在这里吞掉。
    await current.promise
    if (organizationProviderStates.get(organizationId) === 'ready') return

    // 走到这里说明这次 start 被新一代取代了：让出一轮宏任务，
    // 等新的 start 注册上来再跟。
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  }
  throw new Error('Django IM is not ready for this organization')
}

async function waitForConversationProviderStart(
  conversationId: string,
): Promise<void> {
  const organizationId = imProviderRegistry.getConversationOrganization(
    conversationId,
  )
  if (!organizationId) {
    throw new Error('Django IM is not ready for this conversation')
  }
  await waitForOrganizationProviderStart(organizationId)
}

export function startIMProvider(context: IMProviderStartContext): Promise<void> {
  const current = organizationProviderStarts.get(context.organizationId)
  // Provider 会话按组织隔离；已完成的 renderer start 不能跨组织复用。
  // 仅合并同组织正在进行中的启动，切回已访问过的组织仍需重新启动会话。
  if (
    current?.userId === context.userId
    && organizationProviderStates.get(context.organizationId) === 'pending'
  ) return current.promise

  const generation = imLifecycleGeneration
  organizationProviderStates.set(context.organizationId, 'pending')
  const promise = (async () => {
    if (generation !== imLifecycleGeneration) return
    await enqueueIMLifecycle(async () => {
      if (generation !== imLifecycleGeneration) return
      await imProviderRegistry.start(context)
      if (generation === imLifecycleGeneration) {
        organizationProviderStates.set(context.organizationId, 'ready')
      }
    })
  })()
  organizationProviderStarts.set(context.organizationId, {
    userId: context.userId,
    promise,
  })
  void promise.catch(() => {
    const latest = organizationProviderStarts.get(context.organizationId)
    if (latest?.promise === promise) {
      organizationProviderStarts.delete(context.organizationId)
      if (generation === imLifecycleGeneration) {
        organizationProviderStates.set(context.organizationId, 'failed')
      }
    }
  })
  return promise
}

export function stopIMProvider(): Promise<void> {
  imLifecycleGeneration += 1
  organizationProviderStarts.clear()
  organizationProviderStates.clear()
  return enqueueIMLifecycle(async () => {
    try {
      await imProviderRegistry.stop()
    } finally {
      imProviderRegistry.resetConversationRoutes()
    }
  })
}

export function subscribeIMProvider(
  organizationId: string,
  listener: IMProviderEventListener,
): IMProviderUnsubscribe {
  return imProviderRegistry.subscribe(organizationId, listener)
}

export function rememberIMConversationRoute(
  conversationId: string,
  organizationId: string,
): void {
  imProviderRegistry.rememberConversationRoute(conversationId, organizationId)
}

// ── Resource card preview (TC-28) ────────────────────────────────────

export interface ResourceCardPreviewData {
  name?: string
  space_id?: string
  organization_id?: string
  current_user_role?: 'owner' | 'admin' | 'editor' | 'viewer' | null
  description?: string
  preview_table?: {
    columns?: Array<{ key?: string; label?: string }>
    rows?: Array<Record<string, string>>
    total_rows?: number
  } | null
}

export type ResourceCardPreviewStatus = 'ok' | 'deleted' | 'forbidden' | 'error'

export interface ResourceCardPreviewResult {
  status: ResourceCardPreviewStatus
  data?: ResourceCardPreviewData
}

/**
 * 按需读取资源卡最新预览（绕开可能 stale 的 ContextItem 快照）。
 * 不抛错——区分 ok / deleted(404) / forbidden(403) / error，供卡片渲染失效态。
 * 后端校验当前用户 viewer 权限（卡片=指针，收卡≠授权）。
 */
export async function getResourceCardPreview(
  cardType: 'document' | 'table',
  resourceId: string,
): Promise<ResourceCardPreviewResult> {
  const params = new URLSearchParams({ card_type: cardType, resource_id: resourceId })
  const url = joinApiPath(API_CONFIG.baseURL, `/im/resource-card-preview?${params}`)
  try {
    const token = await getAuthToken()
    const response = await apiRequest<ApiResponse<ResourceCardPreviewData>>({
      url,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    const body = response.data
    if (body?.success) return { status: 'ok', data: body.data }
    if (body?.code === 404) return { status: 'deleted' }
    if (body?.code === 403) return { status: 'forbidden' }
    return { status: 'error' }
  } catch {
    return { status: 'error' }
  }
}

// ── Conversation APIs ────────────────────────────────────────────────

export async function createDM(organizationId: string, otherUserId: string) {
  const result = await djangoIMRequest<{ conversation_id: string }>('POST', '/conversations/dm', {
    organization_id: organizationId,
    other_user_id: otherUserId,
  })
  imProviderRegistry.rememberConversationRoute(result.conversation_id, organizationId)
  return result
}

export async function createExternalDM(
  organizationId: string,
  externalContactId: string,
): Promise<{ conversation_id: string }> {
  const result = await djangoIMRequest<{ conversation_id: string }>(
    'POST',
    '/conversations/dm',
    {
      organization_id: organizationId,
      external_contact_id: externalContactId,
    },
  )
  imProviderRegistry.rememberConversationRoute(result.conversation_id, organizationId)
  return result
}

export async function createGroup(
  organizationId: string,
  name: string,
  memberIds: string[],
  avatarUrl = '',
  spaceId?: string,
  externalContactIds: string[] = [],
  clientRequestId: string = globalThis.crypto.randomUUID(),
) {
  const result = await djangoIMRequest<{ conversation_id: string }>('POST', '/conversations/group', {
    organization_id: organizationId,
    name,
    member_ids: memberIds,
    external_contact_ids: externalContactIds,
    client_request_id: clientRequestId,
    avatar_url: avatarUrl,
    space_id: spaceId,
  })
  imProviderRegistry.rememberConversationRoute(result.conversation_id, organizationId)
  return result
}

export async function createSpaceChannel(
  spaceId: string,
  organizationId: string,
  name: string,
) {
  const result = await djangoIMRequest<{ conversation_id: string }>(
    'POST',
    `/spaces/${spaceId}/channels`,
    {
      organization_id: organizationId,
      name,
    },
  )
  imProviderRegistry.rememberConversationRoute(result.conversation_id, organizationId)
  return result
}

export async function renameSpaceChannel(
  spaceId: string,
  conversationId: string,
  name: string,
) {
  return djangoIMRequest<null>('PATCH', `/spaces/${spaceId}/channels/${conversationId}`, {
    name,
  })
}

export async function archiveSpaceChannel(spaceId: string, conversationId: string) {
  return djangoIMRequest<null>('POST', `/spaces/${spaceId}/channels/${conversationId}/archive`)
}

export async function listConversations(organizationId: string, labelIds?: string[]) {
  await waitForOrganizationProviderStart(organizationId)
  return imProviderRegistry.listConversations({
    organizationId,
    labelIds,
  })
}

export async function getConversation(conversationId: string) {
  const conversation = await djangoIMRequest<ConversationDetail>(
    'GET',
    `/conversations/${conversationId}`,
  )
  const organizationId = conversation.participant_organization_id || conversation.organization_id
  imProviderRegistry.rememberConversationRoute(conversation.id, organizationId)
  return {
    ...conversation,
    participant_organization_id: organizationId,
    organization_id: organizationId,
  }
}

export async function createAgentTaskFromMessage(
  conversationId: string,
  messageId: number,
  agentId: string,
  additionalContext = '',
) {
  return djangoIMRequest<TeamSpaceAgentTaskThreadResult>(
    'POST',
    `/conversations/${conversationId}/messages/${messageId}/agent-task`,
    { agent_id: agentId, additional_context: additionalContext },
  )
}

export async function updateConversation(
  conversationId: string,
  updates: { name?: string; avatar_url?: string },
) {
  return djangoIMRequest<null>('PATCH', `/conversations/${conversationId}`, updates)
}

export async function addMembers(conversationId: string, memberIds: string[]) {
  return djangoIMRequest<{ added_user_ids: string[] }>(
    'POST',
    `/conversations/${conversationId}/members`,
    { member_ids: memberIds },
  )
}

export async function listExternalContacts(organizationId: string) {
  const query = new URLSearchParams({ organization_id: organizationId })
  try {
    return await djangoIMRequest<{ items: ExternalContact[] }>(
      'GET',
      `/external-contacts?${query}`,
    )
  } catch (error) {
    if (error instanceof IMRequestTransportError) {
      return emptyContactItems<ExternalContact>()
    }
    throw error
  }
}

export async function discoverExternalContact(
  organizationId: string,
  phone: string,
): Promise<ExternalContactCandidate> {
  return djangoIMRequest<ExternalContactCandidate>(
    'POST',
    '/external-contacts/discover',
    { organization_id: organizationId, phone },
  )
}

export async function issueContactInvitation(
  organizationId: string,
  targetUserId: string,
  note?: string,
): Promise<ContactInvitation> {
  const result = await djangoIMRequest<{
    invitation: ContactInvitation
    invitation_id: string
    status: ContactInvitation['status']
  }>(
    'POST',
    '/external-contact-invitations',
    {
      organization_id: organizationId,
      target_user_id: targetUserId,
      note: note ?? '',
    },
  )
  return result.invitation
}

export async function listContactInvitations(
  organizationId: string,
  direction?: ContactInvitation['direction'],
  status?: ContactInvitation['status'],
) {
  const query = new URLSearchParams({ organization_id: organizationId })
  if (direction) query.set('direction', direction)
  if (status) query.set('status', status)
  return djangoIMRequest<{ items: ContactInvitation[] }>(
    'GET',
    `/external-contact-invitations?${query}`,
  )
}

export async function acceptExternalContact(
  organizationId: string,
  invitationId: string,
): Promise<ExternalContact> {
  return djangoIMRequest<ExternalContact>(
    'POST',
    '/external-contacts/accept',
    { organization_id: organizationId, invite_code: invitationId },
  )
}

export async function updateContactInvitation(
  organizationId: string,
  invitationId: string,
  action: 'reject' | 'cancel',
): Promise<ContactInvitation> {
  return djangoIMRequest<ContactInvitation>(
    'PATCH',
    `/external-contact-invitations/${invitationId}`,
    { organization_id: organizationId, action },
  )
}

export async function updateExternalContact(
  organizationId: string,
  contactId: string,
  action: 'block' | 'unblock' | 'remove',
): Promise<ExternalContact> {
  return djangoIMRequest<ExternalContact>(
    'PATCH',
    `/external-contacts/${contactId}`,
    { organization_id: organizationId, action },
  )
}

export async function removeMember(conversationId: string, targetUserId: string) {
  return djangoIMRequest<null>('DELETE', `/conversations/${conversationId}/members/${targetUserId}`)
}

// ── Agent 成员 APIs（TC-8） ───────────────────────────────────────────

export async function addAgents(conversationId: string, agentIds: string[]) {
  return djangoIMRequest<{ added_agent_ids: string[] }>(
    'POST',
    `/conversations/${conversationId}/agents`,
    { agent_ids: agentIds },
  )
}

export async function removeAgent(conversationId: string, agentId: string) {
  return djangoIMRequest<null>('DELETE', `/conversations/${conversationId}/agents/${agentId}`)
}

export interface ConversationAgentBinding {
  agent_id: string
  workspace_id: string
  workspace_name: string
  bound_by_user_id: string
  bound_at: string | null
  can_rebind: boolean
  is_executable: boolean
}

export async function listConversationAgentBindings(conversationId: string) {
  const data = await djangoIMRequest<{ items: ConversationAgentBinding[] }>(
    'GET',
    `/conversations/${conversationId}/agent-bindings`,
  )
  return data.items
}

export async function createConversationAgentBinding(
  conversationId: string,
  agentId: string,
  workspaceId: string,
) {
  return djangoIMRequest<ConversationAgentBinding>(
    'POST',
    `/conversations/${conversationId}/agent-bindings`,
    { agent_id: agentId, workspace_id: workspaceId },
  )
}

export async function updateConversationAgentBinding(
  conversationId: string,
  agentId: string,
  workspaceId: string,
) {
  return djangoIMRequest<ConversationAgentBinding>(
    'PATCH',
    `/conversations/${conversationId}/agent-bindings/${agentId}`,
    { workspace_id: workspaceId },
  )
}

// ── Conversation preference APIs ─────────────────────────────────────

export async function togglePin(conversationId: string, pinned: boolean) {
  await waitForConversationProviderStart(conversationId)
  await imProviderRegistry.setConversationPinned({ conversationId, pinned })
  return { pinned, pinned_source: 'tabtin' as const }
}

export async function toggleMute(conversationId: string, muted: boolean) {
  await waitForConversationProviderStart(conversationId)
  await imProviderRegistry.setConversationMuted({ conversationId, muted })
  return { muted }
}

// ── TC-37：会话 label APIs ────────────────────────────────────────────

/** 系统 label 固定 id：未读 @me */
export const SYSTEM_LABEL_MENTION_ID = 'sys:mention'

/** 列出当前用户在当前 organization 的 label 库（含每个 label 的会话数） */
export async function listLabels(organizationId: string) {
  return djangoIMRequest<ConversationLabel[]>('GET', `/labels?organization_id=${organizationId}`)
}

/** 创建 label */
export async function createLabel(
  organizationId: string,
  name: string,
  color: string = '#6b7280',
) {
  return djangoIMRequest<ConversationLabel>('POST', `/labels`, {
    organization_id: organizationId,
    name,
    color,
  })
}

/** 改名 / 改色 */
export async function updateLabel(
  labelId: string,
  updates: { name?: string; color?: string },
) {
  return djangoIMRequest<ConversationLabel>('PATCH', `/labels/${labelId}`, updates)
}

/** 删除 label（从所有会话撕掉） */
export async function deleteLabel(labelId: string) {
  return djangoIMRequest<{ affected_conversations: number }>('DELETE', `/labels/${labelId}`)
}

/** 给会话追加 label */
export async function addConversationLabels(
  conversationId: string,
  labelIds: string[],
) {
  return djangoIMRequest<{ conversation_id: string; labels: ConversationLabel[] }>(
    'POST',
    `/conversations/${conversationId}/labels`,
    { label_ids: labelIds },
  )
}

/** 撕掉会话的某个 label */
export async function removeConversationLabel(
  conversationId: string,
  labelId: string,
) {
  return djangoIMRequest<{ conversation_id: string; labels: ConversationLabel[] }>(
    'DELETE',
    `/conversations/${conversationId}/labels/${labelId}`,
  )
}

/** 列出会话当前 label */
export async function getConversationLabels(conversationId: string) {
  return djangoIMRequest<ConversationLabel[]>('GET', `/conversations/${conversationId}/labels`)
}

/** 清空聊天记录（只清自己侧） */
export async function clearHistory(conversationId: string): Promise<void> {
  await waitForConversationProviderStart(conversationId)
  await imProviderRegistry.clearHistory(conversationId)
}

/** 退出群聊。走 POST /leave，群主会自动转让。 */
export async function leaveConversation(conversationId: string, _currentUserId?: string) {
  await waitForConversationProviderStart(conversationId)
  await imProviderRegistry.leaveConversation(conversationId)
}

// ── Message APIs ─────────────────────────────────────────────────────

export async function getMessages(
  conversationId: string,
  before?: Pick<IMMessage, 'transport' | 'metadata'>,
  limit = MESSAGES_PAGE_SIZE,
  contentFilter?: ChatContentFilter,
) {
  await waitForConversationProviderStart(conversationId)
  const messages = await imProviderRegistry.listMessages({
    conversationId,
    before: before ? messageLocator(before) : undefined,
    limit,
    contentFilter:
      contentFilter && contentFilter !== CHAT_CONTENT_FILTER_MESSAGE
        ? contentFilter
        : undefined,
  })
  return messages
}

export async function sendMessage(
  conversationId: string,
  content: string,
  messageType = MESSAGE_TYPE_TEXT,
  replyTo?: IMMessage,
  metadata?: Record<string, unknown>,
) {
  const clientRequestId =
    typeof metadata?.client_request_id === 'string' && metadata.client_request_id.trim()
      ? metadata.client_request_id.trim()
      : createClientRequestId()
  const messageRef =
    typeof metadata?.message_ref === 'string' && metadata.message_ref.trim()
      ? metadata.message_ref.trim()
      : createMessageRef()
  const normalizedMetadata: IMMessageMetadata = {
    ...(metadata ?? {}),
    client_request_id: clientRequestId,
    message_ref: messageRef,
  }
  const mentionedAgentIds = Array.isArray(normalizedMetadata.mentioned_agent_ids)
    ? Array.from(new Set(
        normalizedMetadata.mentioned_agent_ids
          .filter((agentId): agentId is string => typeof agentId === 'string')
          .map((agentId) => agentId.trim())
          .filter(Boolean),
      ))
    : []

  void mentionedAgentIds

  await waitForConversationProviderStart(conversationId)
  return imProviderRegistry.sendMessage({
    conversationId,
    content,
    messageType,
    replyTo: replyTo ? messageLocator(replyTo) : undefined,
    metadata: normalizedMetadata,
    clientRequestId,
  })
}

function messageLocator(
  message: Pick<IMMessage, 'transport' | 'metadata'> & Partial<Pick<IMMessage, 'id'>>,
): IMMessageLocator {
  const messageRef = message.metadata.message_ref?.trim()
    || (message.id != null ? String(message.id) : '')
  const transport = message.transport
    ?? (message.id != null ? { kind: 'group' as const, sequence: message.id } : undefined)
  if (!transport || !messageRef) {
    throw new Error('Django IM message locator is unavailable')
  }
  return { transport, message_ref: messageRef }
}

export async function deleteMessage(conversationId: string, message: IMMessage) {
  await waitForConversationProviderStart(conversationId)
  return imProviderRegistry.deleteMessage(conversationId, messageLocator(message))
}

// ── 消息置顶（功能3） ──

export async function getPinnedMessages(conversationId: string) {
  await waitForConversationProviderStart(conversationId)
  return imProviderRegistry.listPinnedMessages(conversationId)
}

export async function pinMessage(conversationId: string, message: IMMessage) {
  await waitForConversationProviderStart(conversationId)
  return imProviderRegistry.pinMessage(conversationId, messageLocator(message))
}

export async function unpinMessage(conversationId: string, message: IMMessage) {
  await waitForConversationProviderStart(conversationId)
  return imProviderRegistry.unpinMessage(conversationId, messageLocator(message))
}

/** 编辑一条文本消息（功能4，仅本人、无时限，带「已编辑」标记） */
export async function editMessage(
  conversationId: string,
  message: IMMessage,
  content: string,
  metadata?: Record<string, unknown>,
) {
  await waitForConversationProviderStart(conversationId)
  return imProviderRegistry.editMessage(
    conversationId,
    messageLocator(message),
    content,
    metadata,
  )
}

/** TC-13：按 message_id 换取当前可用下载 URL（转发消息亦适用） */
export async function getMessageAttachmentDownloadUrl(
  conversationId: string,
  message: IMMessage,
) {
  await waitForConversationProviderStart(conversationId)
  return imProviderRegistry.getAttachmentDownloadUrl(conversationId, messageLocator(message))
}

export async function getMessageReadReceipts(conversationId: string, message: IMMessage) {
  await waitForConversationProviderStart(conversationId)
  return imProviderRegistry.getReadReceipts(conversationId, messageLocator(message))
}

export async function markRead(conversationId: string, lastMessage?: IMMessage['transport']) {
  await waitForConversationProviderStart(conversationId)
  return imProviderRegistry.markRead({ conversationId, lastMessage })
}

export async function getUnreadCount(organizationId: string) {
  await waitForOrganizationProviderStart(organizationId)
  return imProviderRegistry.getUnreadSnapshot(organizationId)
}

// ── Search APIs ───────────────────────────────────────────────────────

export interface SearchResult {
  id: number
  transport?: IMMessage['transport']
  metadata?: IMMessageMetadata
  conversation_id: string
  conversation_name: string
  /** 搜索聚合所需的会话类型与头像；旧服务缺失时前端回退本地会话缓存。 */
  conversation_type?: number
  conversation_avatar_url?: string
  sender_id: string
  content: string
  message_type: number
  created_at: string | null
  highlight: string
  /** TC-36：发送者类型 user/agent */
  sender_type?: string
  /** TC-36：命中的字段集 content/file_name/card_title/card_description */
  match_types?: string[]
}

export interface MessageSearchGroup {
  conversation_id: string
  conversation_name: string
  conversation_type: number
  conversation_avatar_url: string
  match_count: number
  latest_match_at: string | null
  messages: SearchResult[]
  messages_has_more: boolean
  next_message_offset: number
}

export interface GroupedMessageSearchResponse {
  groups: MessageSearchGroup[]
  has_more: boolean
  next_group_offset: number
}

export function searchResultStableKey(result: SearchResult): string {
  const messageRef = result.metadata?.message_ref?.trim()
  return messageRef
    ? `${result.conversation_id}:ref:${messageRef}`
    : `${result.conversation_id}:legacy:${result.sender_id}:${result.id}:${result.created_at ?? ''}`
}

/** TC-36：match_type → i18n key */
export const SEARCH_MATCH_TYPE_LABELS: Record<string, string> = {
  content: 'matchTypeContent',
  file_name: 'matchTypeFileName',
  card_title: 'matchTypeCardTitle',
  card_description: 'matchTypeCardDescription',
}

interface CloudSearchCache {
  groups: MessageSearchGroup[]
  cursor: string
  loaded: boolean
}

interface CloudConversationSearchCache {
  messages: SearchResult[]
  cursor: string
  loaded: boolean
}

const cloudGroupSearchCache = new Map<string, CloudSearchCache>()
const cloudConversationSearchCache = new Map<string, CloudConversationSearchCache>()

function cloudSearchKey(
  organizationId: string,
  query: string,
  conversationId?: string,
): string {
  return `${organizationId}\u0000${query.trim().toLocaleLowerCase()}\u0000${conversationId ?? ''}`
}

function mapCloudSearchResult(
  message: IMMessage,
  conversation: Conversation,
): SearchResult {
  const fileName = message.message_type === MESSAGE_TYPE_FILE
    && typeof message.metadata?.file_name === 'string'
    ? message.metadata.file_name.trim()
    : ''

  return {
    id: message.id,
    transport: message.transport,
    metadata: message.metadata,
    conversation_id: conversation.id,
    conversation_name: conversation.name,
    conversation_type: conversation.type,
    conversation_avatar_url: conversation.avatar_url,
    sender_id: message.sender_id,
    content: message.content,
    message_type: message.message_type,
    created_at: message.created_at,
    highlight: fileName || message.content,
    ...(message.sender_type ? { sender_type: message.sender_type } : {}),
    match_types: [fileName ? 'file_name' : 'content'],
  }
}

async function loadCloudSearchPage(
  organizationId: string,
  query: string,
  conversationId?: string,
  cursor?: string,
) {
  await waitForOrganizationProviderStart(organizationId)
  return imProviderRegistry.searchMessages({
    organizationId,
    query,
    ...(conversationId ? { conversationId } : {}),
    ...(cursor ? { cursor } : {}),
  })
}

export async function searchMessages(
  organizationId: string,
  query: string,
  conversationId?: string,
  limit = SEARCH_PAGE_SIZE,
  offset = 0,
) {
  if (!conversationId || !query.trim()) return []
  const key = cloudSearchKey(organizationId, query, conversationId)
  if (offset === 0) cloudConversationSearchCache.delete(key)
  let cache = offset === 0
    ? undefined
    : cloudConversationSearchCache.get(key)
  if (!cache) {
    cache = { messages: [], cursor: '', loaded: false }
    cloudConversationSearchCache.set(key, cache)
  }
  while (
    !cache.loaded
    || (cache.messages.length < offset + limit && Boolean(cache.cursor))
  ) {
    const previousCursor = cache.cursor
    const page = await loadCloudSearchPage(
      organizationId,
      query.trim(),
      conversationId,
      cache.cursor || undefined,
    )
    const group = page.conversations.find(
      (item) => item.conversation.id === conversationId,
    )
    const known = new Set(cache.messages.map(searchResultStableKey))
    for (const message of group?.messages ?? []) {
      const result = mapCloudSearchResult(message, group!.conversation)
      const resultKey = searchResultStableKey(result)
      if (known.has(resultKey)) continue
      cache.messages.push(result)
      known.add(resultKey)
    }
    cache.loaded = true
    cache.cursor = page.cursor === previousCursor ? '' : page.cursor
  }
  return cache.messages.slice(offset, offset + limit)
}

export async function searchMessageGroups(
  organizationId: string,
  query: string,
  groupOffset = 0,
  groupLimit = 8,
  perGroupLimit = 3,
) {
  if (!query.trim()) {
    return { groups: [], has_more: false, next_group_offset: 0 }
  }
  const key = cloudSearchKey(organizationId, query)
  if (groupOffset === 0) {
    cloudGroupSearchCache.clear()
    cloudConversationSearchCache.clear()
  }
  let cache = groupOffset === 0 ? undefined : cloudGroupSearchCache.get(key)
  if (!cache) {
    cache = { groups: [], cursor: '', loaded: false }
    cloudGroupSearchCache.set(key, cache)
  }
  while (
    !cache.loaded
    || (cache.groups.length < groupOffset + groupLimit && Boolean(cache.cursor))
  ) {
    const previousCursor = cache.cursor
    const page = await loadCloudSearchPage(
      organizationId,
      query.trim(),
      undefined,
      cache.cursor || undefined,
    )
    const known = new Set(cache.groups.map((group) => group.conversation_id))
    for (const item of page.conversations) {
      const conversation = item.conversation
      if (known.has(conversation.id)) continue
      const messages = item.messages
        .map((message) => mapCloudSearchResult(message, conversation))
        .slice(0, perGroupLimit)
      cache.groups.push({
        conversation_id: conversation.id,
        conversation_name: conversation.name,
        conversation_type: conversation.type,
        conversation_avatar_url: conversation.avatar_url,
        match_count: item.matchCount,
        latest_match_at: messages[0]?.created_at ?? conversation.last_message_at,
        messages,
        messages_has_more: messages.length < item.matchCount,
        next_message_offset: messages.length,
      })
      known.add(conversation.id)
    }
    cache.loaded = true
    cache.cursor = page.cursor === previousCursor ? '' : page.cursor
  }

  const groups = cache.groups.slice(groupOffset, groupOffset + groupLimit)
  const nextGroupOffset = groupOffset + groups.length
  return {
    groups,
    has_more: nextGroupOffset < cache.groups.length || Boolean(cache.cursor),
    next_group_offset: nextGroupOffset,
  }
}

// ── Member Search APIs ─────────────────────────────────────────────────

export interface SearchMemberResult {
  id: string
  nickname: string
  username: string
  avatar: string
  email: string
}

export async function searchOrganizationMembers(
  organizationId: string,
  query: string,
  limit = query.trim() ? 20 : 0,
) {
  const params = new URLSearchParams({
    search_mode: 'nickname',
    limit: String(limit),
    offset: '0',
  })
  if (query.trim()) params.set('search', query.trim())
  const token = await getAuthToken()
  const response = await apiRequest({
    method: 'GET',
    url: joinApiPath(
      API_CONFIG.baseURL,
      `/context/organizations/${organizationId}/members?${params}`,
    ),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response || response.status < 200 || response.status >= 300) {
    throw new ApiError('组织成员搜索失败', response?.status ?? 0, response?.data)
  }
  const envelope = response.data as {
    success?: boolean
    data?: {
      members?: Array<{
        user_id: string
        user?: Partial<SearchMemberResult>
      }>
    }
  }
  if (!envelope?.success || !Array.isArray(envelope.data?.members)) {
    throw new Error('组织成员搜索响应格式无效')
  }
  return envelope.data.members.map((member) => ({
    id: member.user?.id || member.user_id,
    nickname: member.user?.nickname || '',
    username: member.user?.username || '',
    avatar: member.user?.avatar || '',
    email: '',
  }))
}

export interface SearchAgentResult {
  id: string
  name: string
  avatar: string
}

export async function searchOrganizationAgents(
  organizationId: string,
  query: string,
  limit = 20,
) {
  const params = new URLSearchParams({ organization_id: organizationId, limit: String(limit) })
  if (query.trim()) params.append('q', query.trim())
  return djangoIMRequest<SearchAgentResult[]>('GET', `/agents/search?${params}`)
}

// ── User Profile APIs ─────────────────────────────────────────────────

export async function batchGetUsers(organizationId: string, userIds: string[]) {
  return djangoIMRequest<UserProfile[]>('POST', '/users/batch', {
    organization_id: organizationId,
    user_ids: userIds,
  })
}

// ── Reaction APIs ─────────────────────────────────────────────────────

export async function addReaction(
  conversationId: string,
  messageRef: string,
  emoji: string,
  sequence?: number,
) {
  await waitForConversationProviderStart(conversationId)
  return imProviderRegistry.addReaction(conversationId, messageRef, emoji, sequence)
}

export async function removeReaction(
  conversationId: string,
  messageRef: string,
  emoji: string,
  sequence?: number,
) {
  await waitForConversationProviderStart(conversationId)
  return imProviderRegistry.removeReaction(conversationId, messageRef, emoji, sequence)
}

// ── IM 上下文交接（handoff）─────────────────────────────────────────────
//
// 交接包是独立领域对象，IM 卡片只是它的展示面（metadata.card.handoff_id）。
// 详情挂载后由 getHandoff 实时拉取；IM 卡片投影版本变化时重拉。

export type HandoffAction = 'acknowledge' | 'take_over' | 'reject'

export type HandoffRecipientState =
  | 'sent'
  | 'viewed'
  | 'acknowledged'
  | 'taking_over'
  | 'delegated_to_agent'
  | 'rejected'

export type HandoffStatus = 'draft' | 'sent' | 'revoked'

export interface HandoffChecklistItem {
  text: string
  checked?: boolean
  high_risk?: boolean
}

/** chat_session 材料的冻结快照（清洗版 Agent 会话历史）。 */
export interface FrozenTranscriptAttachment {
  type: 'file' | 'image' | 'document'
  file_id: string
  filename: string
  url: string
  mime_type: string
  size: number
}

export interface FrozenTranscriptTurn {
  role: string
  text: string
  tools: { name: string; label: string }[]
  attachments: (string | FrozenTranscriptAttachment)[]
}

export interface FrozenTranscript {
  title: string
  message_count: number
  truncated?: boolean
  turns: FrozenTranscriptTurn[]
}

export interface HandoffReferenceSpec {
  ref_type: 'im_message' | 'document' | 'table' | 'attachment' | 'chat_session'
  resource_id: string
  title_snapshot?: string
  summary_snapshot?: string
  source_link?: Record<string, unknown>
}

export interface HandoffReferenceInfo {
  id: string
  ref_type: 'im_message' | 'document' | 'table' | 'attachment' | 'chat_session'
  resource_id: string
  title: string
  summary: string
  source_link: {
    conversation_id?: string
    message_id?: number
    seq?: number
    space_id?: string
    organization_id?: string
    session_id?: string
    [key: string]: unknown
  }
  accessible: boolean
  denied_reason: 'access_denied' | 'deleted' | 'revoked' | 'error' | null
  /** 仅 chat_session 快照型材料：冻结的清洗版会话历史 */
  frozen_snapshot?: FrozenTranscript
}

export interface HandoffRecipientInfo {
  user_id: string | null
  agent_id: string | null
  state: HandoffRecipientState
  note: string
  state_changed_at: string | null
}

export interface HandoffPackage {
  id: string
  conversation_id: string
  organization_id: string
  initiator_type: 'user' | 'agent'
  initiator_user_id: string | null
  initiator_agent_id: string | null
  goal: string
  progress: HandoffChecklistItem[]
  next_steps: HandoffChecklistItem[]
  risks: HandoffChecklistItem[]
  scope: string
  status: HandoffStatus
  version: number
  card_message_id: number | null
  card_message_ref?: string | null
  card_message_sequence?: number | null
  recipients: HandoffRecipientInfo[]
  references?: HandoffReferenceInfo[]
  created_at: string
  updated_at: string
}

export interface CreateHandoffParams {
  conversationId: string
  goal: string
  progress?: HandoffChecklistItem[]
  nextSteps?: HandoffChecklistItem[]
  risks?: HandoffChecklistItem[]
  scope?: string
  recipients: string[]
  references?: HandoffReferenceSpec[]
  /** 默认创建后立即发送到会话 */
  send?: boolean
}

export async function createHandoff(params: CreateHandoffParams): Promise<HandoffPackage> {
  return djangoIMRequest<HandoffPackage>('POST', '/handoffs', {
    conversation_id: params.conversationId,
    goal: params.goal,
    progress: params.progress ?? [],
    next_steps: params.nextSteps ?? [],
    risks: params.risks ?? [],
    scope: params.scope ?? 'continuable',
    recipients: params.recipients,
    references: params.references ?? [],
    send: params.send ?? true,
  })
}

export async function getHandoff(handoffId: string): Promise<HandoffPackage> {
  return djangoIMRequest<HandoffPackage>('GET', `/handoffs/${handoffId}`)
}

export async function listHandoffs(conversationId: string): Promise<HandoffPackage[]> {
  const data = await djangoIMRequest<{ items: HandoffPackage[] }>(
    'GET',
    `/handoffs?conversation_id=${encodeURIComponent(conversationId)}`,
  )
  return data.items ?? []
}

export async function actOnHandoff(
  handoffId: string,
  action: HandoffAction,
  note = '',
): Promise<HandoffPackage> {
  return djangoIMRequest<HandoffPackage>('POST', `/handoffs/${handoffId}/actions`, { action, note })
}

export async function revokeHandoff(handoffId: string): Promise<HandoffPackage> {
  return djangoIMRequest<HandoffPackage>('POST', `/handoffs/${handoffId}/revoke`)
}

// ── 资源访问申请（ + 工具栏申请编辑）────────────────────────────
//
// 正典路径：/api/resource-access-requests（非 IM 消息域）
// /api/im/resource-access-requests 仅为旧 IM 卡兼容别名。
// - IM 资源卡：无权成员申请 viewer（默认），需会话/消息来源
// - 工具栏：已有 viewer 可无来源申请 editor
// 授权以 API/DB 为准；metadata.role 仅供确认弹窗展示。

export type ResourceAccessResourceType = 'document' | 'table'
export type ResourceAccessRequestRole = 'viewer' | 'editor'
export type ResourceAccessRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface ResourceAccessRequestInfo {
  id: string
  resource_type: ResourceAccessResourceType
  resource_id: string
  requester_id: string
  owner_id: string
  source_conversation_id: string
  /** 消息数据面的来源 ID，不保证是 Django Message 主键。 */
  source_message_id: number
  source_message_ref?: string | null
  role: ResourceAccessRequestRole | string
  status: ResourceAccessRequestStatus
  resolved_by?: string
  resolved_at?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export interface CreateResourceAccessRequestParams {
  /** IM 卡路径必填；工具栏申请 editor 可省略。 */
  sourceConversationId?: string
  sourceMessageId?: number
  sourceMessageRef?: string
  resourceType: ResourceAccessResourceType
  resourceId: string
  /** 缺省 viewer（兼容 ）；工具栏传 editor。 */
  role?: ResourceAccessRequestRole
  /** 无权限空状态的直达申请；服务端会校验当前用户仍属于资源所在组织。 */
  sourceSurface?: 'permission_denied'
}

/** 创建访问申请；已有同级或更高级 pending 时幂等返回。 */
export async function createResourceAccessRequest(
  params: CreateResourceAccessRequestParams,
): Promise<ResourceAccessRequestInfo> {
  return djangoDomainRequest<ResourceAccessRequestInfo>('POST', '/resource-access-requests', {
    ...(params.sourceConversationId
      ? { source_conversation_id: params.sourceConversationId }
      : {}),
    ...(params.sourceMessageId == null ? {} : { source_message_id: params.sourceMessageId }),
    ...(params.sourceMessageRef ? { source_message_ref: params.sourceMessageRef } : {}),
    resource_type: params.resourceType,
    resource_id: params.resourceId,
    ...(params.role ? { role: params.role } : {}),
    ...(params.sourceSurface ? { source_surface: params.sourceSurface } : {}),
  })
}

/** 资源 owner 批准申请；锁行后按申请 role 授权，幂等。 */
export async function approveResourceAccessRequest(
  requestId: string,
): Promise<ResourceAccessRequestInfo> {
  return djangoDomainRequest<ResourceAccessRequestInfo>(
    'POST',
    `/resource-access-requests/${encodeURIComponent(requestId)}/approve`,
  )
}

/** 工具栏：对当前表格/文档申请 editor。 */
export async function requestResourceEditAccess(
  resourceType: ResourceAccessResourceType,
  resourceId: string,
): Promise<ResourceAccessRequestInfo> {
  return createResourceAccessRequest({
    resourceType,
    resourceId,
    role: 'editor',
  })
}

/** 无权限空状态：直接向资源 owner 申请查看或编辑。 */
export async function requestDeniedResourceAccess(
  resourceType: ResourceAccessResourceType,
  resourceId: string,
  role: ResourceAccessRequestRole,
): Promise<ResourceAccessRequestInfo> {
  return createResourceAccessRequest({
    resourceType,
    resourceId,
    role,
    sourceSurface: 'permission_denied',
  })
}

// ── IM 任务共享（session share）───────────────────────────────────────
//
// 共享授权行是独立领域对象（chat.conversation SessionShare），IM 卡片只是
// 它的展示面（metadata.card.share_id）。发起共享走编排端点
// POST /chat/session-shares：服务端创建授权 → 建/复用双方 DM → 发卡，
// 前端不手发 session_share 卡。撤销后服务端就地刷新卡片快照并编辑原 IM
// 消息，客户端收到消息修改事件后直接采用新的完整投影。

export type SessionShareStatus = 'pending' | 'active' | 'revoked'
export type SessionShareV2Phase =
  | 'sending'
  | 'awaitingJoin'
  | 'activeView'
  | 'activeCollaborate'
  | 'deliveryUnconfirmed'
  | 'stopped'
  | 'ineligible'
export type SessionShareV2Role = 'owner' | 'recipient'

export interface SessionShareLiveStep {
  id: string
  title: string
  status: 'running' | 'done' | 'error'
}

export interface SessionShareLiveDetail {
  run_state: {
    run_id: string
    status: 'queued' | 'running' | 'waiting_user' | 'paused' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
    started_at: string | null
    state_changed_at: string | null
    ended_at: string | null
    stop_reason: string | null
    error_class: string | null
  } | null
  duration_ms: number | null
  step_count: number
  current_step: SessionShareLiveStep | null
  recent_steps: SessionShareLiveStep[]
  resources: Array<{ type: string; id: string; label: string }>
}

export interface SessionShareInfo {
  id: string
  session_id: string
  session_title: string
  /** 来源执行现场；只描述共享会话归属，不授予 Workspace 成员权限。 */
  workspace_id?: string | null
  workspace_name?: string
  owner_user_id: string
  grantee_user_id: string
  can_fork: boolean
  can_chat: boolean
  status: SessionShareStatus
  forked_session_id: string | null
  created_at: string | null
  revoked_at: string | null
  /** 仅编排端点（createSessionShare）返回：卡片所在 DM 与消息锚点 */
  conversation_id?: string
  message_id?: number
  /** 仅详情端点（getSessionShare）返回：双方展示名，供卡片渲染 */
  owner_display_name?: string
  grantee_display_name?: string
  /** 仅列表端点（listSessionShares）返回：outgoing=我共享给对方，incoming=对方共享给我 */
  direction?: SessionShareDirection
  /** 撤销已提交但 IM 卡片投影仍待同步；授权状态仍以 status=revoked 为准。 */
  card_refresh_status?: 'confirmed' | 'unconfirmed'
  /** v2 控制面字段；旧共享卡响应不包含。 */
  card_contract?: 'session_share' | 'session_share_v2'
  version?: number
  access_epoch?: number
  /** 同一任务重复分享时当前真正生效的授权；历史卡据此打开最新授权。 */
  effective_share_id?: string
  /** 任务 id；停权后 `session_id` 会清空，兄弟卡实时刷新仍靠这个字段对齐。 */
  shared_session_id?: string | null
  delivery_status?: 'pending' | 'confirmed' | 'unconfirmed' | 'rejected'
  role?: SessionShareV2Role
  phase?: SessionShareV2Phase
  access_mode?: 'view' | 'fork' | 'collaborate'
  eligibility?: { eligible: boolean; reason: string }
  actions?: {
    can_join: boolean
    can_open: boolean
    can_stop: boolean
    can_restore: boolean
    can_change_access: boolean
  }
  /** 首屏/重连快照；运行期间由协作 WS 增量覆盖。 */
  live?: SessionShareLiveDetail
}

export type SessionShareDirection = 'outgoing' | 'incoming'

export interface CreateSessionShareParams {
  sessionId: string
  granteeUserId: string
  canFork?: boolean
  canChat?: boolean
  /** 当前 TabTin 会话提示；服务端会校验双方成员，不信任前端归属。 */
  conversationId?: string
  /** 调用方持有的幂等键；同一次请求重试必须复用。 */
  clientRequestId?: string
  /** 恢复指定历史卡片；缺省表示创建一份新的独立授权。 */
  restoreShareId?: string
  /** 新客户端默认发送 v2；仅历史兼容探针显式传 session_share。 */
  cardContract?: 'session_share' | 'session_share_v2'
  accessMode?: 'view' | 'fork' | 'collaborate'
}

/** 共享会话给同 org 用户：服务端建/复用双方 DM 并把任务共享卡发进去。 */
export async function createSessionShare(
  params: CreateSessionShareParams,
): Promise<SessionShareInfo> {
  const created = await shareApiRequest<SessionShareInfo>('POST', '/chat/session-shares', {
    session_id: params.sessionId,
    grantee_user_id: params.granteeUserId,
    can_fork: params.canFork ?? false,
    can_chat: params.canChat ?? params.accessMode === 'collaborate',
    card_contract: params.cardContract ?? 'session_share_v2',
    ...(params.accessMode ? { access_mode: params.accessMode } : {}),
    ...(params.conversationId ? { conversation_id: params.conversationId } : {}),
    client_request_id: params.clientRequestId ?? createClientRequestId(),
    ...(params.restoreShareId ? { restore_share_id: params.restoreShareId } : {}),
  })
  log.info('session share orchestration succeeded', {
    event: 'im.session_share.lifecycle',
    stage: 'server_receipt',
    transport: 'django_orchestration',
    sessionId: params.sessionId,
    shareId: created.id,
    tabtinConversationId: created.conversation_id ?? null,
    tabtinMessageId: created.message_id ?? null,
  })
  return created
}

/** owner 撤销共享（幂等）；服务端刷新 DM 内该 share 的全部卡片并广播。 */
export async function revokeSessionShare(shareId: string): Promise<SessionShareInfo> {
  return shareApiRequest<SessionShareInfo>('POST', `/chat/session-shares/${shareId}/revoke`, {
    accept_committed_revoke: true,
  })
}

/** 共享详情（owner 或 grantee 可见）；撤销状态以详情为准。 */
export async function getSessionShare(shareId: string): Promise<SessionShareInfo> {
  return shareApiRequest<SessionShareInfo>('GET', `/chat/session-shares/${shareId}`)
}

interface SessionShareV2BatchItem {
  object_id: string
  ok: boolean
  detail?: SessionShareInfo & { object_id: string }
  error?: string
}

/** 新卡详情批量接口；消息快照只负责携带 object_id + version。 */
export async function batchGetSessionShareV2(
  objectIds: string[],
): Promise<SessionShareV2BatchItem[]> {
  const data = await shareApiRequest<{ items: SessionShareV2BatchItem[] }>(
    'POST',
    '/chat/session-shares/batch-get',
    { object_ids: objectIds },
  )
  return data.items ?? []
}

export async function updateSessionShareV2Access(
  shareId: string,
  accessMode: 'view' | 'fork' | 'collaborate',
): Promise<SessionShareInfo> {
  return shareApiRequest<SessionShareInfo>(
    'PATCH',
    `/chat/session-shares/${shareId}/access`,
    { access_mode: accessMode },
  )
}

export async function restoreSessionShareV2(shareId: string): Promise<SessionShareInfo> {
  return shareApiRequest<SessionShareInfo>('POST', `/chat/session-shares/${shareId}/restore`)
}

export async function retrySessionShareV2Delivery(shareId: string): Promise<SessionShareInfo> {
  return shareApiRequest<SessionShareInfo>(
    'POST',
    `/chat/session-shares/${shareId}/delivery/retry`,
  )
}

/** recipient 显式接受邀请；成功后共享权限才生效。 */
export async function acceptSessionShareV2(shareId: string): Promise<SessionShareInfo> {
  return shareApiRequest<SessionShareInfo>(
    'POST',
    `/chat/session-shares/${shareId}/accept`,
  )
}

/** 我与某对端之间的双向共享列表（DM「共享对话」面板）；含 revoked 行。 */
export async function listSessionShares(
  peerUserId: string,
  organizationId?: string,
): Promise<SessionShareInfo[]> {
  const params = new URLSearchParams({ peer_user_id: peerUserId })
  if (organizationId) params.set('organization_id', organizationId)
  const data = await shareApiRequest<{ shares: SessionShareInfo[] }>(
    'GET', `/chat/session-shares?${params.toString()}`,
  )
  return data.shares ?? []
}

/** 当前组织收到的最新有效共享任务；不依赖 IM 私聊是否已加载。 */
export async function listIncomingSessionShares(
  organizationId: string,
): Promise<SessionShareInfo[]> {
  const params = new URLSearchParams({
    organization_id: organizationId,
    direction: 'incoming',
  })
  const data = await shareApiRequest<{ shares: SessionShareInfo[] }>(
    'GET', `/chat/session-shares?${params.toString()}`,
  )
  return data.shares ?? []
}

/** 某会话的全部共享行（会话头部协作区，仅 owner 可调）；含 revoked 行。 */
export async function listSessionSharesBySession(
  sessionId: string,
): Promise<SessionShareInfo[]> {
  const params = new URLSearchParams({ session_id: sessionId })
  const data = await djangoIMRequest<{ shares: SessionShareInfo[] }>(
    'GET', `/session-shares?${params.toString()}`,
  )
  return data.shares ?? []
}

// ── 任务续接卡（发送时冻结上下文）────────────────────────────────────

export interface SessionContinuationDetail {
  object_id: string
  version: number
  role: 'owner' | 'recipient'
  title_snapshot: string
  context_status: 'complete' | 'truncated' | 'empty'
  snapshot_turn_count: number
  resource_status: 'none' | 'complete' | 'partial' | 'unavailable'
  resources: Array<{ label?: string; unavailable?: boolean; reason?: string }>
  delivery_status: 'pending' | 'confirmed' | 'unconfirmed' | 'rejected'
  creation_status: 'available' | 'failed' | 'created'
  linked_session_id: string | null
  target_workspace_id: string | null
  organization_id: string
  eligibility: { can_create: boolean; reason: string }
  created_at: string
  updated_at: string
}

export async function createSessionContinuation(params: {
  sourceSessionId: string
  recipientUserId: string
  conversationId?: string
  clientRequestId: string
  includeContext?: boolean
}): Promise<SessionContinuationDetail> {
  return shareApiRequest<SessionContinuationDetail>(
    'POST',
    '/chat/session-continuations',
    {
      source_session_id: params.sourceSessionId,
      recipient_user_id: params.recipientUserId,
      conversation_id: params.conversationId,
      client_request_id: params.clientRequestId,
      include_context: params.includeContext ?? true,
    },
  )
}

export function isContinuationLocalFileTooLargeError(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'LOCAL_FILE_TOO_LARGE'
  )
}

interface SessionContinuationBatchItem {
  object_id: string
  ok: boolean
  detail?: SessionContinuationDetail
  error?: string
}

export async function batchGetSessionContinuations(
  objectIds: string[],
): Promise<SessionContinuationBatchItem[]> {
  const data = await shareApiRequest<{ items: SessionContinuationBatchItem[] }>(
    'POST',
    '/chat/session-continuations/batch-get',
    { object_ids: objectIds },
  )
  return data.items ?? []
}

export async function createTaskFromSessionContinuation(
  objectId: string,
  params: { agentId: string; workspaceId: string; clientRequestId: string },
): Promise<SessionContinuationDetail> {
  return shareApiRequest<SessionContinuationDetail>(
    'POST',
    `/chat/session-continuations/${objectId}/create-task`,
    {
      agent_id: params.agentId,
      workspace_id: params.workspaceId,
      client_request_id: params.clientRequestId,
    },
  )
}
