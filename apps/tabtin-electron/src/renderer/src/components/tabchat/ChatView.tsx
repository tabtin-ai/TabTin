/**
 * ChatView — 右栏聊天区（消息列表 + 输入框 + 头部 + 回复状态管理）
 */

import React, { useEffect, useCallback, useLayoutEffect, useState, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import { useShallow } from 'zustand/react/shallow'
import { useIMStore } from '@stores/useIMStore'
import { useAuthStore } from '@stores/useAuthStore'
import { useFileAttachmentStore } from '@stores/useFileAttachmentStore'
import { useUserProfileCache, useDisplayName } from '@stores/useUserProfileCache'
import { getMessages, editMessage, type ConversationMember } from '@/services/tabchatApi'
import { ChatHeader } from './ChatHeader'
import { IMMessageList, type IMMessageListHandle } from './IMMessageList'
import { IMMessageInput } from './IMMessageInput'
import { ConversationDetailPanel } from './ConversationDetailPanel'
import { ReplyThreadPanel } from './ReplyThreadPanel'
import { FilteredHistoryList } from './FilteredHistoryList'
import { PinnedMessagesBar } from './PinnedMessagesBar'
import { isAgentMember } from './conversationMembers'
import type { IMMessage } from '@/services/tabchatApi'
import { mergeAndSortMessages, messageStableKey } from '@/services/im/messageMerge'
import { isConversationNotFoundError } from '@/services/im/conversationAvailability'
import { isPendingTabTinReferenceMessage } from '@/services/im/tabtinReferenceMessages'
import { subscribeChat, unsubscribeChat } from '@/hooks/useCentrifugoClient'
import {
  CHAT_CONTENT_FILTER_DOCUMENT,
  CHAT_CONTENT_FILTER_FILE,
  CHAT_CONTENT_FILTER_MESSAGE,
  CONVERSATION_TYPE_DM,
  CONVERSATION_TYPE_GROUP,
  MEMBER_ROLE_ADMIN,
  MESSAGE_TYPE_FILE,
  MESSAGE_TYPE_IMAGE,
  MESSAGE_TYPE_TEXT,
  type ChatContentFilter,
} from '@/constants/tabchat'

const EMPTY_MESSAGES: IMMessage[] = []
const EMPTY_CONVERSATION_MEMBERS: ConversationMember[] = []

/** 消息列表底部在浮动输入框之外再额外留的间距，避免末条消息贴在半透明输入框后面透出 */
const MESSAGE_LIST_BOTTOM_GAP = 16

/**
 * 测量底栏整体高度，以及输入框 pill 底边到底栏底部的间隙（pill 下方的内边距）。
 * 列表容器底边据此对齐到输入框 pill 的底边（消息可滚到玻璃后、但不超出其底部）。
 */
function useBottomBarMetrics(): [React.RefCallback<HTMLDivElement>, { height: number; belowInput: number }] {
  const [metrics, setMetrics] = useState({ height: 0, belowInput: 0 })
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!node) return
    const update = () => {
      const barRect = node.getBoundingClientRect()
      const pill = node.querySelector('[data-im-composer]')
      const belowInput = pill
        ? Math.max(0, Math.round(barRect.bottom - pill.getBoundingClientRect().bottom))
        : 0
      setMetrics({ height: barRect.height, belowInput })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    const pill = node.querySelector('[data-im-composer]')
    if (pill) observer.observe(pill)
    return () => observer.disconnect()
  }, [node])
  return [setNode, metrics]
}

function matchesContentFilter(message: IMMessage, contentFilter: ChatContentFilter) {
  if (contentFilter === CHAT_CONTENT_FILTER_MESSAGE) return true
  if (message.is_deleted) return false
  if (contentFilter === CHAT_CONTENT_FILTER_DOCUMENT) {
    return message.message_type === MESSAGE_TYPE_TEXT
      && (message.metadata?.card?.type === 'document' || message.metadata?.card?.type === 'table')
  }
  if (contentFilter === CHAT_CONTENT_FILTER_FILE) {
    return message.message_type === MESSAGE_TYPE_FILE
      || message.message_type === MESSAGE_TYPE_IMAGE
  }
  return false
}

interface Props {
  conversationId: string
  topBarLeftInset?: number
  topBarRightInset?: number
  /** IM 会话桌面态：隐藏头部内容筛选 tab（云文档/文件/消息），资产改由右侧收起栏 + 画布承载。 */
  hideContentTabs?: boolean
}

export const ChatView: React.FC<Props> = ({
  conversationId,
  topBarLeftInset = 0,
  topBarRightInset = 0,
  hideContentTabs = false,
}) => {
  const { t } = useTranslation('tabchat')
  const loadMessagesFailedTitle = t('loadMessagesFailed')
  const {
    messages,
    messageSnapshot,
    loadMessages,
    sendMessage,
    isSending,
    isMessageLoading,
    memberSnapshot,
    refreshConversationMembers,
  } = useIMStore(useShallow((s) => ({
    messages: s.messages[conversationId] || EMPTY_MESSAGES,
    messageSnapshot: s.messages[conversationId],
    loadMessages: s.loadMessages,
    sendMessage: s.sendMessage,
    isSending: s.isSending,
    isMessageLoading: s.messageLoadingByConversation[conversationId] ?? false,
    memberSnapshot: s.conversationMembers[conversationId],
    refreshConversationMembers: s.refreshConversationMembers,
  })))
  const [bottomBarRef, bottomBarMetrics] = useBottomBarMetrics()
  const { height: bottomBarHeight, belowInput: bottomBelowInput } = bottomBarMetrics
  const [detailOpen, setDetailOpen] = useState(false)
  const [replyThreadRoot, setReplyThreadRoot] = useState<IMMessage | null>(null)
  const [replyTo, setReplyTo] = useState<IMMessage | null>(null)
  // 撤回后「重新编辑」：把原文塞回输入框。token 变化驱动输入框受控覆写一次。
  const [composerDraft, setComposerDraft] = useState<{
    conversationId: string
    text: string
    token: number
  } | null>(null)
  const [editingMessage, setEditingMessage] = useState<IMMessage | null>(null)
  const messageListRef = useRef<IMMessageListHandle | null>(null)
  const members = memberSnapshot ?? EMPTY_CONVERSATION_MEMBERS
  const membersLoaded = memberSnapshot !== undefined
  const myUserId = useAuthStore((s) => s.user?.id)
  const conversation = useIMStore(
    (s) => s.conversations.find((candidate) => candidate.id === conversationId),
  )
  const conversationType = conversation?.type
  const supportsGroupMessageActions = conversation?.transport_kind !== 'c2c'
  const canManagePins = useMemo(() => {
    if (!supportsGroupMessageActions) return false
    if (conversationType === CONVERSATION_TYPE_DM) return true
    const me = members.find((m) => m.member_type !== 'agent' && m.user_id === myUserId)
    return (me?.role ?? 0) >= MEMBER_ROLE_ADMIN
  }, [conversationType, members, myUserId, supportsGroupMessageActions])
  const agentMemberIds = useMemo(() => members
    .filter(isAgentMember)
    .map((member) => member.agent_id)
    .filter((agentId): agentId is string => Boolean(agentId)), [members])
  const currentHumanDomainMembers = useMemo(() => (
    membersLoaded
      ? members
        .filter((member) => !isAgentMember(member))
        .filter((member): member is typeof member & { user_id: string; participant_organization_id: string } => (
          Boolean(member.user_id && member.participant_organization_id)
        ))
      : undefined
  ), [members, membersLoaded])
  const currentHumanRecipientKey = useMemo(() => (
    currentHumanDomainMembers
      ?.filter((member) => member.user_id !== myUserId)
      .map((member) => `${member.participant_organization_id}\0${member.user_id}`)
      .sort()
      .join('\0')
  ), [currentHumanDomainMembers, myUserId])
  const [receiptIdentitySnapshot, setReceiptIdentitySnapshot] = useState<{
    key: string
    memberIds: readonly string[]
  } | null>(null)
  useEffect(() => {
    if (currentHumanRecipientKey === undefined) return
    let cancelled = false
    const recipients = (currentHumanDomainMembers ?? [])
      .filter((member): member is ConversationMember & { user_id: string } => (
        Boolean(member.user_id) && member.user_id !== myUserId
      ))
      .sort((left, right) => (
        `${left.participant_organization_id}\0${left.user_id}`
          .localeCompare(`${right.participant_organization_id}\0${right.user_id}`)
      ))
    Promise.resolve(recipients.map((member) => member.user_id))
      .then((memberIds) => {
        if (cancelled) return
        const profiles = useUserProfileCache.getState()
        memberIds.forEach((providerMemberId, index) => {
          const member = recipients[index]
          if (!member) return
          profiles.upsertProfileHint({
            id: providerMemberId,
            nickname: member.nickname ?? '',
            username: member.username ?? '',
            avatar: member.avatar ?? '',
          })
        })
        setReceiptIdentitySnapshot({ key: currentHumanRecipientKey, memberIds })
      })
      .catch(() => {
        if (!cancelled) setReceiptIdentitySnapshot(null)
      })
    return () => {
      cancelled = true
    }
  }, [currentHumanRecipientKey, currentHumanDomainMembers, members, myUserId])
  const currentHumanMemberIds = receiptIdentitySnapshot
    && receiptIdentitySnapshot.key === currentHumanRecipientKey
    ? receiptIdentitySnapshot.memberIds
    : undefined
  const [contentFilter, setContentFilter] = useState<ChatContentFilter>(CHAT_CONTENT_FILTER_MESSAGE)
  const [filteredMessages, setFilteredMessages] = useState<IMMessage[]>(EMPTY_MESSAGES)
  const [isLoadingFilteredMessages, setIsLoadingFilteredMessages] = useState(false)
  const [hasMoreFilteredMessages, setHasMoreFilteredMessages] = useState(true)
  const filteredRequestSeqRef = useRef(0)
  // 记录本次会话挂载时的跳转意图。子列表可能先消费 target，不能再从 store 读取而误拉最新页覆盖目标窗口。
  const initialScrollTarget = useMemo(() => ({
    conversationId,
    targetConversationId: useIMStore.getState().scrollTargetConversationId,
  }), [conversationId])

  // Reactive profile hooks
  const replyToName = useDisplayName(replyTo?.sender_id ?? null) || undefined

  useEffect(() => {
    if (!conversationId) return
    subscribeChat(conversationId)
    return () => {
      unsubscribeChat(conversationId)
    }
  }, [conversationId])

  useEffect(() => {
    // 引用/搜索跳转已由 navigateToMessage 直取目标所在页；此时再拉最新页会覆盖目标窗口。
    if (initialScrollTarget.targetConversationId !== conversationId) {
      void loadMessages(conversationId)
    }
    if (supportsGroupMessageActions) {
      void useIMStore.getState().loadPinnedMessages?.(conversationId)
    }
  }, [conversationId, initialScrollTarget, loadMessages, supportsGroupMessageActions])

  // 首次进入会话时加载共享成员快照；后续成员事件直接替换同一份状态。
  useEffect(() => {
    let cancelled = false
    refreshConversationMembers(conversationId)
      .catch((err) => {
        if (cancelled) return
        console.warn('[TabChat] ChatView: failed to load members:', err)
        if (isConversationNotFoundError(err)) {
          useIMStore.getState().removeConversation(conversationId)
        }
      })
    return () => {
      cancelled = true
    }
  }, [conversationId, refreshConversationMembers])

  // 切换会话时清除当前会话附属 UI 状态，避免群聊侧栏残留到私聊。
  useEffect(() => {
    setReplyTo(null)
    setReplyThreadRoot(null)
    setComposerDraft(null)
    setEditingMessage(null)
  }, [conversationId])

  // 详情/成员面板改为「按需滑出的浮层抽屉」（毛玻璃遮罩盖住聊天区、不挤压宽度）；
  // 切换会话时收起。点顶栏成员/详情图标滑出。
  useEffect(() => {
    setDetailOpen(false)
  }, [conversationId])

  useEffect(() => {
    if (replyTo?.sender_id) {
      useUserProfileCache.getState().ensureProfiles([replyTo.sender_id])
    }
  }, [replyTo?.sender_id])

  // 会话桌面态隐藏内容筛选 tab 时，强制回到消息流（资产改由画布承载），
  // 避免切进桌面态时残留在旧的文档/文件筛选视图。
  useEffect(() => {
    if (hideContentTabs && contentFilter !== CHAT_CONTENT_FILTER_MESSAGE) {
      setContentFilter(CHAT_CONTENT_FILTER_MESSAGE)
    }
  }, [hideContentTabs, contentFilter])

  const isFilteredHistory = contentFilter !== CHAT_CONTENT_FILTER_MESSAGE

  const loadFilteredMessages = useCallback(
    async (before?: IMMessage) => {
      if (contentFilter === CHAT_CONTENT_FILTER_MESSAGE) return false
      const requestSeq = ++filteredRequestSeqRef.current
      setIsLoadingFilteredMessages(true)
      try {
        const result = await getMessages(conversationId, before, undefined, contentFilter)
        if (filteredRequestSeqRef.current !== requestSeq) return false
        if (result.length === 0) {
          setHasMoreFilteredMessages(false)
        }
        useFileAttachmentStore.getState().ensureChecked(result)
        setFilteredMessages((current) => (before == null ? result : [...result, ...current]))
        return result.length > 0
      } catch (err) {
        if (filteredRequestSeqRef.current === requestSeq) {
          console.error('[TabChat] Failed to load filtered messages:', err)
          toast({ title: loadMessagesFailedTitle, variant: 'destructive' })
        }
        return false
      } finally {
        if (filteredRequestSeqRef.current === requestSeq) {
          setIsLoadingFilteredMessages(false)
        }
      }
    },
    [contentFilter, conversationId, loadMessagesFailedTitle],
  )

  useEffect(() => {
    filteredRequestSeqRef.current += 1
    setFilteredMessages(EMPTY_MESSAGES)
    setIsLoadingFilteredMessages(false)
    setHasMoreFilteredMessages(true)
    if (contentFilter === CHAT_CONTENT_FILTER_MESSAGE) return
    void loadFilteredMessages()
  }, [contentFilter, conversationId, loadFilteredMessages])

  const handleSend = useCallback(
    (content: string, replyTarget?: IMMessage, messageType?: number, metadata?: Record<string, unknown>) => {
      if (!content.trim() && !metadata) return
      if (contentFilter !== CHAT_CONTENT_FILTER_MESSAGE) {
        setContentFilter(CHAT_CONTENT_FILTER_MESSAGE)
      }
      const replyToPreview = replyTarget
        ? { content: replyTarget.content.slice(0, 100), sender_id: replyTarget.sender_id }
        : undefined
      const sendPromise = sendMessage({
        convId: conversationId,
        content: content.trim(),
        metadata,
        replyTo: replyTarget,
        replyToPreview,
        messageType,
      })
      // 主路径仍由 IMMessageList 根据 messages 更新滚底；这里兜底处理 React 合并 optimistic
      // 与确认态更新的场景，避免组件只看到确认态而错过"刚发送"那一帧。
      void sendPromise.finally(() => {
        const currentConversationId = useIMStore.getState().currentConversationId
        if (currentConversationId !== conversationId) return
        messageListRef.current?.scrollToBottom()
      })
    },
    [contentFilter, conversationId, sendMessage],
  )

  const handleReply = useCallback((message: IMMessage) => {
    setEditingMessage(null)
    setReplyTo(message)
  }, [])

  const handleOpenReplyThread = useCallback((message: IMMessage) => {
    const rootId = message.reply_to_id ?? message.id
    const root = messages.find(candidate => (
      message.reply_to_ref
        ? candidate.metadata.message_ref === message.reply_to_ref
        : candidate.id === rootId
    ))
      ?? (message.reply_to_id != null || message.reply_to_ref ? {
        id: rootId,
        conversation_id: conversationId,
        sender_id: message.reply_to_preview?.sender_id || message.sender_id,
        content: message.reply_to_preview?.content || '图片',
        message_type: MESSAGE_TYPE_TEXT,
        reply_to_id: null,
        reply_to_preview: null,
        has_attachment: false,
        metadata: {},
        created_at: null,
      } : message)
    setDetailOpen(false)
    setReplyThreadRoot(root)
  }, [conversationId, messages])

  const handleCloseReplyThread = useCallback(() => {
    setReplyThreadRoot(null)
  }, [])

  const handleReEdit = useCallback((content: string) => {
    setReplyTo(null)
    setEditingMessage(null)
    setComposerDraft({ conversationId, text: content, token: Date.now() })
  }, [conversationId])

  const handleEdit = useCallback((message: IMMessage) => {
    setReplyTo(null)
    setEditingMessage(message)
  }, [])

  const handleCancelEdit = useCallback(() => {
    setEditingMessage(null)
  }, [])

  const handleSubmitEdit = useCallback(
    async (message: IMMessage, content: string, metadata?: Record<string, unknown>) => {
      try {
        const updated = await editMessage(conversationId, message, content, metadata)
        if (updated) useIMStore.getState().onMessageEdited(conversationId, updated)
      } catch (err) {
        console.error('[TabChat] Failed to edit message:', err)
        toast({ title: t('editFailed', { defaultValue: '编辑失败' }), variant: 'destructive' })
      }
    },
    [conversationId, t],
  )

  const handleCancelReply = useCallback(() => {
    setReplyTo(null)
  }, [])

  const handleToggleDetail = useCallback(() => {
    setDetailOpen((current) => !current)
  }, [])

  const handleCloseDetail = useCallback(() => {
    setDetailOpen(false)
  }, [])

  const handleHistoryCleared = useCallback(() => {
    filteredRequestSeqRef.current += 1
    setFilteredMessages(EMPTY_MESSAGES)
    setIsLoadingFilteredMessages(false)
    setHasMoreFilteredMessages(false)
    setReplyTo(null)
  }, [])

  const deletedMessageIds = useMemo(
    () => new Set(messages.filter((message) => message.is_deleted).map(messageStableKey)),
    [messages],
  )

  const apiFilteredMessages = useMemo(
    () => filteredMessages.filter((message) =>
      message.conversation_id === conversationId && !deletedMessageIds.has(messageStableKey(message)),
    ),
    [conversationId, deletedMessageIds, filteredMessages],
  )

  const visibleFilteredMessages = useMemo(
    () => {
      const realtime = messages.filter((message) => matchesContentFilter(message, contentFilter))
      return mergeAndSortMessages(apiFilteredMessages, realtime)
    },
    [apiFilteredMessages, contentFilter, messages],
  )

  const handleLoadMore = useCallback(async () => {
    const activeMessages = isFilteredHistory ? apiFilteredMessages : messages
    if (activeMessages.length === 0) {
      if (isFilteredHistory && hasMoreFilteredMessages) {
        return loadFilteredMessages()
      }
      return
    }
    const oldest = activeMessages[0]
    if (isFilteredHistory) {
      return loadFilteredMessages(oldest)
    }
    const result = await loadMessages(conversationId, oldest)
    return result.length > 0
  }, [
    conversationId,
    apiFilteredMessages,
    hasMoreFilteredMessages,
    isFilteredHistory,
    loadFilteredMessages,
    loadMessages,
    messages,
  ])

  const sourceMessages = isFilteredHistory ? visibleFilteredMessages : messages
  const visibleMessages = useMemo(
    () => sourceMessages.filter((message) => !isPendingTabTinReferenceMessage(message)),
    [sourceMessages],
  )
  const visibleIsLoading = isFilteredHistory ? isLoadingFilteredMessages : isMessageLoading
  const isInitialLoading = !isFilteredHistory
    && messageSnapshot === undefined
    && isMessageLoading
  const emptyLabel = contentFilter === CHAT_CONTENT_FILTER_DOCUMENT
    ? t('contentFilterDocumentsEmpty')
    : contentFilter === CHAT_CONTENT_FILTER_FILE
      ? t('contentFilterFilesEmpty')
      : undefined

  return (
    <div className="tabchat-skin relative flex h-full min-w-0 w-full overflow-hidden">
      <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-transparent">
        {/* 顶栏：实底排布，与主工作区其它模块一致（不再浮动渐隐毛玻璃） */}
        <div className="flex-shrink-0 z-sticky bg-background">
          <ChatHeader
            conversationId={conversationId}
            onToggleDetail={handleToggleDetail}
            isDetailOpen={detailOpen}
            contentFilter={contentFilter}
            onContentFilterChange={setContentFilter}
            topBarLeftInset={topBarLeftInset}
            topBarRightInset={topBarRightInset}
            hideContentTabs={hideContentTabs}
          />
          {!isFilteredHistory && supportsGroupMessageActions
            ? <PinnedMessagesBar conversationId={conversationId} canManage={canManagePins} />
            : null}
        </div>

        {/* 消息区 + 底部输入：消息从顶栏下方正常排布；输入仍浮在底部 */}
        <div data-im-chat-layout className="relative flex min-h-0 flex-1 flex-col">
          <div
            className="absolute inset-x-0 top-0 flex flex-col"
            style={{ bottom: bottomBelowInput }}
          >
            {isFilteredHistory ? (
              <FilteredHistoryList
                messages={visibleMessages}
                conversationId={conversationId}
                contentFilter={contentFilter === CHAT_CONTENT_FILTER_FILE
                  ? CHAT_CONTENT_FILTER_FILE
                  : CHAT_CONTENT_FILTER_DOCUMENT}
                isLoading={visibleIsLoading}
                hasMore={hasMoreFilteredMessages}
                onLoadMore={handleLoadMore}
                emptyLabel={emptyLabel || t('noMessages')}
                bottomInset={bottomBarHeight - bottomBelowInput + MESSAGE_LIST_BOTTOM_GAP}
              />
            ) : (
              <IMMessageList
                key={conversationId}
                ref={messageListRef}
                messages={visibleMessages}
                conversationId={conversationId}
                isLoading={visibleIsLoading}
                isInitialLoading={isInitialLoading}
                onLoadMore={handleLoadMore}
                onReply={handleReply}
                onOpenReplyThread={handleOpenReplyThread}
                onReEdit={handleReEdit}
                onEdit={handleEdit}
                canManagePins={canManagePins}
                agentMemberIds={agentMemberIds}
                currentHumanMemberIds={currentHumanMemberIds}
                emptyLabel={emptyLabel}
                bottomInset={bottomBarHeight - bottomBelowInput + MESSAGE_LIST_BOTTOM_GAP}
              />
            )}
          </div>

          {/* 输入框：浮动在消息列表下方。底栏本身透明，两侧露聊天暗底；不透明面在输入井卡片上（飞书风） */}
          <div
            ref={bottomBarRef}
            data-testid="im-composer-bottom-bar"
            className="absolute inset-x-0 bottom-0 z-sticky"
          >
            <IMMessageInput
              key={conversationId}
              conversationId={conversationId}
              onSend={handleSend}
              isSending={isSending}
              replyTo={replyTo}
              replyToName={replyToName}
              onCancelReply={handleCancelReply}
              members={members}
              membersLoaded={membersLoaded}
              allowMentionAll={conversationType === CONVERSATION_TYPE_GROUP}
              draft={composerDraft?.conversationId === conversationId ? composerDraft : null}
              editingMessage={editingMessage}
              onSubmitEdit={handleSubmitEdit}
              onCancelEdit={handleCancelEdit}
              allowRichContent={!conversation?.is_external}
            />
          </div>
        </div>
      </div>
      <ConversationDetailPanel
        conversationId={conversationId}
        isOpen={detailOpen}
        onClose={handleCloseDetail}
        onHistoryCleared={handleHistoryCleared}
      />
      <ReplyThreadPanel
        root={replyThreadRoot}
        replies={replyThreadRoot ? messages.filter(message => (
          replyThreadRoot.metadata.message_ref
            ? message.reply_to_ref === replyThreadRoot.metadata.message_ref
            : message.reply_to_id === replyThreadRoot.id
        )) : EMPTY_MESSAGES}
        isOpen={replyThreadRoot != null}
        onClose={handleCloseReplyThread}
      />
    </div>
  )
}
