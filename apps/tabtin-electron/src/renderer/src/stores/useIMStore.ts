/** @store-category domain */

/**
 * TabChat 状态管理
 *
 * 管理 IM 视图状态、会话列表、消息缓存、未读数。
 * 视图切换通过 viewNavigation 事件总线解耦，不直接依赖其他 store。
 */

import { create } from 'zustand'
import { registerResetAction } from './sessionResetRegistry'
import * as tabchatApi from '@/services/tabchatApi'
import type {
  Conversation,
  ConversationMember,
  ConversationLabel,
  IMMessage,
  SessionContinuationDetail,
  SessionShareInfo,
  UnreadSnapshot,
} from '@/services/tabchatApi'
import { emitNavigate, onNavigate } from './viewNavigation'
import { useAuthStore } from '@stores/useAuthStore'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import { useMainNavStore } from '@stores/useMainNavStore'
import { useOrganizationStore } from './useOrganizationStore'
import {
  MAX_CACHED_CONVERSATIONS,
  NOTIFICATION_DEBOUNCE_MS,
  CONVERSATION_TYPE_DM,
  CONVERSATION_TYPE_GROUP,
  MESSAGE_TYPE_TEXT,
  MESSAGE_TYPE_FILE,
  MESSAGE_TYPE_SYSTEM,
  MESSAGE_TYPE_IMAGE,
} from '@/constants/tabchat'
import { buildPreview, notificationBody, sortConversations } from '@/lib/imFormat'
import { SystemNotification } from '@/services/systemNotification'
import { dedupAsync } from '@/stores/organization/helpers'
import { useFileAttachmentStore } from '@stores/useFileAttachmentStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { buildImConversationScopeKey } from '@components/layout/workspaceContextState'
import { createLogger } from '@/utils/logger'
import { queryClient } from '@/lib/query-client'
import { invalidateMembershipQuotaUsage } from '@/hooks/queries/membership'
import {
  mergeAndSortMessages,
  compareMessages,
  messagesShareStableIdentity,
  preserveUnchangedMessageReferences,
} from '@/services/im/messageMerge'
import {
  getTabTinMessageReference,
  isPendingTabTinReferenceMessage,
} from '@/services/im/tabtinReferenceMessages'
import { isIMMessageContentWithinLimit } from '@/services/im/imMessageLimits'
import { canSendToExternalConversation } from '@/services/im/externalConversationPolicy'
import { useUserProfileCache } from '@stores/useUserProfileCache'

const log = createLogger('TabChat')
const CLIENT_LOCAL_PATH_METADATA_KEY = '__client_local_path'
const ATTACHMENT_RUNTIME_METADATA_KEYS = [
  'access_url', 'cdn_url', 'download_url', 'presigned_url', 'remote_url', 'preview_url', 'thumbnail_url',
] as const
/** 直接定位到的历史消息必须穿过晚到的「最新页」响应，避免目标窗口被覆盖丢失。 */
const _navigationTargets = new Map<string, { id: number; messageRef?: string }>()

async function resolveDefaultGroupName(
  organizationId: string,
  memberIds: string[],
  externalContactIds: string[],
): Promise<string> {
  const organizationStore = useOrganizationStore.getState()
  if (memberIds.some((id) => !organizationStore.members.some((member) => member.user_id === id))) {
    try {
      await organizationStore.loadMembers(organizationId)
    } catch {
      // 创建群聊不应被默认名称查询失败阻断。
    }
  }

  const membersById = new Map(
    useOrganizationStore.getState().members.map((member) => [member.user_id, member]),
  )
  const names = memberIds.map((id) => {
    const member = membersById.get(id)
    return member?.user?.nickname || member?.user?.username || ''
  })

  if (externalContactIds.length > 0) {
    const contacts = await tabchatApi.listExternalContacts(organizationId).catch(() => ({ items: [] }))
    const contactsById = new Map(contacts.items.map((contact) => [contact.contact_id, contact.display_name]))
    names.push(...externalContactIds.map((id) => contactsById.get(id) || ''))
  }

  return names.filter(Boolean).slice(0, 5).join('、') || 'Group'
}

function conversationReferenceFromMessage(
  message: IMMessage | undefined,
): Conversation['last_message_reference'] {
  if (!message) return null
  const reference = getTabTinMessageReference(message.metadata)
  return reference
    ? {
        message_ref: reference.messageRef,
        tabtin_message_id: reference.tabtinMessageId,
      }
    : null
}

function sameConversationReference(
  left: Conversation['last_message_reference'],
  right: Conversation['last_message_reference'],
): boolean {
  return Boolean(
    left
    && right
    && left.message_ref === right.message_ref
    && left.tabtin_message_id === right.tabtin_message_id,
  )
}

function matchesMessageForMutation(current: IMMessage, incoming: IMMessage): boolean {
  const currentRef = current.metadata.message_ref
  const incomingRef = incoming.metadata.message_ref
  if (currentRef && incomingRef && currentRef === incomingRef) return true

  // Django 撤回事件只携带 message_id。Mapper 会为事件合成字符串引用，
  // 它与实时消息中的 UUID 引用不同；群消息 ID 在会话内唯一，可安全兜底。
  // C2C 的双方序号可能重复，仍必须只按稳定引用匹配。
  return current.transport?.kind !== 'c2c'
    && incoming.transport?.kind !== 'c2c'
    && current.id === incoming.id
}

function replyTargetsMessage(current: IMMessage, target: IMMessage): boolean {
  const targetRef = target.metadata.message_ref
  if (targetRef && current.reply_to_ref === targetRef) return true
  return current.transport?.kind !== 'c2c'
    && target.transport?.kind !== 'c2c'
    && current.reply_to_id === target.id
}

function mergeHydratedReferencePreview(
  conversation: Conversation,
  messages: readonly IMMessage[] | undefined,
): Conversation {
  const expectedReference = conversation.last_message_reference
  if (!expectedReference || !messages) return conversation

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (
      message.conversation_id !== conversation.id
      || message.is_deleted
      || message._optimistic
      || message._failed
      || isPendingTabTinReferenceMessage(message)
    ) {
      continue
    }
    const reference = getTabTinMessageReference(message.metadata)
    if (
      !reference
      || reference.messageRef !== expectedReference.message_ref
      || reference.tabtinMessageId !== expectedReference.tabtin_message_id
    ) {
      continue
    }
    return {
      ...conversation,
      last_message_preview: buildPreview(
        message,
        conversation.type === CONVERSATION_TYPE_GROUP,
      ),
    }
  }
  return conversation
}

function mergeConversationUpdate(
  conversation: Conversation,
  updates: Partial<Conversation>,
  messages: readonly IMMessage[] | undefined,
): Conversation {
  const latestLocalMessage = [...(messages ?? [])]
    .reverse()
    .find((message) => (
      !message.is_deleted
      && !message._optimistic
      && !message._failed
      && !isPendingTabTinReferenceMessage(message)
      && message.metadata?.kind !== 'agent_progress'
      && message.metadata?.kind !== 'agent_stream'
    ))
  const localMessageTime = latestLocalMessage
    && typeof latestLocalMessage.created_at === 'string'
    ? Date.parse(latestLocalMessage.created_at)
    : Number.NaN
  const incomingSummaryTime = typeof updates.last_message_at === 'string'
    ? Date.parse(updates.last_message_at)
    : Number.NaN
  const preserveNewerLocalSummary = Boolean(
    latestLocalMessage
    && typeof updates.last_message_preview === 'string'
    && Number.isFinite(localMessageTime)
    && Number.isFinite(incomingSummaryTime)
    && localMessageTime > incomingSummaryTime,
  )
  const preserveRecalledSummary = Number.isFinite(incomingSummaryTime)
    && typeof updates.last_message_preview === 'string'
    && Boolean(messages?.some((message) => (
      message.is_deleted
      && typeof message.created_at === 'string'
      && Date.parse(message.created_at) === incomingSummaryTime
    )))
  const preserveResolvedPreview = (
    typeof updates.last_message_preview === 'string'
    && updates.last_message_reference !== undefined
    && sameConversationReference(
      conversation.last_message_reference,
      updates.last_message_reference,
    )
  )
  // 清空历史 / 目录缺热字段时远端会给空 last_message_at；丢掉本地时间会让
  // 私聊按 created_at 沉底。预览仍可被清空。
  const preserveLastMessageAt = !updates.last_message_at && Boolean(conversation.last_message_at)
  const preserveAuthoritativePin = (
    conversation.pinned_source === 'tabtin'
    && updates.pinned_source !== 'tabtin'
  ) || (
    conversation.pinned_source === 'tabtin'
    && updates.pinned_source === 'tabtin'
    && conversation.pinned_revision !== undefined
    && updates.pinned_revision !== undefined
    && updates.pinned_revision <= conversation.pinned_revision
  )
  return mergeHydratedReferencePreview(
    {
      ...conversation,
      ...updates,
      ...(preserveAuthoritativePin
        ? {
            pinned: conversation.pinned,
            pinned_source: conversation.pinned_source,
            pinned_revision: conversation.pinned_revision,
          }
        : {}),
      ...(preserveResolvedPreview
        ? { last_message_preview: conversation.last_message_preview }
        : {}),
      ...(preserveLastMessageAt
        ? { last_message_at: conversation.last_message_at }
        : {}),
      ...(preserveNewerLocalSummary && latestLocalMessage
        ? {
            last_message_at: latestLocalMessage.created_at,
            last_message_preview: buildPreview(
              latestLocalMessage,
              conversation.type === CONVERSATION_TYPE_GROUP,
            ),
            last_message_reference:
              conversationReferenceFromMessage(latestLocalMessage),
          }
        : {}),
      ...(preserveRecalledSummary
        ? {
            last_message_at: conversation.last_message_at,
            last_message_preview: conversation.last_message_preview,
            last_message_reference: conversation.last_message_reference,
          }
        : {}),
    },
    messages,
  )
}

export interface SendMessageOptions {
  convId: string
  content: string
  metadata?: Record<string, unknown>
  replyTo?: IMMessage
  replyToPreview?: IMMessage['reply_to_preview']
  messageType?: number
  /** 失败消息重试时复用的后端幂等键；仅 store 内部 retryFailedMessage 使用。 */
  clientRequestId?: string
  /** 同一乐观气泡的重试标记，避免新建重复消息。 */
  retryExisting?: boolean
}

export interface CreateConversationOptions {
  organizationId: string
  kind: 'dm' | 'group'
  memberIds: string[]
  externalContactIds?: string[]
  groupName?: string
  spaceId?: string
  activate?: boolean
  clientRequestId?: string
}

interface RealtimeMessageOptions {
  /** Provider emits an absolute unread snapshot separately from message events. */
  incrementUnread?: boolean
}

type IMSendError = 'sendFailed' | 'messageTooLong' | 'blockedByPeer' | 'removedFromGroup'
type IMLoadError =
  | 'loadConversationsFailed'
  | 'loadMessagesFailed'
  | 'markReadFailed'
  | 'loadUnreadFailed'

export type SessionShareLoadState = 'idle' | 'loading' | 'loaded' | 'error'

export interface SessionShareStoreEntry {
  /** IM 卡片投影先写入局部字段，详情接口随后补齐完整授权对象。 */
  detail: (Partial<SessionShareInfo> & Pick<SessionShareInfo, 'id'>) | null
  loadState: SessionShareLoadState
  /** 至少成功读取过一次完整详情；仅有 IM 卡片投影时为 false。 */
  detailLoaded: boolean
  /** 仅表达接口明确返回 403/404；revoked 直接由 detail.status 判定。 */
  accessDenied: boolean
}

export interface SessionContinuationStoreEntry {
  detail: SessionContinuationDetail | null
  loadState: SessionShareLoadState
  accessDenied: boolean
}

function isSessionShareAccessDenied(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { status?: unknown; statusCode?: unknown }
  const status = typeof candidate.status === 'number'
    ? candidate.status
    : candidate.statusCode
  return status === 403 || status === 404
}

function sessionShareProjectionFromMessage(message: IMMessage): {
  shareId: string
  patch: Partial<Omit<SessionShareInfo, 'id'>>
} | null {
  const card = message.metadata?.card
  if (card?.type === 'session_share_v2' && card.object_id) {
    return {
      shareId: card.object_id,
      patch: {
        card_contract: 'session_share_v2',
        ...(typeof card.version === 'number' ? { version: card.version } : {}),
      },
    }
  }
  if (card?.type !== 'session_share' || !card.share_id) return null
  const patch: Partial<Omit<SessionShareInfo, 'id'>> = {}
  if (card.session_id) patch.session_id = card.session_id
  if (card.session_title !== undefined) patch.session_title = card.session_title
  if (card.can_fork !== undefined) patch.can_fork = card.can_fork
  if (card.can_chat !== undefined) patch.can_chat = card.can_chat
  if (card.status === 'active' || card.status === 'revoked') patch.status = card.status
  return { shareId: card.share_id, patch }
}

function didSessionShareProjectionChange(
  previous: IMMessage | undefined,
  next: IMMessage,
): boolean {
  const previousProjection = previous ? sessionShareProjectionFromMessage(previous) : null
  const nextProjection = sessionShareProjectionFromMessage(next)
  if (!nextProjection) return false
  if (!previousProjection || previousProjection.shareId !== nextProjection.shareId) return true
  if (
    previous?.metadata?.business_projection_revision
    !== next.metadata?.business_projection_revision
  ) return true
  const previousPatch = previousProjection.patch
  const nextPatch = nextProjection.patch
  return previousPatch.session_id !== nextPatch.session_id
    || previousPatch.session_title !== nextPatch.session_title
    || previousPatch.can_fork !== nextPatch.can_fork
    || previousPatch.can_chat !== nextPatch.can_chat
    || previousPatch.status !== nextPatch.status
    || previousPatch.version !== nextPatch.version
    || previousPatch.card_contract !== nextPatch.card_contract
}

export type IMSidebarView = 'inbox' | 'contacts'
export type IMContactsTab = 'internal' | 'external' | 'incoming' | 'outgoing' | 'blocked'

interface IMState {
  isIMActive: boolean
  conversations: Conversation[]
  currentConversationId: string | null
  /** 每个 organization 最近实际打开的会话；切出消息 tab 时仍保留，用于再次进入时恢复。 */
  lastOpenedConversationIdByOrganization: Record<string, string>
  messages: Record<string, IMMessage[]>
  /** 服务端确认的会话成员快照；成员事件和所有渲染消费者共用这一份。 */
  conversationMembers: Record<string, ConversationMember[] | undefined>
  conversationMembersLoading: Record<string, boolean>
  hasMoreMessages: Record<string, boolean>
  unreadCounts: Record<string, number>
  totalUnread: number
  isLoadingConversations: boolean
  /** 每个会话独立维护消息请求状态，避免切换会话时互相串扰。 */
  messageLoadingByConversation: Record<string, boolean>
  isSending: boolean
  connectionStatus: 'disconnected' | 'connecting' | 'connected'
  sessionKicked: boolean
  authFailed: boolean
  sendError: IMSendError | null
  loadError: IMLoadError | null
  /** 已读回执：{ convId: { userId: lastReadMessageId } } */
  readReceipts: Record<string, Record<string, number>>
  /** 置顶消息：{ convId: IMMessage[] }（最近置顶在前，全员共享，功能3） */
  pinnedMessages: Record<string, IMMessage[]>
  /** 搜索跳转目标会话 ID，用于避免跨会话误消费 */
  scrollTargetConversationId: string | null
  /** 搜索跳转目标消息 ID，消费后自动清除 */
  scrollToMessageId: number | null
  /** C2C 的 MsgSeq 仅在发送方内递增；精确定位必须优先使用 message_ref。 */
  scrollToMessageRef: string | null
  /** 消息侧栏次级视图：会话列表语境或通讯录主画布。 */
  imSidebarView: IMSidebarView
  /** 通讯录当前分类；通知可以直接打开待处理申请。 */
  imContactsTab: IMContactsTab

  // ── TC-37：会话 label ──
  /** 当前 organization 的 label 库（含系统 @me，按需加载） */
  labels: ConversationLabel[]
  /** 当前激活的 label 筛选 id 集（AND 语义） */
  activeLabelFilters: string[]
  /** activeLabelFilters 所属的 organization；跨组织请求绝不能复用它。 */
  activeLabelFiltersOrganizationId: string | null
  /** label 库是否已加载（避免重复拉） */
  labelsLoadedOrganizationId: string | null

  // ── IM 上下文交接：卡片重拉版本号 ──
  /** 每个交接包一个单调递增版本；IM 卡片投影变化时 +1，触发 HandoffCard 重拉详情 */
  handoffVersions: Record<string, number>
  /**
   * 每个 IM 会话一个单调递增版本；新建/撤销/改权任务共享时 +1，
   * 触发 ImSharedSessionsPane（「共享对话」侧栏）重拉列表。
   */
  sessionShareListVersions: Record<string, number>
  /**
   * 每个 SessionShare 一个单调递增版本（，对齐 handoffVersions）：
   * 撤销 / 改权 / 新卡到达时 +1，触发普通对话页 / SessionShareCard 重拉详情。
   */
  sessionShareDetailVersions: Record<string, number>
  /** SessionShare 授权对象的客户端唯一缓存；卡片和共享工作台共同订阅。 */
  sessionShares: Record<string, SessionShareStoreEntry>
  /** 续接卡权威详情；消息只提供 object_id/version，不保存业务快照。 */
  sessionContinuations: Record<string, SessionContinuationStoreEntry>

  openIM: () => void
  closeIM: () => void
  setImSidebarView: (view: IMSidebarView) => void
  setImContactsTab: (tab: IMContactsTab) => void
  setCurrentConversation: (id: string | null) => void
  navigateToMessage: (
    convId: string,
    target: number | Pick<IMMessage, 'id' | 'transport' | 'metadata'>,
  ) => void
  /** 收到 IM 卡片投影变化时调用，使对应 HandoffCard 重新拉取详情 */
  bumpHandoffVersion: (handoffId: string) => void
  /** 触发指定 IM 会话的「共享对话」列表重拉 */
  bumpSessionShareListVersion: (conversationId: string) => void
  /** 触发指定 share 详情重拉（查看页 / 卡片） */
  bumpSessionShareDetailVersion: (shareId: string) => void
  /** 用详情接口刷新并写入唯一 SessionShare 缓存。 */
  loadSessionShare: (shareId: string) => Promise<SessionShareInfo | null>
  /** v2 消息仅带对象引用；批量详情接口是状态与权限真相。 */
  loadSessionShareV2: (
    shareId: string,
    minimumVersion?: number,
  ) => Promise<SessionShareInfo | null>
  loadSessionContinuation: (
    objectId: string,
    minimumVersion?: number,
  ) => Promise<SessionContinuationDetail | null>
  setSessionContinuation: (detail: SessionContinuationDetail) => void
  /** 写入详情接口或生命周期接口返回的完整 SessionShare。 */
  setSessionShare: (share: SessionShareInfo) => void
  /** 合并 IM 卡片携带的 SessionShare 投影，不把部分字段伪装成完整详情。 */
  patchSessionShare: (
    shareId: string,
    patch: Partial<Omit<SessionShareInfo, 'id'>>,
  ) => void
  /** 共享内容接口明确拒绝访问时写入 Store，页面不再维护局部 denied。 */
  denySessionShareAccess: (shareId: string) => void
  /** 用服务端详情校准已加载的共享卡，并刷新共享列表与详情。 */
  reconcileSessionShareStatus: (update: {
    share_id: string
    conversation_id: string
    status: string
    message_id?: number | null
  }) => void
  clearScrollTarget: (target?: { conversationId: string; messageId: number; messageRef?: string }) => void
  loadConversations: (organizationId: string) => Promise<void>
  createConversationAndActivate: (
    options: CreateConversationOptions
  ) => Promise<string>
  loadMessages: (
    convId: string,
    before?: Pick<IMMessage, 'transport' | 'metadata'>,
    options?: { force?: boolean },
  ) => Promise<IMMessage[]>
  sendMessage: (options: SendMessageOptions) => Promise<boolean>
  /** 原地重试失败的乐观消息，复用首次发送的 client_request_id。 */
  retryFailedMessage: (message: IMMessage) => Promise<void>
  markAsRead: (convId: string) => Promise<void>
  loadUnreadCounts: (organizationId: string) => Promise<void>
  applyUnreadSnapshot: (organizationId: string, snapshot: UnreadSnapshot) => void
  resetIMState: () => void
  setConnectionStatus: (
    status: 'disconnected' | 'connecting' | 'connected',
    reason?: 'kicked_out',
  ) => void
  setAuthFailed: () => void
  clearAuthFailed: () => void
  dismissSendError: () => void
  dismissLoadError: () => void

  updateConversation: (convId: string, updates: Partial<Conversation>) => void
  refreshConversationMembers: (
    convId: string,
    options?: {
      supersede?: boolean
      invalidateSnapshot?: boolean
      expectedMemberCount?: number
      expectMembershipChange?: boolean
    },
  ) => Promise<void>
  removeConversation: (convId: string) => void
  /** 清空本地缓存的会话消息（清空聊天记录后调用，只影响本地视图） */
  clearConversationMessages: (convId: string) => void

  // ── TC-37：会话 label actions ──
  /** 加载当前 organization 的 label 库（含系统 @me） */
  loadLabels: (organizationId: string, force?: boolean) => Promise<void>
  /** 切换 label 筛选（AND 语义） */
  toggleLabelFilter: (labelId: string) => void
  /** 清空 label 筛选 */
  clearLabelFilters: () => void
  /** 创建 label 并刷新 label 库 */
  createLabel: (organizationId: string, name: string, color?: string) => Promise<ConversationLabel>
  /** 改名 / 改色 label 并刷新 label 库 */
  updateLabel: (labelId: string, updates: { name?: string; color?: string }, organizationId: string) => Promise<void>
  /** 删除 label 并刷新 label 库 + 撕掉所有会话的该 label */
  deleteLabel: (labelId: string, organizationId: string) => Promise<void>
  /** 给会话追加 label（乐观更新） */
  addLabelsToConversation: (convId: string, labelIds: string[]) => Promise<void>
  /** 撕掉会话的某个 label（乐观更新） */
  removeLabelFromConversation: (convId: string, labelId: string) => Promise<void>

  onRealtimeMessage: (
    convId: string,
    message: IMMessage,
    options?: RealtimeMessageOptions,
  ) => void
  removePendingMessageByRef: (convId: string, messageRef: string) => void
  onMessageDeleted: (convId: string, message: IMMessage, recalledContent?: string) => void
  onUnreadUpdate: (convId: string, notify?: UnreadNotifyInfo) => void
  onNewConversation: (convData?: Partial<Conversation>) => void
  onReadReceipt: (
    convId: string,
    userId: string,
    lastReadMessageId: number,
    lastReadSeq?: number,
    previousLastReadSeq?: number,
  ) => void
  onReactionUpdated: (
    convId: string,
    messageRef: string,
    emoji: string,
    userId: string,
    action: 'add' | 'remove',
    source?: 'local' | 'remote',
  ) => void
  onReactionSnapshot: (
    convId: string,
    messageRef: string,
    reactions: Record<string, string[]>,
    reactionCounts: Record<string, number>,
  ) => void

  loadPinnedMessages: (convId: string) => Promise<void>
  onMessagePinned: (convId: string, message: IMMessage) => void
  onMessageUnpinned: (convId: string, messageId: number) => void
  onMessageEdited: (convId: string, message: IMMessage) => void
}

let _sendingCount = 0
// 同一失败气泡的 retry 在首个 await 前就加锁，避免双击并发发送相同幂等键。
const retryingMessageIds = new Set<string>()
const _latestConversationsLoadRequestIds = new Map<string, number>()
const _latestMessageLoadRequestIds = new Map<string, number>()
const _latestSessionShareLoadRequestIds = new Map<string, number>()
type SessionShareV2Load = { minimumVersion: number; requestId: number; attempt: number }
const _pendingSessionShareV2Loads = new Map<string, SessionShareV2Load>()
const _activeSessionShareV2Loads = new Map<string, SessionShareV2Load>()
const _latestSessionContinuationLoadRequestIds = new Map<string, number>()
const _latestConversationMemberRequestIds = new Map<string, number>()
const _pinnedMessageStateRevisions = new Map<string, number>()
const _conversationMemberRequests = new Map<
  string,
  {
    requestId: number
    promise: Promise<void>
    baselineIdentityKey: string | undefined
    hasProjectionBarrier: boolean
  }
>()
let _nextConversationMemberRequestId = 0
const MEMBERSHIP_RECONCILIATION_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const
let _latestLabelsLoadRequestId = 0
const _imInFlight = new Map<string, Promise<void>>()
const SESSION_SHARE_V2_BATCH_FLIGHT_KEY = 'session-shares:v2:batch'
const SESSION_SHARE_V2_BATCH_SIZE = 100
const _unreadDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const _filteredUnreadRepairSkips = new Set<string>()
interface LocalReactionSnapshot {
  reactions: NonNullable<IMMessage['reactions']>
  counts: NonNullable<IMMessage['reaction_counts']>
}

const _reactionSnapshotsByReference = new Map<string, LocalReactionSnapshot>()

function reactionSnapshotKey(conversationId: string, messageRef: string): string {
  return `${conversationId}:${messageRef}`
}

function reactionIdentityRefs(message: IMMessage): string[] {
  return [
    typeof message.metadata.message_ref === 'string' ? message.metadata.message_ref.trim() : '',
    typeof message.metadata.tabtin_message_id === 'string'
      ? message.metadata.tabtin_message_id.trim()
      : '',
    String(message.id),
  ].filter(Boolean)
}

function resolveCanonicalReactionRef(
  conversationId: string,
  messageRef: string,
): { canonicalRef: string; message?: IMMessage } {
  const messages = useIMStore.getState().messages[conversationId] ?? []
  const message = messages.find((candidate) => reactionIdentityRefs(candidate).includes(messageRef))
  const canonicalRef = message
    && typeof message.metadata.message_ref === 'string'
    && message.metadata.message_ref.trim()
    ? message.metadata.message_ref.trim()
    : messageRef
  return { canonicalRef, message }
}

function seedReactionSnapshotFromMessage(
  conversationId: string,
  canonicalRef: string,
  message: IMMessage | undefined,
): void {
  const key = reactionSnapshotKey(conversationId, canonicalRef)
  if (_reactionSnapshotsByReference.has(key) || !message) return
  if (!message.reactions && !message.reaction_counts) return
  _reactionSnapshotsByReference.set(key, {
    reactions: Object.fromEntries(
      Object.entries(message.reactions ?? {}).map(([emoji, users]) => [emoji, [...users]]),
    ),
    counts: {
      ...(message.reaction_counts ?? Object.fromEntries(
        Object.entries(message.reactions ?? {}).map(([emoji, users]) => [emoji, users.length]),
      )),
    },
  })
}

function conversationMemberIdentityKey(members: readonly ConversationMember[]): string {
  return members
    .map((member) => member.agent_id
      ? `agent:${member.agent_id}`
      : `user:${member.user_id ?? ''}`)
    .sort()
    .join('|')
}

function waitForConversationMemberRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function updateReactionSnapshot(
  conversationId: string,
  messageRef: string,
  emoji: string,
  userId: string,
  action: 'add' | 'remove',
  source: 'local' | 'remote' = 'local',
): LocalReactionSnapshot {
  const key = reactionSnapshotKey(conversationId, messageRef)
  const current = _reactionSnapshotsByReference.get(key) ?? {
    reactions: {},
    counts: {},
  }
  const reactions = Object.fromEntries(
    Object.entries(current.reactions).map(([key, users]) => [key, [...users]]),
  )
  const counts = { ...current.counts }
  const users = [...(reactions[emoji] ?? [])]
  const hadUser = users.includes(userId)
  if (action === 'add') {
    if (!hadUser) users.push(userId)
  } else {
    const index = users.indexOf(userId)
    if (index >= 0) users.splice(index, 1)
  }
  const hasNativeCount = Object.hasOwn(counts, emoji)
  const previousUserCount = action === 'add'
    ? users.length - (hadUser ? 0 : 1)
    : users.length + (hadUser ? 1 : 0)
  const currentCount = Math.max(0, counts[emoji] ?? 0)
  const isNativeExactCount = hasNativeCount && currentCount !== previousUserCount
  if (isNativeExactCount && source === 'remote') {
    // Provider 快照的 userIds 是 provider id，控制消息是 TabTin user id。
    // 远端控制消息只补身份，不改已经权威的精确计数。
    counts[emoji] = currentCount
  } else if (hasNativeCount && source === 'local') {
    const acknowledgedDelta = action === 'add'
      ? (hadUser ? 0 : 1)
      : (hadUser ? -1 : 0)
    counts[emoji] = Math.max(currentCount + acknowledgedDelta, users.length)
  } else {
    counts[emoji] = users.length
  }
  if (users.length || counts[emoji] > 0) reactions[emoji] = users
  else {
    delete reactions[emoji]
    delete counts[emoji]
  }
  const snapshot = { reactions, counts }
  _reactionSnapshotsByReference.set(key, snapshot)
  return snapshot
}

function overlayLocalReactionSnapshot(
  conversationId: string,
  message: IMMessage,
): IMMessage {
  const messageRef = typeof message.metadata.message_ref === 'string'
    ? message.metadata.message_ref.trim()
    : ''
  if (!messageRef) return message
  const local = reactionIdentityRefs(message)
    .map((ref) => _reactionSnapshotsByReference.get(reactionSnapshotKey(conversationId, ref)))
    .find((snapshot) => snapshot != null)
  if (local) {
    return {
      ...message,
      reactions: local.reactions,
      reaction_counts: local.counts,
    }
  }
  if (message.reactions || message.reaction_counts) {
    _reactionSnapshotsByReference.set(reactionSnapshotKey(conversationId, messageRef), {
      reactions: message.reactions ?? {},
      counts: message.reaction_counts ?? Object.fromEntries(
        Object.entries(message.reactions ?? {}).map(([emoji, users]) => [
          emoji,
          users.length,
        ]),
      ),
    })
  }
  return message
}

interface CachedIdentity { id: string; nickname: string }
let _cachedIdentity: CachedIdentity | null = null
let _authUnsubscribe: (() => void) | null = null

async function getCachedIdentity(): Promise<CachedIdentity> {
  if (_cachedIdentity?.id) return _cachedIdentity
  try {
    const user = useAuthStore.getState().user
    _cachedIdentity = {
      id: user?.id || '',
      nickname: user?.nickname || user?.username || '',
    }

    if (!_authUnsubscribe) {
      _authUnsubscribe = useAuthStore.subscribe(
        (state) => state.user?.id,
        () => { _cachedIdentity = null },
      )
    }

    return _cachedIdentity
  } catch (err) {
    log.warn('getCachedIdentity failed:', err)
    return { id: '', nickname: '' }
  }
}

/**
 * 已读水位只能用服务端已确认的正数 message id。
 * 乐观消息占位 `id: -1`，若原样上报会触发「消息不存在或不属于当前会话」。
 */
function resolveMarkReadLastMessage(messages: IMMessage[] | undefined): IMMessage['transport'] {
  if (!messages?.length) return undefined
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message._optimistic && message.transport) {
      return message.transport
    }
  }
  return undefined
}

// 防抖：同一会话短时间内只发一次通知
const _notifDebounceMap = new Map<string, number>()

function shouldShowNotification(convId: string): boolean {
  const now = Date.now()
  const last = _notifDebounceMap.get(convId) || 0
  if (now - last < NOTIFICATION_DEBOUNCE_MS) return false
  _notifDebounceMap.set(convId, now)
  return true
}

function upsertConversationList(
  conversations: Conversation[],
  nextConversation: Conversation,
): Conversation[] {
  const exists = conversations.some((conversation) => conversation.id === nextConversation.id)
  return sortConversations(
    exists
      ? conversations.map((conversation) =>
          conversation.id === nextConversation.id
            ? mergeConversation(conversation, nextConversation)
            : conversation,
        )
      : [...conversations, nextConversation],
  )
}

/**
 * 合并会话：浅合并，但不让目录详情里的空展示字段覆盖已有的热数据。
 * DM 的名字/头像按观察者解析，某些接口（如会话详情）顶层 name 可能为空；
 * 直接覆盖会让侧栏名退回「私聊」。名字不会被合法地清空，故保留旧值是安全的。
 * ConversationDirectory 不拥有最新消息与排序；详情未携带 last_message_at 时，
 * 必须成对保留实时会话列表已有的时间和预览，否则从通讯录打开已有 DM 会按
 * created_at 重新排序并突然下沉。
 */
function mergeConversation(
  prev: Conversation,
  next: Conversation,
  messages?: readonly IMMessage[],
): Conversation {
  const merged = { ...prev, ...next }
  if (
    (prev.pinned_source === 'tabtin' && next.pinned_source !== 'tabtin')
    || (
      prev.pinned_source === 'tabtin'
      && next.pinned_source === 'tabtin'
      && prev.pinned_revision !== undefined
      && next.pinned_revision !== undefined
      && next.pinned_revision <= prev.pinned_revision
    )
  ) {
    merged.pinned = prev.pinned
    merged.pinned_source = prev.pinned_source
    merged.pinned_revision = prev.pinned_revision
  }
  if (!next.name && prev.name) merged.name = prev.name
  if (!next.avatar_url && prev.avatar_url) merged.avatar_url = prev.avatar_url
  if (!next.last_message_at && prev.last_message_at) {
    merged.last_message_at = prev.last_message_at
    merged.last_message_preview = prev.last_message_preview
  }
  return messages === undefined
    ? merged
    : mergeConversationUpdate(prev, merged, messages)
}

function applyConversationMemberCount(
  conversation: Conversation,
  memberCount: number,
  allowDmReactivation = true,
): Conversation {
  if (conversation.type !== CONVERSATION_TYPE_DM) {
    return { ...conversation, member_count: memberCount }
  }
  const canSend = memberCount >= 2 && allowDmReactivation
  return {
    ...conversation,
    member_count: memberCount,
    can_send: canSend,
    dm_peer_membership_status: canSend ? 'active' : 'removed',
  }
}

function unreadRepairSkipKey(organizationId: string, conversationId: string, labelIds: string[]): string {
  return `${organizationId}:${conversationId}:${[...labelIds].sort().join(',')}`
}

function conversationMatchesLabelFilters(conversation: Conversation, labelIds: string[]): boolean {
  if (labelIds.length === 0) return true
  const conversationLabelIds = new Set((conversation.labels ?? []).map((label) => label.id))
  return labelIds.every((labelId) => conversationLabelIds.has(labelId))
}

/**
 * 当前会话是否在用户视野内（用于已读/桌面通知抑制；#6262 mention 路径复用）。
 *
 * ：不可仅凭 `isIMActive` / `currentConversationId` 残留判定——用户切到
 * workspace Space 后若未清干净 IM 态，会误抑制桌面通知。须与 shell 主工作台
 * 对齐：侧栏明确选中会话，或消息主导航下 IM 面板真正打开。
 */
export function isConversationVisibleForRead(
  convId: string,
  state: Pick<IMState, 'currentConversationId' | 'isIMActive'>,
): boolean {
  if (state.currentConversationId !== convId) return false
  if (document.visibilityState !== 'visible') return false
  const currentTab = useMainNavStore.getState().currentTab
  if (currentTab === 'me') return false

  const selectionKind = useSpaceListStore.getState().selectedSpaceKind
  if (selectionKind === 'dm' || selectionKind === 'im-group') return true

  // 侧栏已离开会话导航时，不以 isIMActive + 消息 tab 残留继续抑制
  if (selectionKind === 'workspace' || selectionKind === 'team') return false

  // selectedSpaceKind 为空：打开「消息」尚未写成 dm/im-group 的过渡态
  return state.isIMActive && currentTab === 'im'
}

/** 群聊收件人近似人数：成员数减去自己；至少 1，避免进度环除零。 */
function defaultGroupRecipientCount(memberCount: number | undefined): number {
  return Math.max(1, (memberCount ?? 1) - 1)
}

interface DesktopNotifContext {
  convId: string
  message: IMMessage
  matchedConv: Conversation | undefined
  isCurrentConv: boolean
}

function resolveDesktopNotificationTitle(
  conversation: Conversation | undefined,
  senderName: string | undefined,
): string {
  const conversationName = conversation?.name?.trim() || '新消息'
  if (conversation?.type === CONVERSATION_TYPE_GROUP) return conversationName
  return senderName?.trim() || conversationName
}

function handleDesktopNotification({ convId, message, matchedConv, isCurrentConv }: DesktopNotifContext) {
  const isMuted = matchedConv?.is_muted
  if ((isCurrentConv && document.hasFocus()) || isMuted) return
  void (async () => {
    try {
      const { id: myId } = await getCachedIdentity()
      if (myId && message.sender_id === myId) return
      if (!shouldShowNotification(convId)) return
      const convName = matchedConv?.name?.trim() || '新消息'
      const isGroup = matchedConv?.type === CONVERSATION_TYPE_GROUP
      const body = notificationBody(message, Boolean(isGroup))
      const messageRef = typeof message.metadata?.message_ref === 'string'
        ? message.metadata.message_ref.trim() || undefined
        : undefined
      if (message.metadata?.team_space_agent_update) {
        const sessionId = typeof message.metadata.session_id === 'string' ? message.metadata.session_id : undefined
        SystemNotification.imAgentTaskUpdate({
          title: convName,
          body,
          conversationId: convId,
          organizationId: matchedConv?.organization_id,
          sessionId,
          messageRef,
        })
        return
      }
      SystemNotification.imMessage({
        title: resolveDesktopNotificationTitle(matchedConv, message.sender_name),
        body,
        conversationId: convId,
        organizationId: matchedConv?.organization_id,
        messageRef,
      })
    } catch (err) { log.warn('desktop notification failed:', err) }
  })()
}

/**
 * TC-4：非当前会话收到新消息时的桌面通知。
 *
 * im.message 仅推到 chat:{convId}（前端仅订阅当前打开会话），未打开会话收不到，
 * 因此非当前会话的通知改由 personal 频道的 unread.update 携带内容触发。与
 * handleDesktopNotification（onRealtimeMessage 路径）天然互斥：后者只覆盖当前
 * 订阅的会话，本函数只在 onUnreadUpdate 的非当前会话分支调用。muted / self /
 * 防抖抑制逻辑与 handleDesktopNotification 对齐。
 */
export interface UnreadNotifyInfo {
  senderId?: string
  senderName?: string
  preview: string
  organizationId?: string
  mention?: boolean
}

function showUnreadDesktopNotification(
  convId: string,
  notify: UnreadNotifyInfo,
  conversations: Conversation[],
) {
  const matchedConv = conversations.find((c) => c.id === convId)
  if (matchedConv?.is_muted) return
  void (async () => {
    try {
      const { id: myId } = await getCachedIdentity()
      if (myId && notify.senderId && notify.senderId === myId) return
      if (!shouldShowNotification(convId)) return
      const convName = matchedConv?.name?.trim() || '新消息'
      const isAgentUpdate = matchedConv?.name === '#agent-updates'
      const body = formatGroupUnreadNotificationBody(matchedConv, notify)
      if (isAgentUpdate) {
        SystemNotification.imAgentTaskUpdate({
          title: convName,
          body,
          conversationId: convId,
          organizationId: matchedConv?.organization_id ?? notify.organizationId,
        })
        return
      }
      SystemNotification.imMessage({
        title: resolveDesktopNotificationTitle(matchedConv, notify.senderName),
        body,
        conversationId: convId,
        organizationId: matchedConv?.organization_id ?? notify.organizationId,
      })
    } catch (err) { log.warn('unread desktop notification failed:', err) }
  })()
}

/** 群聊未读通知：preview 未带发送人前缀时补上，与侧栏 / 实时通知口径一致。 */
function formatGroupUnreadNotificationBody(
  conversation: Conversation | undefined,
  notify: UnreadNotifyInfo,
): string {
  const preview = notify.preview.slice(0, 100)
  const senderName = notify.senderName?.trim()
  if (
    conversation?.type !== CONVERSATION_TYPE_GROUP
    || !senderName
  ) {
    return preview
  }
  const namePart = senderName.slice(0, 18)
  if (preview.startsWith(`${namePart}:`)) return preview
  return `${namePart}: ${preview}`.slice(0, 100)
}

const initialState = {
  isIMActive: false,
  conversations: [],
  currentConversationId: null,
  lastOpenedConversationIdByOrganization: {},
  messages: {},
  conversationMembers: {} as Record<string, ConversationMember[] | undefined>,
  conversationMembersLoading: {} as Record<string, boolean>,
  hasMoreMessages: {},
  unreadCounts: {},
  totalUnread: 0,
  isLoadingConversations: false,
  messageLoadingByConversation: {},
  isSending: false,
  connectionStatus: 'disconnected' as const,
  sessionKicked: false,
  authFailed: false,
  sendError: null,
  loadError: null,
  readReceipts: {} as Record<string, Record<string, number>>,
  pinnedMessages: {} as Record<string, IMMessage[]>,
  scrollTargetConversationId: null,
  scrollToMessageId: null,
  scrollToMessageRef: null,
  imSidebarView: 'inbox' as IMSidebarView,
  imContactsTab: 'internal' as IMContactsTab,
  // TC-37
  labels: [] as ConversationLabel[],
  activeLabelFilters: [] as string[],
  activeLabelFiltersOrganizationId: null,
  labelsLoadedOrganizationId: null,
  handoffVersions: {} as Record<string, number>,
  sessionShareListVersions: {} as Record<string, number>,
  sessionShareDetailVersions: {} as Record<string, number>,
  sessionShares: {} as Record<string, SessionShareStoreEntry>,
  sessionContinuations: {} as Record<string, SessionContinuationStoreEntry>,
}

export const useIMStore = create<IMState>((set, get) => ({
  ...initialState,

  openIM: () => {
    emitNavigate('im')
    // 选具体会话只改变消息模块内部状态，顶部模块始终保持「消息」选中。
    useMainNavStore.getState().setCurrentTab('im')
    set({ isIMActive: true })
  },

  closeIM: () => {
    set({ isIMActive: false, imSidebarView: 'inbox' })
  },

  setImSidebarView: (view) => {
    if (view === 'contacts') {
      useSpaceListStore.getState().clearActiveContext({ preserveOrganizationMemory: true })
    }
    set({
      imSidebarView: view,
      ...(view === 'contacts' ? { currentConversationId: null } : {}),
    })
  },

  setImContactsTab: (tab) => {
    set({ imContactsTab: tab })
  },

  setCurrentConversation: (id) => {
    set((state) => {
      const messages = { ...state.messages }
      const messageLoadingByConversation = { ...state.messageLoadingByConversation }
      const cachedConvIds = Object.keys(messages)
      if (cachedConvIds.length > MAX_CACHED_CONVERSATIONS) {
        const toEvict = cachedConvIds
          .filter((cid) => cid !== id && cid !== state.currentConversationId)
          .slice(0, cachedConvIds.length - MAX_CACHED_CONVERSATIONS)
        for (const cid of toEvict) {
          delete messages[cid]
          delete messageLoadingByConversation[cid]
          _latestMessageLoadRequestIds.set(
            cid,
            (_latestMessageLoadRequestIds.get(cid) ?? 0) + 1,
          )
        }
      }
      const conversation = id
        ? state.conversations.find((item) => item.id === id)
        : null
      const lastOpenedConversationIdByOrganization = conversation?.organization_id
        ? {
            ...state.lastOpenedConversationIdByOrganization,
            [conversation.organization_id]: conversation.id,
          }
        : state.lastOpenedConversationIdByOrganization
      return {
        currentConversationId: id,
        lastOpenedConversationIdByOrganization,
        messages,
        messageLoadingByConversation,
        ...(id ? { imSidebarView: 'inbox' as const } : {}),
      }
    })
    if (id) {
      void get().markAsRead(id)
    }
  },

  navigateToMessage: (convId, target) => {
    const messageId = typeof target === 'number' ? target : target.id
    const messageRef = typeof target === 'number'
      ? undefined
      : target.metadata.message_ref?.trim() || undefined
    set((state) => {
      const conversation = state.conversations.find((item) => item.id === convId)
      return {
        currentConversationId: convId,
        lastOpenedConversationIdByOrganization: conversation?.organization_id
          ? {
              ...state.lastOpenedConversationIdByOrganization,
              [conversation.organization_id]: conversation.id,
            }
          : state.lastOpenedConversationIdByOrganization,
        scrollTargetConversationId: convId,
        scrollToMessageId: messageId,
        scrollToMessageRef: messageRef ?? null,
        imSidebarView: 'inbox',
      }
    })
    if (convId) {
      _navigationTargets.set(convId, { id: messageId, messageRef })
      void get().markAsRead(convId)
      const targetMessage = typeof target === 'number'
        ? get().messages[convId]?.find((message) => message.id === target)
        : target
      void get().loadMessages(convId, targetMessage, { force: true })
    }
  },

  clearScrollTarget: (target) => {
    set((state) => {
      if (target && (
        state.scrollTargetConversationId !== target.conversationId
        || state.scrollToMessageId !== target.messageId
        || state.scrollToMessageRef !== (target.messageRef ?? null)
      )) return state
      return { scrollTargetConversationId: null, scrollToMessageId: null, scrollToMessageRef: null }
    })
  },

  bumpHandoffVersion: (handoffId) => {
    if (!handoffId) return
    set((state) => ({
      handoffVersions: {
        ...state.handoffVersions,
        [handoffId]: (state.handoffVersions[handoffId] ?? 0) + 1,
      },
    }))
  },

  bumpSessionShareListVersion: (conversationId) => {
    if (!conversationId) return
    set((state) => ({
      sessionShareListVersions: {
        ...state.sessionShareListVersions,
        [conversationId]: (state.sessionShareListVersions[conversationId] ?? 0) + 1,
      },
    }))
  },

  bumpSessionShareDetailVersion: (shareId) => {
    if (!shareId) return
    set((state) => ({
      sessionShareDetailVersions: {
        ...state.sessionShareDetailVersions,
        [shareId]: (state.sessionShareDetailVersions[shareId] ?? 0) + 1,
      },
    }))
  },

  loadSessionShare: async (shareId) => {
    if (!shareId) return null
    const requestId = (_latestSessionShareLoadRequestIds.get(shareId) ?? 0) + 1
    _latestSessionShareLoadRequestIds.set(shareId, requestId)
    const detailVersionAtStart = get().sessionShareDetailVersions[shareId] ?? 0
    set((state) => ({
      sessionShares: {
        ...state.sessionShares,
        [shareId]: {
          detail: state.sessionShares[shareId]?.detail ?? null,
          loadState: 'loading',
          detailLoaded: state.sessionShares[shareId]?.detailLoaded ?? false,
          accessDenied: state.sessionShares[shareId]?.accessDenied ?? false,
        },
      },
    }))
    try {
      const share = await tabchatApi.getSessionShare(shareId)
      if (_latestSessionShareLoadRequestIds.get(shareId) === requestId) {
        if ((get().sessionShareDetailVersions[shareId] ?? 0) !== detailVersionAtStart) {
          return await get().loadSessionShare(shareId)
        }
        get().setSessionShare(share)
      }
      return share
    } catch (error) {
      if (_latestSessionShareLoadRequestIds.get(shareId) !== requestId) return null
      if ((get().sessionShareDetailVersions[shareId] ?? 0) !== detailVersionAtStart) {
        return await get().loadSessionShare(shareId)
      }
      set((state) => ({
        sessionShares: {
          ...state.sessionShares,
          [shareId]: {
            detail: state.sessionShares[shareId]?.detail ?? null,
            loadState: 'error',
            detailLoaded: state.sessionShares[shareId]?.detailLoaded ?? false,
            accessDenied: isSessionShareAccessDenied(error),
          },
        },
      }))
      log.warn('load session share failed', { shareId, error })
      return null
    }
  },

  loadSessionShareV2: async (shareId, minimumVersion = 0) => {
    if (!shareId) return null
    const active = _activeSessionShareV2Loads.get(shareId)
    const reusesActiveLoad = Boolean(active && active.minimumVersion >= minimumVersion)
    const requestId = reusesActiveLoad
      ? active!.requestId
      : (_latestSessionShareLoadRequestIds.get(shareId) ?? 0) + 1
    if (!reusesActiveLoad) {
      _latestSessionShareLoadRequestIds.set(shareId, requestId)
      const pending = _pendingSessionShareV2Loads.get(shareId)
      _pendingSessionShareV2Loads.set(shareId, {
        minimumVersion: Math.max(minimumVersion, pending?.minimumVersion ?? 0),
        requestId,
        attempt: pending?.attempt ?? 0,
      })
    }
    set((state) => ({
      sessionShares: {
        ...state.sessionShares,
        [shareId]: {
          detail: state.sessionShares[shareId]?.detail ?? null,
          loadState: 'loading',
          detailLoaded: state.sessionShares[shareId]?.detailLoaded ?? false,
          accessDenied: false,
        },
      },
    }))
    try {
      await dedupAsync(_imInFlight, SESSION_SHARE_V2_BATCH_FLIGHT_KEY, async () => {
        // 让同一轮 React/EventBus 调用先入队，再一次性发出 batch-get。
        await new Promise((resolve) => window.setTimeout(resolve, 0))
        while (_pendingSessionShareV2Loads.size > 0) {
          const batch = new Map(
            [..._pendingSessionShareV2Loads.entries()].slice(0, SESSION_SHARE_V2_BATCH_SIZE),
          )
          batch.forEach((entry, id) => {
            if (_pendingSessionShareV2Loads.get(id) === entry) {
              _pendingSessionShareV2Loads.delete(id)
            }
            _activeSessionShareV2Loads.set(id, entry)
          })

          let items: Awaited<ReturnType<typeof tabchatApi.batchGetSessionShareV2>>
          try {
            items = await tabchatApi.batchGetSessionShareV2([...batch.keys()])
          } catch (error) {
            batch.forEach((entry, id) => {
              if (_activeSessionShareV2Loads.get(id) === entry) {
                _activeSessionShareV2Loads.delete(id)
              }
            })
            const retryAfter = error && typeof error === 'object'
              && 'status' in error && error.status === 429
              && 'retryAfter' in error && typeof error.retryAfter === 'number'
              ? error.retryAfter * 1_000
              : null
            let willRetry = false
            batch.forEach((entry, id) => {
              if (retryAfter !== null && entry.attempt < 2) {
                const queued = _pendingSessionShareV2Loads.get(id)
                _pendingSessionShareV2Loads.set(id, {
                  minimumVersion: Math.max(entry.minimumVersion, queued?.minimumVersion ?? 0),
                  requestId: Math.max(entry.requestId, queued?.requestId ?? 0),
                  attempt: entry.attempt + 1,
                })
                willRetry = true
                return
              }
              if (_latestSessionShareLoadRequestIds.get(id) !== entry.requestId) return
              set((state) => ({
                sessionShares: {
                  ...state.sessionShares,
                  [id]: {
                    detail: state.sessionShares[id]?.detail ?? null,
                    loadState: 'error',
                    detailLoaded: state.sessionShares[id]?.detailLoaded ?? false,
                    accessDenied: false,
                  },
                },
              }))
            })
            if (willRetry && retryAfter !== null) {
              await new Promise((resolve) => window.setTimeout(resolve, retryAfter))
              continue
            }
            log.warn('load session share v2 batch failed', {
              shareIds: [...batch.keys()],
              error,
            })
            continue
          }

          batch.forEach((entry, id) => {
            if (_activeSessionShareV2Loads.get(id) === entry) {
              _activeSessionShareV2Loads.delete(id)
            }
          })

          const itemsById = new Map(items.map((item) => [item.object_id, item]))
          let retryDelay = 0
          batch.forEach((entry, id) => {
            if (_latestSessionShareLoadRequestIds.get(id) !== entry.requestId) return
            const item = itemsById.get(id)
            if (!item?.ok || !item.detail) {
              set((state) => ({
                sessionShares: {
                  ...state.sessionShares,
                  [id]: {
                    detail: state.sessionShares[id]?.detail ?? null,
                    loadState: 'error',
                    detailLoaded: state.sessionShares[id]?.detailLoaded ?? false,
                    accessDenied: true,
                  },
                },
              }))
              return
            }
            const share: SessionShareInfo = {
              ...item.detail,
              id: item.detail.id || item.object_id || id,
              session_id: item.detail.session_id || '',
            }
            if ((share.version ?? 0) < entry.minimumVersion && entry.attempt < 2) {
              _pendingSessionShareV2Loads.set(id, { ...entry, attempt: entry.attempt + 1 })
              retryDelay = Math.max(retryDelay, 100 * (entry.attempt + 1))
              return
            }
            if ((share.version ?? 0) < entry.minimumVersion) {
              set((state) => ({
                sessionShares: {
                  ...state.sessionShares,
                  [id]: {
                    detail: state.sessionShares[id]?.detail ?? null,
                    loadState: 'error',
                    detailLoaded: state.sessionShares[id]?.detailLoaded ?? false,
                    accessDenied: false,
                  },
                },
              }))
              return
            }
            const cachedVersion = get().sessionShares[id]?.detail?.version ?? 0
            if ((share.version ?? 0) >= cachedVersion) get().setSessionShare(share)
          })
          if (retryDelay > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, retryDelay))
          }
        }
      })
      if (_pendingSessionShareV2Loads.has(shareId)) {
        return await get().loadSessionShareV2(shareId, minimumVersion)
      }
      const entry = get().sessionShares[shareId]
      const detail = entry?.detail ?? null
      return entry?.loadState === 'loaded' && detail && (detail.version ?? 0) >= minimumVersion
        ? detail as SessionShareInfo
        : null
    } catch (error) {
      if (_latestSessionShareLoadRequestIds.get(shareId) !== requestId) return null
      set((state) => ({
        sessionShares: {
          ...state.sessionShares,
          [shareId]: {
            detail: state.sessionShares[shareId]?.detail ?? null,
            loadState: 'error',
            detailLoaded: state.sessionShares[shareId]?.detailLoaded ?? false,
            accessDenied: false,
          },
        },
      }))
      log.warn('load session share v2 failed', { shareId, minimumVersion, error })
      return null
    }
  },

  loadSessionContinuation: async (objectId, minimumVersion = 0) => {
    if (!objectId) return null
    const requestId = (_latestSessionContinuationLoadRequestIds.get(objectId) ?? 0) + 1
    _latestSessionContinuationLoadRequestIds.set(objectId, requestId)
    set((state) => ({
      sessionContinuations: {
        ...state.sessionContinuations,
        [objectId]: {
          detail: state.sessionContinuations[objectId]?.detail ?? null,
          loadState: 'loading',
          accessDenied: false,
        },
      },
    }))
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const [item] = await tabchatApi.batchGetSessionContinuations([objectId])
        if (_latestSessionContinuationLoadRequestIds.get(objectId) !== requestId) return null
        if (!item?.ok || !item.detail) {
          set((state) => ({
            sessionContinuations: {
              ...state.sessionContinuations,
              [objectId]: {
                detail: state.sessionContinuations[objectId]?.detail ?? null,
                loadState: 'error',
                accessDenied: true,
              },
            },
          }))
          return null
        }
        if (item.detail.version < minimumVersion) {
          if (attempt < 2) {
            await new Promise((resolve) => window.setTimeout(resolve, 100 * (attempt + 1)))
            continue
          }
          throw new Error('session continuation detail is behind the notified version')
        }
        const cachedVersion = get().sessionContinuations[objectId]?.detail?.version ?? 0
        if (item.detail.version >= cachedVersion) get().setSessionContinuation(item.detail)
        return item.detail
      }
      return null
    } catch (error) {
      if (_latestSessionContinuationLoadRequestIds.get(objectId) !== requestId) return null
      set((state) => ({
        sessionContinuations: {
          ...state.sessionContinuations,
          [objectId]: {
            detail: state.sessionContinuations[objectId]?.detail ?? null,
            loadState: 'error',
            accessDenied: false,
          },
        },
      }))
      log.warn('load session continuation failed', { objectId, minimumVersion, error })
      return null
    }
  },

  setSessionContinuation: (detail) => {
    if (!detail.object_id) return
    set((state) => ({
      sessionContinuations: {
        ...state.sessionContinuations,
        [detail.object_id]: {
          detail,
          loadState: 'loaded',
          accessDenied: false,
        },
      },
    }))
  },

  setSessionShare: (share) => {
    if (!share.id) return
    set((state) => ({
      sessionShares: {
        ...state.sessionShares,
        [share.id]: {
          detail: {
            ...(state.sessionShares[share.id]?.detail ?? {}),
            ...share,
          },
          loadState: 'loaded',
          detailLoaded: true,
          accessDenied: false,
        },
      },
    }))
  },

  patchSessionShare: (shareId, patch) => {
    if (!shareId) return
    set((state) => ({
      sessionShares: {
        ...state.sessionShares,
        [shareId]: {
          detail: {
            ...(state.sessionShares[shareId]?.detail ?? { id: shareId }),
            ...patch,
            id: shareId,
          },
          loadState: state.sessionShares[shareId]?.loadState ?? 'idle',
          detailLoaded: state.sessionShares[shareId]?.detailLoaded ?? false,
          accessDenied: state.sessionShares[shareId]?.accessDenied ?? false,
        },
      },
    }))
  },

  denySessionShareAccess: (shareId) => {
    if (!shareId) return
    set((state) => ({
      sessionShares: {
        ...state.sessionShares,
        [shareId]: {
          detail: state.sessionShares[shareId]?.detail ?? null,
          loadState: state.sessionShares[shareId]?.loadState ?? 'idle',
          detailLoaded: state.sessionShares[shareId]?.detailLoaded ?? false,
          accessDenied: true,
        },
      },
    }))
  },

  reconcileSessionShareStatus: ({ share_id, conversation_id, status }) => {
    if (!share_id || !conversation_id) return
    set((state) => {
      const msgs = state.messages[conversation_id]
      const nextListVersions = {
        ...state.sessionShareListVersions,
        [conversation_id]: (state.sessionShareListVersions[conversation_id] ?? 0) + 1,
      }
      const nextDetailVersions = {
        ...state.sessionShareDetailVersions,
        [share_id]: (state.sessionShareDetailVersions[share_id] ?? 0) + 1,
      }
      const cachedShare = state.sessionShares[share_id]
      const nextSessionShares = {
        ...state.sessionShares,
        [share_id]: {
          detail: {
            ...(cachedShare?.detail ?? { id: share_id }),
            status: status as SessionShareInfo['status'],
            id: share_id,
          },
          loadState: cachedShare?.loadState ?? 'idle',
          detailLoaded: cachedShare?.detailLoaded ?? false,
          accessDenied: cachedShare?.accessDenied ?? false,
        },
      }
      if (!msgs) {
        return {
          sessionShareListVersions: nextListVersions,
          sessionShareDetailVersions: nextDetailVersions,
          sessionShares: nextSessionShares,
        }
      }
      let changed = false
      const updatedMsgs = msgs.map((message) => {
        const card = message.metadata?.card
        if (
          card?.type !== 'session_share'
          || card.share_id !== share_id
          || card.status === status
        ) {
          return message
        }
        changed = true
        return {
          ...message,
          metadata: {
            ...message.metadata,
            card: { ...card, status },
          },
        }
      })
      if (!changed) {
        return {
          sessionShareListVersions: nextListVersions,
          sessionShareDetailVersions: nextDetailVersions,
          sessionShares: nextSessionShares,
        }
      }
      return {
        messages: { ...state.messages, [conversation_id]: updatedMsgs },
        sessionShareListVersions: nextListVersions,
        sessionShareDetailVersions: nextDetailVersions,
        sessionShares: nextSessionShares,
      }
    })
  },

  loadConversations: async (organizationId) => {
    if (get().sessionKicked) return
    await dedupAsync(_imInFlight, `conversations:${organizationId}`, async () => {
      const requestId = (_latestConversationsLoadRequestIds.get(organizationId) ?? 0) + 1
      _latestConversationsLoadRequestIds.set(organizationId, requestId)
      set({ isLoadingConversations: true, loadError: null })
      try {
        // TC-37：筛选条件必须属于本次目标 organization。切换组织的 React effect
        // 会在 selectedOrganization 提交后执行，不能让旧组织的 label ID 抢先参与请求。
        const state = get()
        const activeFilters = state.activeLabelFiltersOrganizationId === organizationId
          ? state.activeLabelFilters
          : []
        const raw = activeFilters.length > 0
          ? await tabchatApi.listConversations(organizationId, activeFilters)
          : await tabchatApi.listConversations(organizationId)
        if (requestId !== _latestConversationsLoadRequestIds.get(organizationId)) return
        if (get().sessionKicked) {
          set({ isLoadingConversations: false })
          return
        }
        set((state) => {
          const previousById = new Map(
            state.conversations
              .filter((conversation) => conversation.organization_id === organizationId)
              .map((conversation) => [conversation.id, conversation]),
          )
          const newConversations = sortConversations(
            raw.map((conversation) => {
              const previous = previousById.get(conversation.id)
              const merged = previous
                ? mergeConversation(
                    previous,
                    conversation,
                    state.messages[conversation.id],
                  )
                : conversation
              return mergeHydratedReferencePreview(
                merged,
                state.messages[conversation.id],
              )
            }),
          )
          const otherConversations = state.conversations.filter(c => c.organization_id !== organizationId)
          const merged = sortConversations([...otherConversations, ...newConversations])

          const newUnreadCounts = { ...state.unreadCounts }
          for (const c of state.conversations) {
            if (c.organization_id === organizationId) delete newUnreadCounts[c.id]
          }
          for (const c of newConversations) {
            delete newUnreadCounts[c.id]
          }
          let totalUnread = 0
          for (const conv of newConversations) {
            if (conv.unread_count > 0) newUnreadCounts[conv.id] = conv.unread_count
          }
          for (const count of Object.values(newUnreadCounts)) totalUnread += count

          return {
            conversations: merged,
            unreadCounts: newUnreadCounts,
            totalUnread,
            isLoadingConversations: false,
          }
        })
      } catch (err) {
        if (requestId !== _latestConversationsLoadRequestIds.get(organizationId)) return
        if (get().sessionKicked) {
          set({ isLoadingConversations: false })
          return
        }
        log.error('Failed to load conversations:', { organizationId, err })
        set({ isLoadingConversations: false, loadError: 'loadConversationsFailed' })
      }
    })
  },

  createConversationAndActivate: async ({
    organizationId,
    kind,
    memberIds,
    externalContactIds = [],
    groupName,
    spaceId,
    activate = true,
    clientRequestId,
  }) => {
    let conversationId = ''
    if (kind === 'dm') {
      const externalContactId = externalContactIds[0]
      if (externalContactId) {
        const result = await tabchatApi.createExternalDM(organizationId, externalContactId)
        conversationId = result.conversation_id
      } else {
        const targetUserId = memberIds[0]
        if (!targetUserId) {
          throw new Error('TabChat createConversationAndActivate requires a target user for DM')
        }
        const result = await tabchatApi.createDM(organizationId, targetUserId)
        conversationId = result.conversation_id
      }
    } else {
      if (!spaceId && memberIds.length + externalContactIds.length < 2) {
        throw new Error('TabChat createConversationAndActivate requires at least two members for group')
      }
      const resolvedGroupName = groupName?.trim()
        || await resolveDefaultGroupName(organizationId, memberIds, externalContactIds)
      const result = clientRequestId
        ? await tabchatApi.createGroup(
          organizationId,
          resolvedGroupName,
          memberIds,
          '',
          spaceId,
          externalContactIds,
          clientRequestId,
        )
        : await tabchatApi.createGroup(
          organizationId,
          resolvedGroupName,
          memberIds,
          '',
          spaceId,
          externalContactIds,
        )
      conversationId = result.conversation_id
      // 群组占用 max_groups；失效权益缓存，组织资料「群组已用数」即时刷新
      invalidateMembershipQuotaUsage(queryClient, organizationId)
    }

    try {
      const conversation = await tabchatApi.getConversation(conversationId)
      set((state) => {
        const nextUnreadCount = Math.max(0, conversation.unread_count || 0)
        const prevUnreadCount = state.unreadCounts[conversation.id] || 0
        const unreadCounts = { ...state.unreadCounts }
        if (nextUnreadCount > 0) {
          unreadCounts[conversation.id] = nextUnreadCount
        } else {
          delete unreadCounts[conversation.id]
        }
        return {
          conversations: upsertConversationList(state.conversations, conversation),
          unreadCounts,
          totalUnread: Math.max(
            0,
            state.totalUnread - prevUnreadCount + nextUnreadCount,
          ),
        }
      })
    } catch (error) {
      await get().loadConversations(organizationId)
      if (!get().conversations.some((conversation) => conversation.id === conversationId)) {
        throw error
      }
    }

    if (activate) {
      useSpaceListStore
        .getState()
        .activateConversation(conversationId, kind === 'group' ? 'im-group' : 'dm')
    }

    return conversationId
  },

  loadMessages: async (convId, before, options) => {
    if (before != null && get().hasMoreMessages[convId] === false && !options?.force) return []
    const requestId = (_latestMessageLoadRequestIds.get(convId) ?? 0) + 1
    _latestMessageLoadRequestIds.set(convId, requestId)
    const hasCachedMessages = get().messages[convId] !== undefined
    const messagesAtRequestStart = get().messages[convId] || []
    set((state) => ({
      messageLoadingByConversation: {
        ...state.messageLoadingByConversation,
        [convId]: true,
      },
      ...(hasCachedMessages ? {} : { loadError: null }),
    }))
    try {
      const newMessages = await tabchatApi.getMessages(convId, before)
      if (requestId !== _latestMessageLoadRequestIds.get(convId)) return newMessages
      const currentMessages = get().messages[convId] || []
      const messagesWithReactions = newMessages.map((message) => {
        const current = currentMessages.find((candidate) =>
          messagesShareStableIdentity(candidate, message))
        const withLocalState = current
          ? {
              ...message,
              ...(current._recalledContent && !message._recalledContent
                ? { _recalledContent: current._recalledContent }
                : {}),
              ...(current._localSentAt && !message._localSentAt
                ? { _localSentAt: current._localSentAt }
                : {}),
            }
          : message
        return overlayLocalReactionSnapshot(convId, withLocalState)
      })
      set((state) => {
        const existing = state.messages[convId] || []

        if (before) {
          return {
            messages: {
              ...state.messages,
              [convId]: mergeAndSortMessages(existing, messagesWithReactions),
            },
            hasMoreMessages: { ...state.hasMoreMessages, [convId]: newMessages.length > 0 },
            messageLoadingByConversation: {
              ...state.messageLoadingByConversation,
              [convId]: false,
            },
          }
        }

        // 保留 fetch 期间新增或被实时替换的消息，避免旧历史响应覆盖编辑、撤回或回执更新。
        const fetchedMessages = mergeAndSortMessages(messagesWithReactions)
        const newestFetched = fetchedMessages.at(-1)
        const oldestFetched = fetchedMessages.at(0)
        const navigationTarget = _navigationTargets.get(convId)
        const realtimeExtras = existing.filter((message) => {
          const fetched = messagesWithReactions.find((candidate) =>
            messagesShareStableIdentity(message, candidate))
          if (fetched) {
            const messageAtRequestStart = messagesAtRequestStart.find((candidate) =>
              messagesShareStableIdentity(message, candidate))
            return !messageAtRequestStart || messageAtRequestStart !== message
          }
          return message._optimistic
            || (newestFetched ? compareMessages(message, newestFetched) > 0 : true)
            || (oldestFetched ? compareMessages(message, oldestFetched) < 0 : true)
            || (navigationTarget?.messageRef
              ? message.metadata.message_ref === navigationTarget.messageRef
              : message.id === navigationTarget?.id)
        })

        const mergedMessages = preserveUnchangedMessageReferences(
          existing,
          mergeAndSortMessages(messagesWithReactions, realtimeExtras),
        )
        const latestMessage = [...mergedMessages]
          .reverse()
          .find((message) => (
            !message.is_deleted
            && !message._optimistic
            && !message._failed
            && !isPendingTabTinReferenceMessage(message)
            && message.metadata?.kind !== 'agent_progress'
            && message.metadata?.kind !== 'agent_stream'
          ))
        const latestMessageTime = typeof latestMessage?.created_at === 'string'
          ? Date.parse(latestMessage.created_at)
          : Number.NaN
        const conversations = Number.isFinite(latestMessageTime)
          ? sortConversations(state.conversations.map((conversation) => {
              if (conversation.id !== convId || !latestMessage) return conversation
              const summaryTime = typeof conversation.last_message_at === 'string'
                ? Date.parse(conversation.last_message_at)
                : Number.NaN
              if (Number.isFinite(summaryTime) && latestMessageTime <= summaryTime) {
                return conversation
              }
              return {
                ...conversation,
                last_message_at: latestMessage.created_at,
                last_message_preview: buildPreview(
                  latestMessage,
                  conversation.type === CONVERSATION_TYPE_GROUP,
                ),
                last_message_reference:
                  conversationReferenceFromMessage(latestMessage),
              }
            }))
          : state.conversations

        const hasMoreMessages = { ...state.hasMoreMessages }
        if (
          before
          || !hasCachedMessages
          || !Object.prototype.hasOwnProperty.call(state.hasMoreMessages, convId)
        ) {
          hasMoreMessages[convId] = newMessages.length > 0
        }

        return {
          messages: {
            ...state.messages,
            [convId]: mergedMessages,
          },
          conversations,
          hasMoreMessages,
          messageLoadingByConversation: {
            ...state.messageLoadingByConversation,
            [convId]: false,
          },
        }
      })
      // 消息加载即批量检查附件可用性（store 缓存按 message id 去重，气泡只读结果，
      // 滚动重挂载不再重复探测）。
      useFileAttachmentStore.getState().ensureChecked(newMessages)
      if (!before && isConversationVisibleForRead(convId, get())) {
        void get().markAsRead(convId)
      }
      return newMessages
    } catch (err) {
      log.error('Failed to load messages:', { convId, before: before ?? null, err })
      if (requestId === _latestMessageLoadRequestIds.get(convId)) {
        set((state) => ({
          messageLoadingByConversation: {
            ...state.messageLoadingByConversation,
            [convId]: false,
          },
          ...(hasCachedMessages ? {} : { loadError: 'loadMessagesFailed' as const }),
        }))
      }
      return []
    }
  },

  sendMessage: async ({
    convId,
    content,
    metadata,
    replyTo,
    replyToPreview: providedReplyToPreview,
    messageType = MESSAGE_TYPE_TEXT,
    clientRequestId,
    retryExisting = false,
  }) => {
    const targetConversation = get().conversations.find(
      (conversation) => conversation.id === convId,
    )
    if (
      targetConversation?.can_send === false
      || targetConversation?.dm_peer_membership_status === 'removed'
      || (targetConversation?.external_contact_relationship !== undefined
        && targetConversation.external_contact_relationship !== 'friend')
    ) {
      log.warn('Blocked send to a read-only conversation', { convId })
      set({ sendError: 'sendFailed' })
      return false
    }

    if (
      targetConversation?.is_external
      && !canSendToExternalConversation(messageType, metadata)
    ) {
      log.warn('Blocked rich content send to an external conversation', { convId, messageType })
      set({ sendError: 'sendFailed' })
      return false
    }

    if (
      targetConversation?.is_external
      && targetConversation.type === CONVERSATION_TYPE_DM
      && targetConversation.organization_id
      && targetConversation.dm_peer_user_id
    ) {
      try {
        const { items } = await tabchatApi.listExternalContacts(
          targetConversation.organization_id,
        )
        const relationship = items.find(
          (contact) => (
            contact.peer_user_id === targetConversation.dm_peer_user_id
            && contact.peer_organization_id === targetConversation.dm_peer_organization_id
          ),
        )?.relationship
        if (relationship !== 'friend') {
          get().updateConversation(convId, { external_contact_relationship: relationship ?? 'removed' })
          log.warn('Blocked send to an unavailable external contact', { convId, relationship })
          set({ sendError: 'sendFailed' })
          return false
        }
        get().updateConversation(convId, { external_contact_relationship: 'friend' })
      } catch (error) {
        log.warn('Failed to verify external contact before send', { convId, error })
        set({ sendError: 'sendFailed' })
        return false
      }
    }

    const msgType = messageType
    if (!isIMMessageContentWithinLimit(content)) {
      log.warn('Blocked over-limit IM message before optimistic send', {
        convId,
        msgType,
      })
      set({ sendError: 'messageTooLong' })
      return false
    }
    _sendingCount++
    set({ isSending: true, sendError: null })

    const isFile = msgType === MESSAGE_TYPE_FILE || msgType === MESSAGE_TYPE_IMAGE
    const rawMetadata = { ...(metadata || {}) }
    const configuredRequestId = clientRequestId ?? rawMetadata.client_request_id
    const requestId = typeof configuredRequestId === 'string'
      && configuredRequestId.trim()
      ? configuredRequestId.trim()
      : tabchatApi.createClientRequestId()
    const messageRef = typeof rawMetadata.message_ref === 'string'
      && rawMetadata.message_ref.trim()
      ? rawMetadata.message_ref.trim()
      : tabchatApi.createMessageRef()
    const tempId = messageRef
    const clientLocalPath = typeof rawMetadata[CLIENT_LOCAL_PATH_METADATA_KEY] === 'string'
      ? rawMetadata[CLIENT_LOCAL_PATH_METADATA_KEY]
      : null
    delete rawMetadata[CLIENT_LOCAL_PATH_METADATA_KEY]
    if (isFile) {
      for (const key of ATTACHMENT_RUNTIME_METADATA_KEYS) delete rawMetadata[key]
    }
    const enrichedMetadata = {
      ...rawMetadata,
      client_request_id: requestId,
      message_ref: messageRef,
    }

    let replyToPreview: IMMessage['reply_to_preview'] = providedReplyToPreview ?? null
    if (replyTo) {
      replyToPreview = {
        content: replyToPreview?.content ?? replyTo.content.slice(0, 100),
        sender_id: replyToPreview?.sender_id ?? replyTo.sender_id,
        message_type: replyToPreview?.message_type ?? replyTo.message_type,
      }
    }

    const { id: senderId, nickname: senderNickname } = await getCachedIdentity()
    const localSentAt = new Date().toISOString()
    const optimisticMsg: IMMessage = {
      id: -1,
      conversation_id: convId,
      sender_id: senderId,
      sender_name: senderNickname,
      content,
      message_type: msgType,
      reply_to_id: replyTo?.transport?.kind === 'group'
        ? replyTo.transport.sequence
        : null,
      reply_to_ref: replyTo?.metadata.message_ref ?? null,
      reply_to_preview: replyToPreview,
      has_attachment: isFile,
      metadata: enrichedMetadata,
      created_at: localSentAt,
      _localSentAt: localSentAt,
      _optimistic: true,
      _tempId: tempId,
    }

    set((state) => {
      const existing = state.messages[convId] || []
      const hasExisting = retryExisting && existing.some((message) => message._tempId === tempId)
      const nextMessages = hasExisting
        ? existing.map((message) =>
            message._tempId === tempId
              ? {
                  ...message,
                  created_at: localSentAt,
                  _localSentAt: localSentAt,
                  _optimistic: true,
                  _failed: false,
                  _retrying: true,
                }
              : message,
          )
        : [...existing, optimisticMsg]
      return { messages: { ...state.messages, [convId]: nextMessages } }
    })

    try {
      // 能发送消息说明用户已经看过当前会话；补齐可能因加载/可见性时序漏掉的已读上报。
      // 此时乐观消息已入列，resolveMarkReadLastMessage 会跳过未确认消息。
      void get().markAsRead(convId)
      const result = await tabchatApi.sendMessage(convId, content, msgType, replyTo, enrichedMetadata)

      set((state) => {
        const matchedConv = state.conversations.find((c) => c.id === convId)
        const updated = (state.messages[convId] || [])
          .map((m) =>
            m._tempId === tempId
              ? {
                  ...m,
                  id: result.id,
                  seq: result.seq,
                  transport: result.transport,
                  created_at: result.created_at,
                  metadata: enrichedMetadata,
                  _optimistic: false,
                  _failed: undefined,
                  _retrying: undefined,
                  _tempId: undefined,
                }
              : m,
          )
        const msgs = mergeAndSortMessages(updated)
        const sentMessage = msgs.find((message) =>
          message.metadata.message_ref === messageRef)
        const conversations = sentMessage && matchedConv
          ? sortConversations(
            state.conversations.map((c) =>
              c.id === convId
                ? {
                  ...c,
                  last_message_at: sentMessage.created_at || c.last_message_at,
                  last_message_preview: buildPreview(
                    sentMessage,
                    matchedConv.type === CONVERSATION_TYPE_GROUP,
                  ),
                  last_message_reference:
                    conversationReferenceFromMessage(sentMessage),
                }
                : c,
            ),
          )
          : state.conversations
        return { messages: { ...state.messages, [convId]: msgs }, conversations }
      })
      if (msgType === MESSAGE_TYPE_FILE || msgType === MESSAGE_TYPE_IMAGE) {
        const sentMessage = get().messages[convId]?.find((message) =>
          message.metadata.message_ref === messageRef)
        if (sentMessage && msgType === MESSAGE_TYPE_FILE && clientLocalPath) {
          useFileAttachmentStore.getState().markLocalFile(
            sentMessage,
            clientLocalPath,
            null,
          )
        } else if (sentMessage) {
          useFileAttachmentStore.getState().ensureChecked([sentMessage])
        }
      }
      return true
    } catch (err) {
      log.error('Failed to send message:', { convId, msgType, err })
      const sendError: IMSendError = 'sendFailed'

      set((state) => {
        const msgs = (state.messages[convId] || []).map((m) =>
          m._tempId === tempId ? { ...m, _failed: true, _retrying: undefined } : m,
        )
        return { messages: { ...state.messages, [convId]: msgs }, sendError }
      })
      return false
    } finally {
      _sendingCount--
      if (_sendingCount <= 0) {
        _sendingCount = 0
        set({ isSending: false })
      }
    }
  },

  retryFailedMessage: async (message) => {
    const clientRequestId = message.metadata?.client_request_id
    const messageRef = message.metadata?.message_ref
    if (
      !message._failed ||
      message._retrying ||
      typeof clientRequestId !== 'string' ||
      !clientRequestId.trim() ||
      typeof messageRef !== 'string' ||
      !messageRef.trim() ||
      !message._tempId ||
      message._tempId !== messageRef ||
      retryingMessageIds.has(message._tempId)
    ) return

    retryingMessageIds.add(message._tempId)
    // 先同步标记 UI，既反馈点击，也让重渲染后的按钮不可再次触发。
    set((state) => ({
      messages: {
        ...state.messages,
        [message.conversation_id]: (state.messages[message.conversation_id] || []).map((item) =>
          item._tempId === message._tempId ? { ...item, _retrying: true } : item,
        ),
      },
    }))
    try {
      await get().sendMessage({
        convId: message.conversation_id,
        content: message.content,
        metadata: message.metadata,
        replyTo: (get().messages[message.conversation_id] ?? []).find((candidate) => (
          message.reply_to_ref
            ? candidate.metadata.message_ref === message.reply_to_ref
            : candidate.id === message.reply_to_id
        )),
        replyToPreview: message.reply_to_preview ?? undefined,
        messageType: message.message_type,
        clientRequestId,
        retryExisting: true,
      })
    } finally {
      retryingMessageIds.delete(message._tempId)
    }
  },

  markAsRead: async (convId) => {
    const lastMessage = resolveMarkReadLastMessage(get().messages[convId])
    const lastReadSequence = lastMessage?.kind === 'group'
      ? lastMessage.sequence
      : undefined
    try {
      await tabchatApi.markRead(convId, lastMessage)

      const { id: uid } = await getCachedIdentity()

      set((state) => {
        const newCounts = { ...state.unreadCounts }
        const oldCount = newCounts[convId] || 0
        delete newCounts[convId]

        let readReceipts = state.readReceipts
        if (lastReadSequence && uid) {
          const prev = readReceipts[convId]?.[uid] ?? 0
          if (lastReadSequence > prev) {
            readReceipts = {
              ...readReceipts,
              [convId]: { ...readReceipts[convId], [uid]: lastReadSequence },
            }
          }
        }

        return {
          unreadCounts: newCounts,
          totalUnread: Math.max(0, state.totalUnread - oldCount),
          readReceipts,
          loadError: null,
          conversations: state.conversations.map((c) =>
            c.id === convId ? { ...c, unread_count: 0 } : c,
          ),
        }
      })
    } catch (err) {
      log.error('Failed to mark as read:', {
        convId,
        lastReadTransport: lastMessage?.kind ?? null,
        lastReadSequence: lastReadSequence ?? null,
        err: err instanceof Error ? err.message : err,
      })
      set({ loadError: 'markReadFailed' })
    }
  },

  loadUnreadCounts: async (organizationId) => {
    await dedupAsync(_imInFlight, `unread:${organizationId}`, async () => {
      try {
        const { conversations } = await tabchatApi.getUnreadCount(organizationId)
        let orphanUnreadConversationIds: string[] = []

        set((state) => {
          const organizationConversationIds = new Set(
            state.conversations
              .filter((conversation) => conversation.organization_id === organizationId)
              .map((conversation) => conversation.id),
          )
          const activeFilters = state.activeLabelFiltersOrganizationId === organizationId
            ? state.activeLabelFilters
            : []
          orphanUnreadConversationIds = Object.entries(conversations)
            .filter(([conversationId, count]) => (
              (count ?? 0) > 0
              && !organizationConversationIds.has(conversationId)
              && !_filteredUnreadRepairSkips.has(
                unreadRepairSkipKey(organizationId, conversationId, activeFilters),
              )
            ))
            .map(([conversationId]) => conversationId)

          const nextUnreadCounts = { ...state.unreadCounts }
          for (const conversationId of organizationConversationIds) {
            delete nextUnreadCounts[conversationId]
          }
          for (const [conversationId, count] of Object.entries(conversations)) {
            if (count > 0) {
              nextUnreadCounts[conversationId] = count
            } else {
              delete nextUnreadCounts[conversationId]
            }
          }

          const nextTotalUnread = Object.values(nextUnreadCounts)
            .reduce((sum, count) => sum + Math.max(0, count), 0)

          return {
            unreadCounts: nextUnreadCounts,
            totalUnread: nextTotalUnread,
            loadError: null,
          }
        })

        if (orphanUnreadConversationIds.length > 0) {
          for (const conversationId of orphanUnreadConversationIds) {
            try {
              const conversation = await tabchatApi.getConversation(conversationId)
              if (conversation.organization_id !== organizationId) {
                log.warn('loadUnreadCounts: repaired conversation organization mismatch:', {
                  expectedOrganizationId: organizationId,
                  conversationId,
                  actualOrganizationId: conversation.organization_id,
                })
                continue
              }

              set((state) => {
                const nextUnreadCount = Math.max(0, conversation.unread_count || 0)
                const prevUnreadCount = state.unreadCounts[conversation.id] || 0
                const unreadCounts = { ...state.unreadCounts }
                const activeFilters = state.activeLabelFiltersOrganizationId === organizationId
                  ? state.activeLabelFilters
                  : []
                if (nextUnreadCount > 0) {
                  unreadCounts[conversation.id] = nextUnreadCount
                } else {
                  delete unreadCounts[conversation.id]
                }

                const shouldShowInCurrentList = conversationMatchesLabelFilters(
                  conversation,
                  activeFilters,
                )
                if (!shouldShowInCurrentList) {
                  _filteredUnreadRepairSkips.add(
                    unreadRepairSkipKey(organizationId, conversation.id, activeFilters),
                  )
                }

                return {
                  conversations: shouldShowInCurrentList
                    ? upsertConversationList(state.conversations, conversation)
                    : state.conversations,
                  unreadCounts,
                  totalUnread: Math.max(
                    0,
                    state.totalUnread - prevUnreadCount + nextUnreadCount,
                  ),
                }
              })
            } catch (repairErr) {
              log.warn('loadUnreadCounts: failed to repair orphan unread conversation:', {
                organizationId,
                conversationId,
                err: repairErr,
              })
            }
          }
        }
      } catch (err) {
        log.error('Failed to load unread counts:', { organizationId, err })
        set({ loadError: 'loadUnreadFailed' })
      }
    })
  },

  applyUnreadSnapshot: (organizationId, snapshot) => {
    set((state) => {
      const organizationConversationIds = new Set(
        state.conversations
          .filter((conversation) => conversation.organization_id === organizationId)
          .map((conversation) => conversation.id),
      )
      const nextUnreadCounts = { ...state.unreadCounts }
      for (const conversationId of organizationConversationIds) {
        delete nextUnreadCounts[conversationId]
      }
      for (const [conversationId, count] of Object.entries(snapshot.conversations)) {
        const normalizedCount = Math.max(0, Math.trunc(count))
        if (normalizedCount > 0) {
          nextUnreadCounts[conversationId] = normalizedCount
        } else {
          delete nextUnreadCounts[conversationId]
        }
      }

      return {
        unreadCounts: nextUnreadCounts,
        totalUnread: Object.values(nextUnreadCounts)
          .reduce((sum, count) => sum + Math.max(0, count), 0),
        conversations: state.conversations.map((conversation) =>
          conversation.organization_id === organizationId
            ? {
                ...conversation,
                unread_count: Math.max(
                  0,
                  Math.trunc(snapshot.conversations[conversation.id] ?? 0),
                ),
              }
            : conversation,
        ),
      }
    })
  },

  resetIMState: () => {
    _sendingCount = 0
    _cachedIdentity = null
    _authUnsubscribe?.()
    _authUnsubscribe = null
    _notifDebounceMap.clear()
    _imInFlight.clear()
    _latestMessageLoadRequestIds.clear()
    _latestConversationsLoadRequestIds.clear()
    _latestSessionShareLoadRequestIds.clear()
    _pendingSessionShareV2Loads.clear()
    _activeSessionShareV2Loads.clear()
    _latestSessionContinuationLoadRequestIds.clear()
    _latestConversationMemberRequestIds.clear()
    _pinnedMessageStateRevisions.clear()
    _conversationMemberRequests.clear()
    _latestLabelsLoadRequestId++
    _filteredUnreadRepairSkips.clear()
    _reactionSnapshotsByReference.clear()
    for (const timer of _unreadDebounceTimers.values()) clearTimeout(timer)
    _unreadDebounceTimers.clear()
    useFileAttachmentStore.getState().reset()
    set(initialState)
  },

  setConnectionStatus: (status, reason) => {
    // 连接态迁移（connecting/connected/disconnected）——诊断实时消息断连问题的关键线索
    if (get().connectionStatus !== status) {
      log.info('IM connection status:', { from: get().connectionStatus, to: status })
    }
    set((state) => ({
      connectionStatus: status,
      sessionKicked: reason === 'kicked_out'
        ? true
        : status === 'connected'
          ? false
          : state.sessionKicked,
    }))
  },

  setAuthFailed: () => {
    log.warn('IM realtime auth failed')
    set({ authFailed: true })
  },

  clearAuthFailed: () => {
    set({ authFailed: false })
  },

  dismissSendError: () => {
    set({ sendError: null })
  },

  dismissLoadError: () => {
    set({ loadError: null })
  },

  updateConversation: (convId, updates) => {
    const prev = get().conversations.find((c) => c.id === convId)
    set((state) => ({
      conversations: sortConversations(
        state.conversations.map((c) =>
          c.id === convId
            ? mergeConversationUpdate(
                c,
                updates,
                state.messages[convId],
              )
            : c,
        ),
      ),
    }))
    // 归档/取消归档会改变 max_groups 已用数；WS im.conversation.updated 也走这里
    if (
      prev
      && prev.type === CONVERSATION_TYPE_GROUP
      && typeof updates.is_archived === 'boolean'
      && updates.is_archived !== prev.is_archived
    ) {
      invalidateMembershipQuotaUsage(queryClient, prev.organization_id)
    }
  },

  refreshConversationMembers: (convId, options) => {
    const current = _conversationMemberRequests.get(convId)
    const hasProjectionBarrier = Boolean(
      options?.expectMembershipChange
      || options?.expectedMemberCount !== undefined,
    )
    // 成员事件的投影屏障比入口重验更强。弱请求只能加入，不能取消屏障并发布旧名单。
    if (current?.hasProjectionBarrier && !hasProjectionBarrier) {
      return current.promise
    }
    if (current && !options?.supersede) return current.promise

    const requestId = ++_nextConversationMemberRequestId
    const baselineMembers = get().conversationMembers[convId]
    // supersede 发生在快照已失效之后时，沿用被替换请求记录的最后权威基线。
    const baselineIdentityKey = current?.baselineIdentityKey ?? (
      baselineMembers ? conversationMemberIdentityKey(baselineMembers) : undefined
    )
    const retryDelays = hasProjectionBarrier
      ? MEMBERSHIP_RECONCILIATION_RETRY_DELAYS_MS
      : []
    _latestConversationMemberRequestIds.set(convId, requestId)
    set((state) => ({
      ...(options?.invalidateSnapshot
        ? {
            conversationMembers: {
              ...state.conversationMembers,
              [convId]: undefined,
            },
          }
        : {}),
      conversationMembersLoading: {
        ...state.conversationMembersLoading,
        [convId]: true,
      },
    }))

    const promise = (async () => {
      let dmRestorationFailed = false
      const initialConversation = get().conversations.find(
        (conversation) => conversation.id === convId,
      )
      if (
        initialConversation?.type === CONVERSATION_TYPE_DM
        && !initialConversation.is_external
        && initialConversation.dm_peer_user_id
        && (
          initialConversation.can_send === false
          || initialConversation.dm_peer_membership_status === 'removed'
        )
      ) {
        try {
          await tabchatApi.createDM(
            initialConversation.organization_id,
            initialConversation.dm_peer_user_id,
          )
        } catch (error) {
          dmRestorationFailed = true
          log.info('Read-only DM restoration did not complete', {
            convId,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          })
          // 对端仍未加入组织时保持只读，随后照常刷新成员快照。
        }
      }

      for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
        if (attempt > 0) {
          await waitForConversationMemberRetry(retryDelays[attempt - 1])
        }
        if (_latestConversationMemberRequestIds.get(convId) !== requestId) return

        let detail: Awaited<ReturnType<typeof tabchatApi.getConversation>>
        try {
          detail = await tabchatApi.getConversation(convId)
        } catch (error) {
          if (attempt < retryDelays.length) continue
          throw error
        }
        if (_latestConversationMemberRequestIds.get(convId) !== requestId) return
        const liveConversation = get().conversations.find(
          (conversation) => conversation.id === convId,
        )
        if (!liveConversation) return
        if (
          detail.organization_id
          && detail.organization_id !== liveConversation.organization_id
        ) {
          return
        }
        const organizations = useOrganizationStore.getState().organizations
        if (
          Array.isArray(organizations)
          && !organizations.some(
            (organization) => organization.id === liveConversation.organization_id,
          )
        ) {
          return
        }
        const members = detail.members ?? []
        const expectedMemberCount = options?.expectedMemberCount
        const countMatches = expectedMemberCount === undefined
          || members.length === expectedMemberCount
        const membershipChangeObserved = baselineIdentityKey === undefined
          ? attempt > 0
          : conversationMemberIdentityKey(members) !== baselineIdentityKey
        const waitingForProjection = !countMatches || (
          options?.expectMembershipChange
          && !membershipChangeObserved
        )
        if (waitingForProjection) {
          if (attempt < retryDelays.length) continue
          const reason = !countMatches
            ? `expected ${expectedMemberCount}, received ${members.length}`
            : 'member identities did not change'
          throw new Error(
            `Conversation member projection mismatch for ${convId}: ${reason}`,
          )
        }

        const profiles = useUserProfileCache.getState()
        const profileIds: string[] = []
        for (const member of members) {
          if (!member.user_id) continue
          profileIds.push(member.user_id)
          const nickname = member.nickname?.trim()
          const username = member.username?.trim()
          const avatar = member.avatar?.trim()
          if (nickname || username || avatar) {
            profiles.upsertProfileHint({
              id: member.user_id,
              ...(nickname ? { nickname } : {}),
              ...(username ? { username } : {}),
              ...(avatar ? { avatar } : {}),
            })
          }
        }
        profiles.ensureProfiles(profileIds)
        set((state) => ({
          conversationMembers: {
            ...state.conversationMembers,
            [convId]: members,
          },
          conversations: state.conversations.map((conversation) =>
            conversation.id === convId
              ? applyConversationMemberCount(
                  conversation,
                  members.length,
                  !dmRestorationFailed,
                )
              : conversation,
          ),
        }))
        return
      }
    })().finally(() => {
      if (_latestConversationMemberRequestIds.get(convId) === requestId) {
        set((state) => ({
          conversationMembersLoading: {
            ...state.conversationMembersLoading,
            [convId]: false,
          },
        }))
      }
      if (_conversationMemberRequests.get(convId)?.requestId === requestId) {
        _conversationMemberRequests.delete(convId)
      }
    })
    _conversationMemberRequests.set(convId, {
      requestId,
      promise,
      baselineIdentityKey,
      hasProjectionBarrier,
    })
    return promise
  },

  clearConversationMessages: (convId) => {
    _latestMessageLoadRequestIds.set(
      convId,
      (_latestMessageLoadRequestIds.get(convId) ?? 0) + 1,
    )
    set((state) => ({
      messages: { ...state.messages, [convId]: [] },
      hasMoreMessages: { ...state.hasMoreMessages, [convId]: false },
      messageLoadingByConversation: {
        ...state.messageLoadingByConversation,
        [convId]: false,
      },
      conversations: state.conversations.map((c) =>
        c.id === convId
          ? {
              ...c,
              last_message_preview: '',
              last_message_reference: null,
            }
          : c,
      ),
    }))
  },

  removeConversation: (convId) => {
    const removedConversation = get().conversations.find((conversation) => conversation.id === convId)
    set((state) => {
      const conversations = state.conversations.filter((c) => c.id !== convId)
      const { [convId]: removedUnread, ...unreadCounts } = state.unreadCounts
      const { [convId]: _msgs, ...messages } = state.messages
      const { [convId]: _messageLoading, ...messageLoadingByConversation } = state.messageLoadingByConversation
      const { [convId]: _receipts, ...readReceipts } = state.readReceipts
      const { [convId]: _members, ...conversationMembers } = state.conversationMembers
      const { [convId]: _membersLoading, ...conversationMembersLoading } = state.conversationMembersLoading
      const lastOpenedConversationIdByOrganization = { ...state.lastOpenedConversationIdByOrganization }
      if (
        removedConversation?.organization_id
        && lastOpenedConversationIdByOrganization[removedConversation.organization_id] === convId
      ) {
        delete lastOpenedConversationIdByOrganization[removedConversation.organization_id]
      }
      return {
        conversations,
        unreadCounts,
        messages,
        messageLoadingByConversation,
        readReceipts,
        conversationMembers,
        conversationMembersLoading,
        lastOpenedConversationIdByOrganization,
        totalUnread: Math.max(0, state.totalUnread - (removedUnread || 0)),
        currentConversationId: state.currentConversationId === convId ? null : state.currentConversationId,
      }
    })
    _latestConversationMemberRequestIds.set(
      convId,
      ++_nextConversationMemberRequestId,
    )
    _latestMessageLoadRequestIds.set(
      convId,
      (_latestMessageLoadRequestIds.get(convId) ?? 0) + 1,
    )
    _conversationMemberRequests.delete(convId)
    // 会话删除 / 退群 / 解散后清理其会话桌面标签组（im:{conversationId}），
    // 避免残留标签在下次同 id（极小概率）或标签持久化里堆积。
    useSpaceContextTabsStore.getState().clearSpaceTabs(buildImConversationScopeKey(convId))
    if (removedConversation?.type === CONVERSATION_TYPE_GROUP) {
      invalidateMembershipQuotaUsage(queryClient, removedConversation.organization_id)
    }
  },

  // ── TC-37：会话 label actions ──

  loadLabels: async (organizationId, force = false) => {
    if (!force && get().labelsLoadedOrganizationId === organizationId) return
    const requestId = ++_latestLabelsLoadRequestId
    if (get().labelsLoadedOrganizationId !== organizationId) {
      // 标签和筛选是一个组织快照：切换时立即失效旧快照，避免旧 chip
      // 被显示或其 ID 被带入新组织的会话请求。
      set({
        labels: [],
        activeLabelFilters: [],
        activeLabelFiltersOrganizationId: organizationId,
        labelsLoadedOrganizationId: null,
      })
    }
    try {
      const labels = await tabchatApi.listLabels(organizationId)
      if (requestId !== _latestLabelsLoadRequestId) return
      // 系统 @me label 始终首位
      const sysLabel: ConversationLabel = {
        id: tabchatApi.SYSTEM_LABEL_MENTION_ID,
        name: '@me',
        color: '#ef4444',
        is_system: true,
        conversation_count: 0,
      }
      set({ labels: [sysLabel, ...labels], labelsLoadedOrganizationId: organizationId })
    } catch (err) {
      if (requestId !== _latestLabelsLoadRequestId) return
      log.error('Failed to load labels:', { organizationId, err })
    }
  },

  toggleLabelFilter: (labelId) => {
    set((state) => {
      const active = state.activeLabelFilters
      const newActive = active.includes(labelId)
        ? active.filter((id) => id !== labelId)
        : [...active, labelId]
      return {
        activeLabelFilters: newActive,
        activeLabelFiltersOrganizationId: state.labelsLoadedOrganizationId,
      }
    })
  },

  clearLabelFilters: () => set({ activeLabelFilters: [] }),

  createLabel: async (organizationId, name, color = '#6b7280') => {
    const label = await tabchatApi.createLabel(organizationId, name, color)
    set((state) => ({ labels: [...state.labels, label] }))
    return label
  },

  updateLabel: async (labelId, updates, _organizationId) => {
    const updated = await tabchatApi.updateLabel(labelId, updates)
    set((state) => ({
      labels: state.labels.map((l) => (l.id === labelId ? updated : l)),
    }))
    // 同步更新会话里的 label 信息
    set((state) => ({
      conversations: state.conversations.map((c) => ({
        ...c,
        labels: c.labels?.map((l) => (l.id === labelId ? { ...l, ...updates } : l)),
      })),
    }))
  },

  deleteLabel: async (labelId, _organizationId) => {
    await tabchatApi.deleteLabel(labelId)
    set((state) => ({
      labels: state.labels.filter((l) => l.id !== labelId),
      activeLabelFilters: state.activeLabelFilters.filter((id) => id !== labelId),
      conversations: state.conversations.map((c) => ({
        ...c,
        labels: c.labels?.filter((l) => l.id !== labelId),
      })),
    }))
  },

  addLabelsToConversation: async (convId, labelIds) => {
    // 乐观更新：先把 label 挂上；保存 prevLabels 以便失败回滚（bugbot medium）。
    const prevLabels = get().conversations.find((c) => c.id === convId)?.labels
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== convId) return c
        const existing = c.labels || []
        const toAdd = state.labels.filter(
          (l) => labelIds.includes(l.id) && !existing.some((e) => e.id === l.id),
        )
        return { ...c, labels: [...existing, ...toAdd] }
      }),
    }))
    try {
      const result = await tabchatApi.addConversationLabels(convId, labelIds)
      // 用后端权威结果校正（result.labels 含系统 @me）
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === convId ? { ...c, labels: result.labels } : c,
        ),
      }))
    } catch (err) {
      log.error('Failed to add labels:', { convId, labelIds, err })
      // 回滚：还原 prevLabels，不依赖 loadConversations（避免筛选/organization 缺失下失效）。
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === convId && prevLabels ? { ...c, labels: prevLabels } : c,
        ),
      }))
      throw err
    }
  },

  removeLabelFromConversation: async (convId, labelId) => {
    const prevLabels = get().conversations.find((c) => c.id === convId)?.labels
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === convId
          ? { ...c, labels: c.labels?.filter((l) => l.id !== labelId) }
          : c,
      ),
    }))
    try {
      const result = await tabchatApi.removeConversationLabel(convId, labelId)
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === convId ? { ...c, labels: result.labels } : c,
        ),
      }))
    } catch (err) {
      log.error('Failed to remove label:', { convId, labelId, err })
      // 回滚
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === convId && prevLabels ? { ...c, labels: prevLabels } : c,
        ),
      }))
      throw err
    }
  },

  onMessageDeleted: (convId, message, recalledContent) => {
    set((state) => {
      const msgs = state.messages[convId]
      if (!msgs) return state

      const updatedMsgs = msgs.map((m) =>
        matchesMessageForMutation(m, message)
          ? {
              ...m,
              is_deleted: true,
              content: '',
              // 仅本端撤回时携带原文，供「重新编辑」回填输入框；
              // 其它端收到的撤回事件不带 content，故无此入口。
              ...(recalledContent != null ? { _recalledContent: recalledContent } : {}),
            }
          : replyTargetsMessage(m, message) && m.reply_to_preview
            ? {
                ...m,
                reply_to_preview: {
                  ...m.reply_to_preview,
                  content: '消息内容不可用',
                },
              }
          : m,
      )

      // 若被撤回的消息是最新一条，更新会话 preview
      const lastVisible = [...updatedMsgs].reverse().find((m) => !m.is_deleted)
      const matchedConv = state.conversations.find((c) => c.id === convId)
      const isGroup = matchedConv?.type === CONVERSATION_TYPE_GROUP
      const conversations = sortConversations(
        state.conversations.map((c) => {
          if (c.id !== convId) return c
          return {
            ...c,
            last_message_preview: lastVisible ? buildPreview(lastVisible, isGroup) : '',
            last_message_at: lastVisible?.created_at ?? c.last_message_at,
            last_message_reference:
              conversationReferenceFromMessage(lastVisible),
          }
        }),
      )

      // 撤回的消息若在置顶列表里，一并移除（后端也会广播 unpinned，这里先本地兜底）。
      const existingPinned = state.pinnedMessages[convId]
      const nextPinned = existingPinned?.some((item) =>
        messagesShareStableIdentity(item, message))
        ? {
            ...state.pinnedMessages,
            [convId]: existingPinned.filter((item) =>
              !messagesShareStableIdentity(item, message)),
          }
        : state.pinnedMessages

      return {
        messages: { ...state.messages, [convId]: updatedMsgs },
        conversations,
        pinnedMessages: nextPinned,
      }
    })
  },

  loadPinnedMessages: async (convId) => {
    const revisionAtStart = _pinnedMessageStateRevisions.get(convId) ?? 0
    try {
      const pinned = await tabchatApi.getPinnedMessages(convId)
      if ((_pinnedMessageStateRevisions.get(convId) ?? 0) !== revisionAtStart) return
      set((state) => ({
        pinnedMessages: { ...state.pinnedMessages, [convId]: pinned },
      }))
    } catch (err) {
      log.warn('Failed to load pinned messages:', { convId, err })
    }
  },

  onMessagePinned: (convId, message) => {
    _pinnedMessageStateRevisions.set(
      convId,
      (_pinnedMessageStateRevisions.get(convId) ?? 0) + 1,
    )
    set((state) => {
      const existing = state.pinnedMessages[convId] || []
      const deduped = existing.filter((m) => m.id !== message.id)
      // 最近置顶在前（与后端 list 排序一致）。
      const nextList = [message, ...deduped]
      const msgs = state.messages[convId]
      const messages = msgs
        ? { ...state.messages, [convId]: msgs.map((m) => (m.id === message.id ? { ...m, is_pinned: true, pinned_at: message.pinned_at } : m)) }
        : state.messages
      return {
        pinnedMessages: { ...state.pinnedMessages, [convId]: nextList },
        messages,
      }
    })
  },

  onMessageUnpinned: (convId, messageId) => {
    _pinnedMessageStateRevisions.set(
      convId,
      (_pinnedMessageStateRevisions.get(convId) ?? 0) + 1,
    )
    set((state) => {
      const existing = state.pinnedMessages[convId]
      const pinnedMessages = existing
        ? { ...state.pinnedMessages, [convId]: existing.filter((m) => m.id !== messageId) }
        : state.pinnedMessages
      const msgs = state.messages[convId]
      const messages = msgs
        ? { ...state.messages, [convId]: msgs.map((m) => (m.id === messageId ? { ...m, is_pinned: false, pinned_at: null } : m)) }
        : state.messages
      return { pinnedMessages, messages }
    })
  },

  onMessageEdited: (convId, message) => {
    set((state) => {
      const msgs = state.messages[convId]
      if (!msgs) return state
      const updatedMsgs = mergeAndSortMessages(msgs, [message])
      // 若编辑的是最新可见消息，刷新会话 preview。
      const lastVisible = [...updatedMsgs].reverse().find((m) => !m.is_deleted)
      const matchedConv = state.conversations.find((c) => c.id === convId)
      const isGroup = matchedConv?.type === CONVERSATION_TYPE_GROUP
      const conversations = lastVisible && messagesShareStableIdentity(lastVisible, message)
        ? sortConversations(
            state.conversations.map((c) =>
              c.id === convId
                ? {
                    ...c,
                    last_message_preview: buildPreview(lastVisible, isGroup),
                    last_message_reference:
                      conversationReferenceFromMessage(lastVisible),
                  }
                : c,
            ),
          )
        : state.conversations
      return { messages: { ...state.messages, [convId]: updatedMsgs }, conversations }
    })
  },

  onRealtimeMessage: (convId, message, options) => {
    const stateBefore = get()
    // 成员被移出组织后，membership 事件会先清掉本地会话；已在途的 provider
    // 事件若晚到，绝不能写入缓存或触发 OS 通知。
    if (!stateBefore.conversations.some((conversation) => conversation.id === convId)) {
      log.warn('dropping realtime message for inaccessible conversation:', { convId, messageId: message.id })
      return
    }

    const hadKnownMessage = (stateBefore.messages[convId] || []).some(
      (current) => messagesShareStableIdentity(current, message),
    )
    const hadRenderableMessage = (stateBefore.messages[convId] || []).some(
      (current) => (
        messagesShareStableIdentity(current, message)
        && !isPendingTabTinReferenceMessage(current)
      ),
    )
    const previousMessage = (stateBefore.messages[convId] || []).find(
      (current) => messagesShareStableIdentity(current, message),
    )
    const gainedTransportLocator = hadKnownMessage
      && !previousMessage?.transport
      && Boolean(message.transport)

    set((state) => {
      const existing = state.messages[convId] || []
      const isAgentProgress = message.metadata?.kind === 'agent_progress'
      const isAgentStream = message.metadata?.kind === 'agent_stream'
      const isPendingPointer = isPendingTabTinReferenceMessage(message)
      const matchedConv = state.conversations.find((c) => c.id === convId)
      const matchingIndex = existing.findIndex((current) =>
        messagesShareStableIdentity(current, message))
      const previous = matchingIndex >= 0 ? existing[matchingIndex] : undefined
      const authoritativeMessage: IMMessage = {
        ...(previous ?? {}),
        ...message,
        id: previous && previous.id > 0 && message.id === 0
          ? previous.id
          : message.id,
        content: isPendingPointer && previous?.content
          ? previous.content
          : message.content,
        message_type: isPendingPointer && previous
          ? previous.message_type
          : message.message_type,
        reply_to_id: isPendingPointer && previous
          ? previous.reply_to_id
          : message.reply_to_id,
        has_attachment: isPendingPointer && previous
          ? previous.has_attachment
          : message.has_attachment,
        metadata: {
          ...(previous?.metadata ?? {}),
          ...message.metadata,
        },
        _optimistic: false,
        _failed: undefined,
        _retrying: undefined,
        _tempId: undefined,
        read_receipt: message.read_receipt ?? previous?.read_receipt,
        reactions: overlayLocalReactionSnapshot(convId, message).reactions
          ?? previous?.reactions,
      }
      const updatedMsgs = mergeAndSortMessages(
        existing,
        [authoritativeMessage],
      )

      const newMessages = { ...state.messages, [convId]: updatedMsgs }
      if (
        isAgentProgress
        || isAgentStream
        || (isPendingPointer && authoritativeMessage.content.length === 0)
      ) {
        return {
          ...state,
          messages: newMessages,
        }
      }

      const isGroup = matchedConv?.type === CONVERSATION_TYPE_GROUP
      const latestVisibleMessage = [...updatedMsgs]
        .reverse()
        .find((current) => !current.is_deleted)
      const latestMessage = updatedMsgs[updatedMsgs.length - 1]
      const updatesConversationSummary = latestMessage != null
        && messagesShareStableIdentity(latestMessage, authoritativeMessage)
      const summaryMessage = authoritativeMessage.is_deleted
        ? latestVisibleMessage
        : authoritativeMessage
      const conversations = updatesConversationSummary
        ? sortConversations(
            state.conversations.map((c) =>
              c.id === convId
                ? {
                    ...c,
                    last_message_at:
                      summaryMessage?.created_at || c.last_message_at,
                    last_message_preview: summaryMessage
                      ? buildPreview(summaryMessage, isGroup)
                      : '',
                    last_message_reference:
                      conversationReferenceFromMessage(summaryMessage),
                  }
                : c,
            ),
          )
        : state.conversations

      const isCurrentConv = isConversationVisibleForRead(convId, state)
      const isSystemMsg = message.message_type === MESSAGE_TYPE_SYSTEM
      let unreadCounts = state.unreadCounts
      let totalUnread = state.totalUnread
      // 系统消息（成员加入/退出等提示）不计未读，避免打扰
      if (
        options?.incrementUnread !== false
        && !hadKnownMessage
        && !isCurrentConv
        && !isSystemMsg
      ) {
        const prev = unreadCounts[convId] || 0
        unreadCounts = { ...unreadCounts, [convId]: prev + 1 }
        totalUnread = totalUnread + 1
      }

      return { messages: newMessages, conversations, unreadCounts, totalUnread }
    })

    // The provider may publish unread.updated before message.upserted. The first event
    // can only acknowledge the previous local sequence; once the message is in
    // the store, advance the active conversation to the authoritative new tail.
    if (
      (!hadKnownMessage || gainedTransportLocator)
      && isConversationVisibleForRead(convId, get())
    ) {
      void get().markAsRead(convId)
    }

    // 实时到达的附件消息也即时检查可用性（接收方进会话即有结果）
    if (message.message_type === MESSAGE_TYPE_FILE || message.message_type === MESSAGE_TYPE_IMAGE) {
      useFileAttachmentStore.getState().ensureChecked([message])
    }

    // 系统消息不触发桌面通知（成员进出提示不应打扰用户）
    if (
      !hadRenderableMessage
      && message.message_type !== MESSAGE_TYPE_SYSTEM
      && message.metadata?.kind !== 'agent_progress'
      && message.metadata?.kind !== 'agent_stream'
      && message.metadata?.kind !== 'agent_final'
      && !isPendingTabTinReferenceMessage(message)
    ) {
      handleDesktopNotification({
        convId,
        message,
        matchedConv: stateBefore.conversations.find((c) => c.id === convId),
        isCurrentConv: isConversationVisibleForRead(convId, stateBefore),
      })
    }
  },

  removePendingMessageByRef: (convId, messageRef) => {
    set((state) => {
      const existing = state.messages[convId] || []
      const messages = existing.filter((message) => !(
        message.id === 0
        && message.seq == null
        && message.metadata.message_ref === messageRef
      ))
      if (messages.length === existing.length) return state
      return {
        messages: {
          ...state.messages,
          [convId]: messages,
        },
      }
    })
  },

  onUnreadUpdate: (convId, notify) => {
    const state = get()
    const isCurrentConv = isConversationVisibleForRead(convId, state)

    if (isCurrentConv) {
      set((current) => {
        const oldCount = current.unreadCounts[convId] || 0
        if (oldCount <= 0) return current
        const unreadCounts = { ...current.unreadCounts }
        delete unreadCounts[convId]
        return {
          unreadCounts,
          totalUnread: Math.max(0, current.totalUnread - oldCount),
          conversations: current.conversations.map((c) =>
            c.id === convId ? { ...c, unread_count: 0 } : c,
          ),
        }
      })
      void get().markAsRead(convId)
      return
    }

    const conv = state.conversations.find(c => c.id === convId)

    if (notify?.preview) {
      set((current) => {
        const currentConv = current.conversations.find(c => c.id === convId)
        const prevCount = current.unreadCounts[convId] ?? currentConv?.unread_count ?? 0
        const nextCount = prevCount + 1
        return {
          unreadCounts: { ...current.unreadCounts, [convId]: nextCount },
          totalUnread: current.totalUnread + 1,
          conversations: current.conversations.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  unread_count: nextCount,
                  last_message_preview: notify.preview ?? c.last_message_preview,
                  last_message_reference: null,
                }
              : c,
          ),
        }
      })
    }

    // TC-4：非当前会话收到新消息 → 桌面通知。im.message 仅推到 chat:{convId}
    // （前端仅订阅当前打开会话），未打开会话收不到，故通知改由 unread.update
    // 携带的内容触发；放在角标刷新之前，conv 不在本地 cache 时也能用 payload
    // 兜底字段弹出（不被下方 skip 分支拦掉）。
    if (notify?.preview) {
      showUnreadDesktopNotification(convId, notify, state.conversations)
    }

    // Wave 4：personal:{userId} 频道现 24/7 跨 organization 推送，事件 organization
    // 来源必须从 conv 自身字段解析。**不再** fallback 到当前前台 organization
    // —— 否则会去拉错误团队的 unreadCounts，让真正变化的团队角标静默漏更新。
    // conv 尚未进入本地缓存时，使用服务端 personal 事件携带的 organization_id
    // 拉取会话列表和精确未读，避免新会话或后台会话长期不刷新。
    const eventOrganizationId = conv?.organization_id ?? notify?.organizationId
    if (!eventOrganizationId) {
      log.warn('onUnreadUpdate: missing organization identity, skipping:', { convId })
      return
    }

    const existingTimer = _unreadDebounceTimers.get(eventOrganizationId)
    if (existingTimer) clearTimeout(existingTimer)
    const nextTimer = setTimeout(() => {
      _unreadDebounceTimers.delete(eventOrganizationId)
      void get().loadConversations(eventOrganizationId)
      void get().loadUnreadCounts(eventOrganizationId)
    }, 2000)
    _unreadDebounceTimers.set(eventOrganizationId, nextTimer)
  },

  onNewConversation: (convData) => {
    // Wave 4：缺 conversation id 时**不再** fallback 到当前 organization 拉
    // conversations。事件可能来源于任意 organization，错位拉取浪费请求且无意义。
    // 显式带 organization_id 才刷新对应 organization；否则忽略（让下次正常刷新补齐）。
    if (!convData?.id) {
      const eventOrganizationId = typeof convData?.organization_id === 'string' ? convData.organization_id : null
      if (eventOrganizationId) {
        void get().loadConversations(eventOrganizationId)
      } else {
        // 降级：事件缺 conversation id 且缺 organization_id，无法归属，丢弃
        log.warn('onNewConversation: missing conversation id and organization_id, skipping')
      }
      return
    }

    const convId = convData.id
    // Wave 4：新 conversation 必须显式带 organization_id，否则丢弃事件。conv
    // 入库时如 fallback 到当前 organization，跨 organization 事件会被错误归属，导致
    // sidebar 在错误团队下显示该会话，并被 useIMStore.loadConversations 的
    // 「按 organization 替换」机制反复擦写。
    const organizationIdForConv = convData.organization_id
    if (!organizationIdForConv) {
      // 降级：新会话缺 organization_id，丢弃事件避免跨 organization 错误归属
      log.warn('onNewConversation: conversation missing organization_id, skipping:', { convId })
      return
    }
    const convType = convData.type ?? 1
    if (convData.is_external) {
      void tabchatApi.getConversation(convId).then((conversation) => {
        set((state) => ({
          conversations: sortConversations([
            ...state.conversations.filter((item) => item.id !== convId),
            conversation,
          ]),
        }))
      }).catch((error) => {
        log.warn('onNewConversation: failed to resolve external directory scope:', {
          convId,
          error,
        })
        const selectedOrganizationId = useOrganizationStore.getState().selectedOrganization?.id
        if (selectedOrganizationId) {
          void get().loadConversations(selectedOrganizationId)
        }
      })
      if (convType === CONVERSATION_TYPE_GROUP) {
        invalidateMembershipQuotaUsage(queryClient, organizationIdForConv)
      }
      return
    }
    set((state) => {
      if (state.conversations.some((c) => c.id === convId)) return state

      const newConv: Conversation = {
        id: convId,
        organization_id: organizationIdForConv,
        space_id: convData.space_id ?? null,
        space_name: convData.space_name ?? '',
        is_team_space_channel: convData.is_team_space_channel ?? false,
        type: convType,
        name: convData.name ?? '',
        avatar_url: convData.avatar_url ?? '',
        member_count: convData.member_count ?? 0,
        is_archived: convData.is_archived ?? false,
        last_message_at: convData.last_message_at ?? null,
        last_message_preview: convData.last_message_preview ?? '',
        last_message_reference: convData.last_message_reference ?? null,
        unread_count: convData.unread_count ?? 0,
        created_at: convData.created_at ?? new Date().toISOString(),
        dm_peer_user_id: convData.dm_peer_user_id,
        dm_peer_organization_id: convData.dm_peer_organization_id,
        can_send: convData.can_send,
        dm_peer_membership_status: convData.dm_peer_membership_status,
        pinned: convData.pinned ?? false,
        is_muted: convData.is_muted ?? false,
      }

      return {
        conversations: sortConversations([...state.conversations, newConv]),
      }
    })
    if (convType === CONVERSATION_TYPE_GROUP) {
      invalidateMembershipQuotaUsage(queryClient, organizationIdForConv)
    }
  },

  onReadReceipt: (convId, userId, lastReadMessageId, lastReadSeq, previousLastReadSeq) => {
    set((state) => {
      const prev = state.readReceipts[convId]?.[userId] ?? 0
      if (lastReadMessageId <= prev) return state

      const readReceipts = {
        ...state.readReceipts,
        [convId]: {
          ...state.readReceipts[convId],
          [userId]: lastReadMessageId,
        },
      }
      const conversation = state.conversations.find((item) => item.id === convId)
      const currentUserId = useAuthStore.getState().user?.id
      const messages = state.messages[convId]

      // 服务端携带这次水位推进的 seq 区间，前端只累加该区间内本人发出的消息。
      // 群聊据此画进度环；私聊气泡只看 message.read_receipt.read_count，
      // 不写回消息会让对方打开后仍停在空心圆。
      const shouldUpdateMessageReceipts = (
        conversation?.type === CONVERSATION_TYPE_GROUP
        || conversation?.type === CONVERSATION_TYPE_DM
      )
      if (
        !shouldUpdateMessageReceipts
        || !currentUserId
        || userId === currentUserId
        || !messages?.length
      ) {
        return { readReceipts }
      }

      const lowerBound = previousLastReadSeq ?? 0
      const upperBound = lastReadSeq ?? lastReadMessageId
      const updatedMessages = messages.map((message) => {
        const messageSeq = message.seq ?? message.id
        if (
          message.sender_id !== currentUserId
          || messageSeq <= lowerBound
          || messageSeq > upperBound
        ) {
          return message
        }
        // 刚发出的消息常无 read_receipt（乐观确认 / Centrifugo echo 都不带）；
        // 不能因此丢掉实时已读，否则要重进会话拉历史才看得见。
        const recipientCount = message.read_receipt?.recipient_count
          ?? defaultGroupRecipientCount(conversation?.member_count)
        const prevCount = message.read_receipt?.read_count ?? 0
        return {
          ...message,
          read_receipt: {
            read_count: Math.min(recipientCount, prevCount + 1),
            recipient_count: recipientCount,
          },
        }
      })

      return {
        readReceipts,
        messages: {
          ...state.messages,
          [convId]: updatedMessages,
        },
      }
    })
  },

  onReactionUpdated: (convId, messageRef, emoji, userId, action, source = 'local') => {
    const normalizedRef = messageRef.trim()
    if (!normalizedRef) return
    const { canonicalRef, message } = resolveCanonicalReactionRef(convId, normalizedRef)
    seedReactionSnapshotFromMessage(convId, canonicalRef, message)
    const snapshot = updateReactionSnapshot(
      convId,
      canonicalRef,
      emoji,
      userId,
      action,
      source,
    )
    set((state) => {
      const msgs = state.messages[convId]
      if (!msgs) return state
      return {
        messages: {
          ...state.messages,
          [convId]: msgs.map((m) => {
            const refs = reactionIdentityRefs(m)
            if (!refs.includes(normalizedRef) && !refs.includes(canonicalRef)) return m
            return {
              ...m,
              reactions: snapshot.reactions,
              reaction_counts: snapshot.counts,
            }
          }),
        },
      }
    })
  },

  onReactionSnapshot: (convId, messageRef, reactions, reactionCounts) => {
    const normalizedRef = messageRef.trim()
    if (!normalizedRef) return
    const key = reactionSnapshotKey(convId, normalizedRef)
    const current = _reactionSnapshotsByReference.get(key) ?? {
      reactions: {},
      counts: {},
    }
    const next: LocalReactionSnapshot = {
      reactions: Object.fromEntries(
        Object.entries(current.reactions).map(([emoji, users]) => [
          emoji,
          [...users],
        ]),
      ),
      counts: { ...current.counts },
    }
    for (const emoji of new Set([
      ...Object.keys(reactions),
      ...Object.keys(reactionCounts),
    ])) {
      const users = Array.from(new Set(reactions[emoji] ?? []))
      const count = Math.max(0, reactionCounts[emoji] ?? users.length)
      if (count === 0) {
        delete next.reactions[emoji]
        delete next.counts[emoji]
      } else {
        next.reactions[emoji] = users
        next.counts[emoji] = Math.max(count, users.length)
      }
    }
    _reactionSnapshotsByReference.set(key, next)
    set((state) => {
      const messages = state.messages[convId]
      if (!messages) return state
      return {
        messages: {
          ...state.messages,
          [convId]: messages.map((message) => (
            message.metadata.message_ref === normalizedRef
              ? {
                  ...message,
                  reactions: next.reactions,
                  reaction_counts: next.counts,
                }
              : message
          )),
        },
      }
    })
  },
}))

// 订阅导航事件：其他视图激活时关闭 IM
const _unsubNav = onNavigate((target) => {
  if (target !== 'im') {
    useIMStore.getState().closeIM()
  }
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _authUnsubscribe?.()
    _authUnsubscribe = null
    _cachedIdentity = null
    _notifDebounceMap.clear()
    _imInFlight.clear()
    _latestMessageLoadRequestIds.clear()
    _latestConversationsLoadRequestIds.clear()
    _latestSessionShareLoadRequestIds.clear()
    _pendingSessionShareV2Loads.clear()
    _activeSessionShareV2Loads.clear()
    _latestSessionContinuationLoadRequestIds.clear()
    _latestConversationMemberRequestIds.clear()
    _conversationMemberRequests.clear()
    _latestLabelsLoadRequestId++
    _filteredUnreadRepairSkips.clear()
    for (const timer of _unreadDebounceTimers.values()) clearTimeout(timer)
    _unreadDebounceTimers.clear()
    _unsubNav?.()
  })
}

registerResetAction('im', 'reset', () => useIMStore.getState().resetIMState())
