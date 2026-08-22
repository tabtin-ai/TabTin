/**
 * IMMessageBubble — 消息气泡（左右布局 + 时间分组 + 系统消息 + 文件/图片 + Markdown + 回复引用）
 */

import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkAutolinkResource from '@tabtin/markdown-resource-autolink'
import rehypeSanitize from 'rehype-sanitize'
import { sanitizeSchema, rehypeSanitizeCss } from '@/lib/rehypeSanitizeSchema'
import {
  FileText, Download, Share2, Bot, FileX,
  FileSpreadsheet, Presentation, FileCode, FileJson, FileQuestion,
  Check, CheckCircle2, Loader2, FolderOpen, MessageSquare,
} from 'lucide-react'
import { copyImageToClipboard } from '@components/chat/preview/copyImageToClipboard'
import { safeCopyToClipboard } from '@components/chat/utils/clipboard'
import { ImImageContextMenu } from './ImImageContextMenu'
import { OVERLAY_SURFACE_CLASS, toast } from '@components/ui'
import {
  handleResourceLinkClick,
  handleResourceLinkContextMenu,
} from '@/services/openResourceLink'
import {
  MESSAGE_RECALL_WINDOW_MS,
  MESSAGE_TYPE_TEXT,
  MESSAGE_TYPE_SYSTEM,
  MESSAGE_TYPE_FILE,
  MESSAGE_TYPE_IMAGE,
} from '@/constants/tabchat'

type RehypePlugin = (...args: unknown[]) => (tree: unknown) => void

let _rehypeHlCache: RehypePlugin | null = null
let _rehypeHlPromise: Promise<RehypePlugin> | null = null
function loadRehypeHl(): Promise<RehypePlugin> {
  if (_rehypeHlCache) return Promise.resolve(_rehypeHlCache)
  if (!_rehypeHlPromise) {
    _rehypeHlPromise = import('rehype-highlight').then(m => {
      _rehypeHlCache = m.default as RehypePlugin
      return _rehypeHlCache
    })
  }
  return _rehypeHlPromise
}
function useRehypeHl() {
  const [p, setP] = useState<RehypePlugin | null>(_rehypeHlCache)
  useEffect(() => {
    if (p) return
    let mounted = true
    loadRehypeHl().then((v) => {
      if (mounted) setP(() => v)
    })
    return () => {
      mounted = false
    }
  }, [p])
  return p
}
import type { IMMessage, MessageReadReceipts } from '@/services/tabchatApi'
import {
  createAgentTaskFromMessage,
  deleteMessage,
  getMessageReadReceipts,
  pinMessage,
  unpinMessage,
  addReaction,
  removeReaction,
} from '@/services/tabchatApi'
import type { ChatSession } from '@tabtin/chat-client'
import { useAuthStore } from '@stores/useAuthStore'
import { useIMStore } from '@stores/useIMStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useUserProfileCache, useDisplayName, useDisplayNames, useAvatar } from '@stores/useUserProfileCache'
import { enterTeamSpaceProject } from '@components/layout/project/teamSpaceProjectNavigation'
import { useChatStore } from '@stores/chat/useChatStore'
import { useUIStore } from '@stores/useUIStore'
import { formatFileSize } from '@/services/tabchatAttachmentApi'
import { sanitizeUrl } from '@/lib/sanitizeUrl'
import { cn } from '@utils/cn'
import { formatMessageClock, formatMessageDateDivider, isSameCalendarDay } from '@/lib/dateUtils'
import { getNameColor } from './imNameColor'
import {
  IM_MESSAGE_BUBBLE_TEXT,
  IM_MESSAGE_MARKDOWN_TEXT,
  IM_GROUP_READ_PROGRESS_DOT_CLASS,
  IM_READ_RECEIPT_ANCHOR_CLASS,
  IM_READ_RECEIPT_MARK_CLASS,
  IM_UNREAD_RECEIPT_DOT_CLASS,
} from './tabchatUi'
import { createImMarkdownComponents } from './imMarkdownComponents'
import { useImConversationCanvas } from './ImConversationCanvasContext'
import { TabTinCustomCardRenderer } from './cards/TabTinCustomCardRenderer'
import { AgentMemberBadges } from './AgentMemberBadges'
import { ColorAvatar } from './ColorAvatar'
import { agentOwnerDisplayName } from './conversationMembers'
import { isMentionHref } from './mentionMarkdown'
import { MENTION_ALL_ALIASES } from './resolveMentionsFromText'
import { IM_COLLAPSE_CHAR_THRESHOLD, IMCollapsibleContent } from './IMCollapsibleContent'
import { resolveIMCollapsibleMessageKey } from './imCollapsibleMessageKey'
import { ForwardDialog } from './ForwardDialog'
import { EmojiReactionBar } from './EmojiReactionBar'
import { showReactionErrorToast } from './reactionErrorToast'
import { IMMessageActionBar } from './IMMessageActionBar'
import { useIMMessageScrollLock } from './imMessageScrollLock'
import { resolveTabtinRobotStickerMetadata } from './stickers/tabtinRobotPack'
import { resolveImImageFrame } from './imImageFrame'
import { TeamSpaceCreateTaskDialog } from './TeamSpaceCreateTaskDialog'
import { resolveReadReceiptMemberPresentation } from './readReceiptMemberPresentation'
import { projectHumanReadReceipt } from '@/services/im/humanReadReceipt'
import { useFileAttachmentStore } from '@stores/useFileAttachmentStore'
import { messageStableKey } from '@/services/im/messageMerge'
import { useScopedEventListener } from '@hooks/spaceActivity'
import { downloadImAttachment } from './downloadImAttachment'
import { canOpenImFilePreview, openImFilePreview, resolveImAttachmentDownloadUrl } from './openImFilePreview'
import { openImImagePreview } from './openImImagePreview'
import { createLogger } from '@/utils/logger'
import { PROJECTS_UI_ENABLED } from '@/utils/featureFlags'
import {
  canForwardTabTinCustomCard,
  isTabTinCustomCardContent,
  isSystemManagedTabTinCard,
} from '@/services/im/cards/tabtinCustomCardModel'
import {
  planGroupMemberDirectChat,
  resolveGroupMemberDirectChat,
} from './resolveGroupMemberDirectChat'

const log = createLogger('IMMessageBubble')

interface Props {
  message: IMMessage
  prevMessage: IMMessage | null
  onReply?: (message: IMMessage) => void
  /** 打开只读回复详情；不在侧栏内发送。 */
  onOpenReplyThread?: (message: IMMessage) => void
  replyCount?: number
  onReEdit?: (content: string) => void
  onEdit?: (message: IMMessage) => void
  onRetryFailed?: (message: IMMessage) => void
  isDM?: boolean
  isHighlighted?: boolean
  /** 是否可置顶/取消置顶（群聊仅管理员，私聊任意成员）。功能3 */
  canManagePins?: boolean
  /** 会话中的 Agent 身份不参与人类已读回执。 */
  agentMemberIds?: readonly string[]
  /** 当前仍在群内的人类成员；用于排除消息发送后已被移除的收件人。 */
  currentHumanMemberIds?: readonly string[]
}

// 本地文件卡（海报式瘦长方形）：整张卡一个深色调、白字；按扩展名分色分图标，
// 未知类型走灰色「?」。
type FileTypeStyle = { Icon: React.ComponentType<{ className?: string }>; bg: string }
const FILE_TYPE_STYLES: Record<string, FileTypeStyle> = {
  doc: { Icon: FileText, bg: 'bg-blue-500' },
  docx: { Icon: FileText, bg: 'bg-blue-500' },
  xls: { Icon: FileSpreadsheet, bg: 'bg-emerald-600' },
  xlsx: { Icon: FileSpreadsheet, bg: 'bg-emerald-600' },
  ppt: { Icon: Presentation, bg: 'bg-orange-500' },
  pptx: { Icon: Presentation, bg: 'bg-orange-500' },
  pdf: { Icon: FileText, bg: 'bg-red-500' },
  md: { Icon: FileCode, bg: 'bg-slate-600' },
  json: { Icon: FileJson, bg: 'bg-amber-500' },
  txt: { Icon: FileText, bg: 'bg-gray-500' },
}
const UNKNOWN_FILE_STYLE: FileTypeStyle = {
  Icon: FileQuestion,
  bg: 'bg-gray-400 dark:bg-gray-600',
}
function getFileTypeStyle(fileName: string): FileTypeStyle {
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
  return FILE_TYPE_STYLES[ext] || UNKNOWN_FILE_STYLE
}

const MARKDOWN_HINT = /[*_`#\-\[\]!|>~\\]/
const TABTIN_RESOURCE_LINK_HINT = /tabtin(?:-preprod|-dev)?:\/\/resource\//
const TABTIN_RESOURCE_URL = /^tabtin(?:-preprod|-dev)?:\/\/resource\//i
const CODE_BLOCK_HINT = /```|~~~|(^|\n)( {4}|\t)\S/
// 纯文本路径里识别裸 URL（http(s):// 或 www.）做 autolink。markdown 路径由 GFM 处理。
const URL_RE = /((?:https?:\/\/|www\.)[^\s<]+)/gi
// URL 尾随标点不应吞进链接（句号/逗号/右括号/中文标点等）。
const URL_TRAILING_RE = /[.,;:!?)\]}'"，。！？、；：""''）】]+$/u
const EMPTY_IDS: string[] = []
/** 操作条最大占位：最多 6 个 28px 按钮 + 分隔与间距，并包含消息侧 8px 间隔。 */
const IM_MESSAGE_ACTION_RAIL_WIDTH = 208
/** 窄对话栏里消息内容仍要可读；低于该宽度后不再继续为操作条压缩消息。 */
const IM_MESSAGE_ROW_MIN_WIDTH = 220

function imMarkdownUrlTransform(value: string): string {
  if (isMentionHref(value) || TABTIN_RESOURCE_URL.test(value)) return value
  return defaultUrlTransform(value)
}

/** 已读详情的最大高度 / 宽度（Tailwind max-h-80 / w-80），用于在打开前决定落点并钳进视口。 */
const READ_RECEIPT_DETAIL_MAX_HEIGHT = 320
const READ_RECEIPT_DETAIL_WIDTH = 320
const READ_RECEIPT_DETAIL_GAP = 8
const READ_RECEIPT_VIEWPORT_MARGIN = 8

type ReadReceiptPanelPosition = {
  placement: 'above' | 'below'
  left: number
  top?: number
  bottom?: number
}

type MarkdownAstNode = {
  type?: string
  children?: MarkdownAstNode[]
}
type RehypeTransformer = (tree: MarkdownAstNode, file: unknown) => void
type RehypeAttacher = (...args: unknown[]) => RehypeTransformer | void

function rehypePruneInvalidChildren() {
  return (tree: MarkdownAstNode) => {
    const stack: MarkdownAstNode[] = [tree]
    while (stack.length > 0) {
      const node = stack.pop()
      if (!node || typeof node !== 'object') continue

      if ('children' in node) {
        if (!Array.isArray(node.children)) {
          delete node.children
          continue
        }

        const cleaned = node.children.filter(
          (child) => child != null && typeof child === 'object' && typeof child.type === 'string',
        )
        node.children = cleaned
        for (const child of cleaned) stack.push(child)
      }
    }
  }
}

function wrapSafeRehypeHighlight(attacher: RehypeAttacher) {
  return () => {
    let transformer: RehypeTransformer | undefined
    try {
      transformer = attacher() as RehypeTransformer | undefined
    } catch {
      return () => {}
    }
    return (tree: MarkdownAstNode, file: unknown) => {
      try {
        transformer?.(tree, file)
      } catch {
        // 高亮失败不应该影响消息本身渲染，代码块保持无高亮展示。
      }
    }
  }
}

function shouldShowTimestamp(current: IMMessage, prev: IMMessage | null): boolean {
  if (!prev) return true
  if (!current.created_at || !prev.created_at) return true
  const curr = new Date(current.created_at).getTime()
  const prevT = new Date(prev.created_at).getTime()
  return curr - prevT > 5 * 60 * 1000
}

export const IMMessageBubble: React.FC<Props> = React.memo(({ message, prevMessage, onReply, onOpenReplyThread, replyCount = 0, onReEdit, onEdit, onRetryFailed, isDM, isHighlighted, canManagePins, agentMemberIds = [], currentHumanMemberIds }) => {
  const { t } = useTranslation('tabchat')
  const rehypeHighlight = useRehypeHl()
  const userId = useAuthStore((s) => s.user?.id)
  const selectedAgentId = useSpaceStore((s) => s.selectedAgent?.id ?? null)
  const ensureProfiles = useUserProfileCache((s) => s.ensureProfiles)
  const userProfiles = useUserProfileCache((s) => s.profiles)
  const conversationOrganizationId = useIMStore(
    (s) => s.conversations.find((conversation) => conversation.id === message.conversation_id)?.organization_id,
  )
  const conversation = useIMStore(
    (s) => s.conversations.find((item) => item.id === message.conversation_id),
  )
  const senderMember = useIMStore(
    (s) => s.conversationMembers[message.conversation_id]?.find(
      (member) => member.user_id === message.sender_id,
    ),
  )
  const agentOwnerName = useIMStore((s) => {
    const members = s.conversationMembers?.[message.conversation_id]
    if (!members) return ''
    return agentOwnerDisplayName(
      members.find((member) => member.agent_id === message.sender_id),
    )
  })
  const conversationCanvas = useImConversationCanvas()
  const messageMarkdownComponents = useMemo(() => createImMarkdownComponents({
    tabScopeKey: conversationCanvas?.scopeKey,
    executionSpaceId: conversationCanvas?.executionSpaceId,
  }), [conversationCanvas?.executionSpaceId, conversationCanvas?.scopeKey])
  const isTeamSpaceChannel = Boolean(conversation?.is_team_space_channel && conversation.space_id)
  const isAgentUpdateSummary = Boolean(message.metadata?.team_space_agent_update)
  const agentUpdateSessionId = typeof message.metadata?.session_id === 'string'
    ? message.metadata.session_id
    : ''
  const isMine = message.sender_id === userId
  const isAgent = message.sender_type === 'agent'  // TC-8：AI 回复
  const isSystem = message.message_type === MESSAGE_TYPE_SYSTEM
  const canOpenSenderDM = !isDM && !isMine && !isAgent && !isSystem
    && Boolean(message.sender_id) && Boolean(conversationOrganizationId)
  const openingSenderDMRef = useRef(false)
  const isImage = message.message_type === MESSAGE_TYPE_IMAGE
  const isFile = message.message_type === MESSAGE_TYPE_FILE
  const [readReceiptDetail, setReadReceiptDetail] = useState<MessageReadReceipts | null>(null)
  const [isReadReceiptOpen, setIsReadReceiptOpen] = useState(false)
  const [readReceiptPosition, setReadReceiptPosition] = useState<ReadReceiptPanelPosition | null>(null)
  const conversationReadReceipts = useIMStore((state) => state.readReceipts[message.conversation_id])
  const readReceiptSnapshotRef = useRef(conversationReadReceipts)
  const readReceiptRequestGenerationRef = useRef(0)
  const groupReadReceiptCountsRef = useRef(
    `${message.id}:${message.read_receipt?.read_count ?? ''}:${message.read_receipt?.recipient_count ?? ''}`,
  )
  const readReceiptTriggerRef = useRef<HTMLButtonElement>(null)
  const readReceiptDetailRef = useRef<HTMLDivElement>(null)
  const {
    readCount: groupReadCount,
    unreadCount: groupUnreadCount,
    recipientCount: groupRecipientCount,
    detail: visibleReadReceiptDetail,
    hasAuthoritativeStatus: hasAuthoritativeGroupReadStatus,
    progress: groupReadProgress,
    isComplete: isGroupReadComplete,
  } = useMemo(() => projectHumanReadReceipt({
    receipt: message.read_receipt,
    detail: readReceiptDetail,
    agentIds: agentMemberIds,
    currentHumanMemberIds,
    senderId: message.sender_id,
  }), [agentMemberIds, currentHumanMemberIds, message.read_receipt, message.sender_id, readReceiptDetail])
  const hasReadStatus = isMine
    && !isSystem
    && !message._optimistic
    && !message._failed
    && !message.is_deleted
    && (isDM || hasAuthoritativeGroupReadStatus)
  const isSendingMessage = isMine
    && !isSystem
    && Boolean(message._optimistic)
    && !message._failed
    && !message.is_deleted
  const isRead = hasReadStatus && isDM && (
    (message.read_receipt?.read_count ?? 0) >= 1
  )

  const loadReadReceiptDetail = async (force = false) => {
    if (isDM || (!force && readReceiptDetail)) return
    const requestGeneration = ++readReceiptRequestGenerationRef.current
    try {
      const detail = await getMessageReadReceipts(message.conversation_id, message)
      if (readReceiptRequestGenerationRef.current === requestGeneration) {
        setReadReceiptDetail(detail)
      }
    } catch (error) {
      log.warn('Failed to load group message read receipts', { messageId: message.id, error })
    }
  }

  const readReceiptMemberIds = useMemo(() => (
    visibleReadReceiptDetail
      ? [...visibleReadReceiptDetail.readers, ...visibleReadReceiptDetail.unreaders]
        .map((member) => member.user_id)
      : []
  ), [visibleReadReceiptDetail])

  useEffect(() => {
    if (readReceiptMemberIds.length > 0) ensureProfiles(readReceiptMemberIds)
  }, [ensureProfiles, readReceiptMemberIds])

  // 群成员的实时回执会改变已读/未读名单；下次查看时必须重新取详情，不能沿用旧快照。
  useEffect(() => {
    if (readReceiptSnapshotRef.current === conversationReadReceipts) return
    readReceiptSnapshotRef.current = conversationReadReceipts
    readReceiptRequestGenerationRef.current += 1
    setReadReceiptDetail(null)
  }, [conversationReadReceipts])

  useEffect(() => {
    const countsSnapshot = `${message.id}:${message.read_receipt?.read_count ?? ''}:${message.read_receipt?.recipient_count ?? ''}`
    if (groupReadReceiptCountsRef.current === countsSnapshot) return
    groupReadReceiptCountsRef.current = countsSnapshot
    const requestGeneration = ++readReceiptRequestGenerationRef.current
    setReadReceiptDetail(null)
    if (isDM || !isReadReceiptOpen) return

    let active = true
    void getMessageReadReceipts(message.conversation_id, message)
      .then((detail) => {
        if (active && readReceiptRequestGenerationRef.current === requestGeneration) {
          setReadReceiptDetail(detail)
        }
      })
      .catch((error) => {
        log.warn('Failed to refresh group message read receipts', {
          messageId: message.id,
          error,
        })
      })
    return () => {
      active = false
    }
  }, [
    isDM,
    isReadReceiptOpen,
    message,
  ])

  // 已读详情挂到 body（fixed）：消息列表 / ChatView 的 overflow 会裁切 absolute 面板左侧。
  // 优先向下展开；靠近输入框时再向上。水平右对齐触发器并钳进视口，避免贴边被挡。
  const positionReadReceiptDetail = () => {
    const triggerRect = readReceiptTriggerRef.current?.getBoundingClientRect()
    if (!triggerRect || typeof window === 'undefined') return
    const spaceAbove = triggerRect.top
    const spaceBelow = window.innerHeight - triggerRect.bottom
    const requiredSpace = READ_RECEIPT_DETAIL_MAX_HEIGHT + READ_RECEIPT_DETAIL_GAP
    const canFitBelow = spaceBelow >= requiredSpace
    const canFitAbove = spaceAbove >= requiredSpace
    const placement: ReadReceiptPanelPosition['placement'] =
      canFitBelow || (!canFitAbove && spaceBelow >= spaceAbove) ? 'below' : 'above'
    const maxLeft = window.innerWidth - READ_RECEIPT_DETAIL_WIDTH - READ_RECEIPT_VIEWPORT_MARGIN
    const preferredLeft = triggerRect.right - READ_RECEIPT_DETAIL_WIDTH
    const left = Number.isFinite(preferredLeft)
      ? Math.max(READ_RECEIPT_VIEWPORT_MARGIN, Math.min(preferredLeft, maxLeft))
      : READ_RECEIPT_VIEWPORT_MARGIN
    if (placement === 'below') {
      setReadReceiptPosition({
        placement,
        top: triggerRect.bottom + READ_RECEIPT_DETAIL_GAP,
        left,
      })
      return
    }
    setReadReceiptPosition({
      placement,
      bottom: window.innerHeight - triggerRect.top + READ_RECEIPT_DETAIL_GAP,
      left,
    })
  }

  // 已读详情是轻量 popover：点消息区其他位置应立即收起，避免遮挡后续阅读和操作。
  const documentTarget = typeof document === 'undefined' ? null : document
  useScopedEventListener<PointerEvent>(documentTarget, 'pointerdown', (event) => {
    const target = event.target as Node
    if (!readReceiptTriggerRef.current?.contains(target) && !readReceiptDetailRef.current?.contains(target)) {
      setIsReadReceiptOpen(false)
    }
  }, { enabled: isReadReceiptOpen })
  useScopedEventListener<KeyboardEvent>(documentTarget, 'keydown', (event) => {
    if (event.key === 'Escape') setIsReadReceiptOpen(false)
  }, { enabled: isReadReceiptOpen })
  // 列表滚动后锚点失效；面板自身滚动不关闭。
  useScopedEventListener(documentTarget, 'scroll', (event) => {
    const target = event.target
    if (target instanceof Node && readReceiptDetailRef.current?.contains(target)) return
    setIsReadReceiptOpen(false)
  }, { enabled: isReadReceiptOpen, capture: true, passive: true })

  // 单列分组时间线（Discord 口径）：同发送者、5 分钟内、同一自然日的连续消息合并为
  // 一组，仅组首显示头像 + 昵称 + 时间；跨天插入日期分割线。自己发的消息也照常显示
  // 头像与昵称（不再左右分栏）。
  const showDateDivider = !prevMessage || !isSameCalendarDay(prevMessage.created_at, message.created_at)
  const gapBreak = shouldShowTimestamp(message, prevMessage)
  const senderChanged = !prevMessage
    || prevMessage.sender_id !== message.sender_id
    || prevMessage.sender_type !== message.sender_type
  const isGroupStart = showDateDivider || gapBreak || senderChanged

  // Reactive profile hooks — profile 异步加载完成后自动触发重渲染。
  // Agent 没有 user profile，名字直接取消息自带的 sender_name（后端=Agent.name）。
  const profileSenderName = useDisplayName(!isAgent ? message.sender_id : null)
  const profileSenderAvatar = useAvatar(!isAgent ? message.sender_id : null)
  const senderName = isAgent ? (message.sender_name || t('aiAssistant')) : profileSenderName
  const senderAvatar = isAgent ? '' : profileSenderAvatar
  const replySenderName = useDisplayName(message.reply_to_preview?.sender_id)
  const mentionedIds: string[] = message.metadata?.mentioned_user_ids || EMPTY_IDS
  const mentionAll = Boolean(message.metadata?.mention_all)
  const mentionNames = useDisplayNames(mentionedIds)

  const [hovered, setHovered] = useState(false)
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [recalling, setRecalling] = useState(false)
  const [downloadingFile, setDownloadingFile] = useState(false)
  const [creatingAgentTask, setCreatingAgentTask] = useState(false)
  const [imageContextMenu, setImageContextMenu] = useState<{ x: number; y: number; url: string } | null>(null)
  const [fileContextMenu, setFileContextMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const [textContextMenu, setTextContextMenu] = useState<{ x: number; y: number } | null>(null)
  const textBubbleRef = useRef<HTMLDivElement | null>(null)
  const fileAttachment = useFileAttachmentStore((s) => ((isFile || isImage) ? s.statuses[messageStableKey(message)] : undefined))
  const markAttachmentUnavailable = useFileAttachmentStore((s) => s.markUnavailable)
  const refreshAttachment = useFileAttachmentStore((s) => s.refresh)
  const markAttachmentDownloaded = useFileAttachmentStore((s) => s.markDownloaded)
  /** 消息行被虚拟列表复用时，新消息仍应有一次独立的换链机会。 */
  const retriedImageMessageIdRef = useRef<number | null>(null)
  const [forwardDialogOpen, setForwardDialogOpen] = useState(false)
  const [agentTaskDialogOpen, setAgentTaskDialogOpen] = useState(false)
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)

  const openSenderDM = useCallback(() => {
    if (!canOpenSenderDM || openingSenderDMRef.current || !message.sender_id || !conversationOrganizationId) return
    openingSenderDMRef.current = true
    void resolveGroupMemberDirectChat({
      organizationId: conversationOrganizationId,
      userId: message.sender_id,
      participantOrganizationId: senderMember?.participant_organization_id,
      memberIsExternal: Boolean(senderMember?.is_external),
      conversationIsExternal: Boolean(conversation?.is_external),
    }).then((target) => {
      const plan = planGroupMemberDirectChat(
        conversationOrganizationId,
        message.sender_id,
        target,
      )
      if (plan.type === 'reject') {
        toast({ title: t(plan.messageKey), variant: 'destructive' })
        return
      }
      return useIMStore.getState().createConversationAndActivate(plan.input)
    }).catch((error) => {
      log.error('Failed to open DM from group message sender', { messageId: message.id, error })
      toast({ title: t('createFailed'), variant: 'destructive' })
    }).finally(() => {
      openingSenderDMRef.current = false
    })
  }, [
    canOpenSenderDM,
    conversation?.is_external,
    conversationOrganizationId,
    message.id,
    message.sender_id,
    senderMember?.is_external,
    senderMember?.participant_organization_id,
    t,
  ])

  const clearHoverCloseTimer = useCallback(() => {
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current)
      hoverCloseTimerRef.current = null
    }
  }, [])

  const showActionBar = useCallback(() => {
    clearHoverCloseTimer()
    setHovered(true)
  }, [clearHoverCloseTimer])

  const scheduleHideActionBar = useCallback(() => {
    clearHoverCloseTimer()
    hoverCloseTimerRef.current = setTimeout(() => {
      setHovered(false)
      hoverCloseTimerRef.current = null
    }, 180)
  }, [clearHoverCloseTimer])

  const handleMoreMenuOpenChange = useCallback((open: boolean) => {
    if (open) {
      // 打开瞬间清掉待隐藏定时器，避免 180ms 后 hovered=false 造成闪一下。
      clearHoverCloseTimer()
      setHovered(true)
    }
    setMoreMenuOpen(open)
  }, [clearHoverCloseTimer])

  // 「更多」/表情打开时锁消息列表滚动，避免长消息把操作条滚出视口。
  useIMMessageScrollLock(moreMenuOpen || emojiPickerOpen)

  useEffect(() => clearHoverCloseTimer, [clearHoverCloseTimer])

  const recallStartedAt = message._localSentAt ?? message.created_at
  const canRecall = Boolean(
    isMine && !message.is_deleted && !message._optimistic && !isSystem && recallStartedAt
      && (Date.now() - new Date(recallStartedAt).getTime()) < MESSAGE_RECALL_WINDOW_MS,
  )

  const handleRecall = async () => {
    if (recalling) return
    setRecalling(true)
    // 撤回前缓存原文：序列化层与 store 都会清空 content，缓存后才能「重新编辑」回填。
    // 仅纯文本消息可回填——文件/图片/卡片的 content 是文件名/占位文案，回填无意义。
    const reEditable = !isFile && !isImage && !message.metadata?.card && !!message.content
    const original = reEditable ? message.content : undefined
    try {
      await deleteMessage(message.conversation_id, message)
      useIMStore.getState().onMessageDeleted(message.conversation_id, message, original)
    } catch (err) {
      console.error('[TabChat] Failed to recall message:', err)
      toast({ title: t('recallFailed'), variant: 'destructive' })
    } finally {
      setRecalling(false)
    }
  }

  const canPin = Boolean(canManagePins) && !isSystem && !message.is_deleted && !message._optimistic
  // 编辑：仅本人的纯文本消息（非文件/图片/卡片/系统/已撤回/未确认）。无时限。
  const canEdit = Boolean(onEdit) && isMine && !isSystem && !isFile && !isImage
    && !message.is_deleted && !message._optimistic && !message.metadata?.card
  const [pinning, setPinning] = useState(false)
  const handleTogglePin = async () => {
    if (pinning) return
    setPinning(true)
    const wasPinned = message.is_pinned
    try {
      if (wasPinned) {
        await unpinMessage(message.conversation_id, message)
        useIMStore.getState().onMessageUnpinned(message.conversation_id, message.id)
      } else {
        const pinned = await pinMessage(message.conversation_id, message)
        useIMStore.getState().onMessagePinned(message.conversation_id, pinned)
      }
    } catch (err) {
      console.error('[TabChat] Failed to toggle pin:', err)
      toast({ title: t(wasPinned ? 'unpinFailed' : 'pinFailed', { defaultValue: wasPinned ? '取消置顶失败' : '置顶失败' }), variant: 'destructive' })
      void useIMStore.getState().loadPinnedMessages(message.conversation_id)
    } finally {
      setPinning(false)
    }
  }

  const handleCreateAgentTask = async (additionalContext = '') => {
    if (!isTeamSpaceChannel || !conversation?.space_id || creatingAgentTask) return
    if (!selectedAgentId) {
      toast({
        title: t('agentRequired', { defaultValue: '请先选择一个 Agent' }),
        variant: 'destructive',
      })
      return
    }
    setCreatingAgentTask(true)
    try {
      const result = await createAgentTaskFromMessage(
        message.conversation_id,
        message.id,
        selectedAgentId,
        additionalContext,
      )
      const session = result.session as unknown as ChatSession
      const chatStore = useChatStore.getState()
      chatStore.upsertSessionInSpace(result.space_id, session)
      enterTeamSpaceProject(result.space_id)
      useUIStore.getState().setChatSidePanelCollapsed(false)
      chatStore.setCurrentSessionForSpace(result.space_id, result.session_id, true)
      chatStore.clearSessionMessages(result.session_id)
      await chatStore.selectSession(result.space_id, result.session_id)
      await chatStore.sendMessage(result.default_prompt, true, undefined, undefined, result.session_id, {
        spaceId: result.space_id,
        displayMessage: '基于频道消息询问 Agent',
      })
      setAgentTaskDialogOpen(false)
      toast({
        title: t('agentTaskCreated', { defaultValue: '已发送给 Agent' }),
        description: t('agentTaskCreatedDescription', {
          defaultValue: '源消息和回复已作为默认上下文带入。',
        }),
      })
    } catch (err) {
      log.error('Failed to create Project Agent task from IM message', err)
      toast({
        title: t('agentTaskCreateFailed', { defaultValue: '发送给 Agent 失败' }),
        variant: 'destructive',
      })
    } finally {
      setCreatingAgentTask(false)
    }
  }

  const handleOpenAgentUpdateTask = async () => {
    if (!agentUpdateSessionId || !conversation?.space_id) return
    try {
      enterTeamSpaceProject(conversation.space_id)
      const chatStore = useChatStore.getState()
      await chatStore.loadSessions(conversation.space_id, conversation.organization_id)
      await chatStore.selectSession(conversation.space_id, agentUpdateSessionId)
      useUIStore.getState().setChatSidePanelCollapsed(false)
    } catch (err) {
      log.error('Failed to open Project agent update task session', err)
      toast({
        title: t('agentTaskOpenFailed', { defaultValue: '打开任务线程失败' }),
        variant: 'destructive',
      })
    }
  }

  const reactionSequence = message.transport?.sequence ?? (
    typeof message.id === 'number' ? message.id : undefined
  )

  const handleQuickReaction = async (emoji: string) => {
    if (!userId) return
    const messageRef = typeof message.metadata.message_ref === 'string'
      ? message.metadata.message_ref.trim()
      : ''
    if (!messageRef) return
    const users = message.reactions?.[emoji] || []
    const isRemoving = users.includes(userId)
    const action = isRemoving ? 'remove' : 'add'
    useIMStore.getState().onReactionUpdated(
      message.conversation_id,
      messageRef,
      emoji,
      userId,
      action,
    )
    try {
      if (isRemoving) {
        await removeReaction(message.conversation_id, messageRef, emoji, reactionSequence)
      } else {
        await addReaction(message.conversation_id, messageRef, emoji, reactionSequence)
      }
    } catch (err) {
      log.error('Failed to add quick reaction', err)
      const rollbackAction = isRemoving ? 'add' : 'remove'
      useIMStore.getState().onReactionUpdated(
        message.conversation_id,
        messageRef,
        emoji,
        userId,
        rollbackAction,
      )
      showReactionErrorToast(err)
    }
  }

  const hasMarkdown = useMemo(
    () => MARKDOWN_HINT.test(message.content) || TABTIN_RESOURCE_LINK_HINT.test(message.content),
    [message.content],
  )
  const enableHighlight = useMemo(() => CODE_BLOCK_HINT.test(message.content), [message.content])
  const rehypePlugins = useMemo(() => {
    const plugins: NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']> = [
      rehypePruneInvalidChildren,
    ]
    if (rehypeHighlight && enableHighlight) {
      plugins.push(wrapSafeRehypeHighlight(rehypeHighlight as RehypeAttacher))
      plugins.push(rehypePruneInvalidChildren)
    }
    plugins.push([rehypeSanitize, sanitizeSchema])
    plugins.push(rehypeSanitizeCss)
    return plugins
  }, [enableHighlight, rehypeHighlight])

  useEffect(() => {
    const ids: string[] = []
    if (!isAgent && message.sender_id) ids.push(message.sender_id)
    if (message.reply_to_preview?.sender_id) ids.push(message.reply_to_preview.sender_id)
    for (const mid of mentionedIds) if (mid) ids.push(mid)
    if (ids.length) ensureProfiles(ids)
  }, [message.sender_id, message.reply_to_preview?.sender_id, mentionedIds, isAgent, ensureProfiles])

  const dateDivider = showDateDivider ? (
    <div className="flex justify-center px-4 my-3 select-none" aria-hidden="true">
      <span className="text-caption font-medium text-muted-foreground/60">
        {formatMessageDateDivider(message.created_at, t)}
      </span>
    </div>
  ) : null

  if (message.is_deleted) {
    const canReEdit = isMine && !!message._recalledContent && !!onReEdit
    return (
      <>
        {dateDivider}
        <div
          data-im-recalled-message
          data-message-alignment={isMine ? 'outgoing' : 'incoming'}
          className={`flex items-center px-4 py-0.5 ${isMine ? 'justify-end' : 'justify-start'}`}
        >
          <div className="flex items-center gap-2.5">
            {!isMine && <div className="w-9 flex-shrink-0" />}
            <span className="text-caption text-muted-foreground italic">
              {isMine ? t('youRecalledMessage') : t('messageRecalled')}
            </span>
            {canReEdit && (
              <button
                type="button"
                onClick={() => onReEdit?.(message._recalledContent ?? '')}
                className="text-caption text-accent-text hover:underline flex-shrink-0"
              >
                {t('reEdit')}
              </button>
            )}
          </div>
        </div>
      </>
    )
  }

  if (isSystem) {
    return (
      <>
        {dateDivider}
        <div className="px-4 my-1.5 flex justify-center">
          <span className="text-caption text-muted-foreground bg-muted/30 px-2.5 py-0.5 rounded-full">
            {message.content}
          </span>
        </div>
      </>
    )
  }

  const replyPreview = message.reply_to_preview
  const replyPreviewLabel = replyPreview?.message_type === MESSAGE_TYPE_IMAGE
    ? t('imageMessage', { defaultValue: '[图片]' })
    : replyPreview?.message_type === MESSAGE_TYPE_FILE
      ? t('fileMessage', { defaultValue: '[文件]' })
      : ''
  const replyPreviewContent = replyPreviewLabel
    ? `${replyPreviewLabel}${replyPreview?.content ? ` ${replyPreview.content}` : ''}`
    : replyPreview?.content || t('imageMessage', { defaultValue: '[图片]' })

  const resolveRenderableAttachmentUrl = (item: IMMessage): string => {
    const cached = useFileAttachmentStore.getState().statuses[messageStableKey(item)]
    if (item.metadata?.file_id) {
      return cached?.status === 'available' ? sanitizeUrl(cached.downloadUrl) : ''
    }
    if (cached?.status === 'unavailable') return ''
    return sanitizeUrl(cached?.downloadUrl || item.metadata?.access_url)
  }

  // 消息与侧边「文件」资产共用同一套轻量图片预览。
  const handleOpenImage = (clickedUrl: string) => {
    openImImagePreview(message, clickedUrl)
  }

  // `<img>` 无法自动感知 OSS 预签名链接过期；失败时仅换链一次，避免无效文件无限重试。
  const handleImageLoadError = () => {
    if (!message.metadata?.file_id || retriedImageMessageIdRef.current === message.id) {
      markAttachmentUnavailable(message)
      return
    }
    retriedImageMessageIdRef.current = message.id
    void refreshAttachment(message)
  }

  // 与上方 handleOpenImage 一样放在 early-return 之后：勿用 hook，避免条件调用。
  const handleCopyImage = (url: string) => {
    void copyImageToClipboard({
      url,
      fileId: message.metadata?.file_id,
    })
      .then(() => {
        toast({ title: t('copyImageSuccess', { defaultValue: '已复制图片' }) })
      })
      .catch((error) => {
        log.warn('copy image failed', {
          messageId: message.id,
          reason: error instanceof Error ? error.message : String(error),
        })
        toast({
          title: t('copyImageFailed', { defaultValue: '复制图片失败' }),
          variant: 'destructive',
        })
      })
  }

  // 纯文本消息才开右键复制；云文档 / 表格 / Space / 联系人等资源卡与
  // 文件、图片先不开放（资源另有打开链路，复制语义未定）。
  const copyableText = message.content.trim()
  const customCard = message.metadata?.card
  const isRichCardForCopy = isTabTinCustomCardContent(customCard)
  const canCopyText =
    message.message_type === MESSAGE_TYPE_TEXT
    && Boolean(copyableText)
    && !isRichCardForCopy

  const resolveTextToCopy = (): string => {
    const selection = window.getSelection()
    const selected = selection?.toString() ?? ''
    if (!selected || !selection || !textBubbleRef.current) return copyableText
    const anchor = selection.anchorNode
    if (anchor && textBubbleRef.current.contains(anchor)) return selected
    return copyableText
  }

  const handleCopyText = () => {
    const text = resolveTextToCopy()
    if (!text) {
      toast({
        title: t('copyTextFailed', { defaultValue: '复制失败' }),
        variant: 'destructive',
      })
      return
    }
    safeCopyToClipboard(
      text,
      () => toast({ title: t('copyTextSuccess', { defaultValue: '已复制' }) }),
      () => {
        log.warn('copy text failed', { messageId: message.id, length: text.length })
        toast({
          title: t('copyTextFailed', { defaultValue: '复制失败' }),
          variant: 'destructive',
        })
      },
    )
  }

  const handleTextContextMenu = (e: React.MouseEvent) => {
    if (!canCopyText) return
    // 资源链接有独立右键菜单；图片按钮已 stopPropagation
    const target = e.target as HTMLElement | null
    if (target?.closest('a[href]')) return
    e.preventDefault()
    e.stopPropagation()
    setImageContextMenu(null)
    setTextContextMenu({ x: e.clientX, y: e.clientY })
  }

  const stickerMeta = resolveTabtinRobotStickerMetadata(message.metadata)
  const isStickerMessage = stickerMeta != null
  const imageFrame = resolveImImageFrame(message.metadata)

  const renderImageContent = (url: string) => (
    <div className={`flex flex-col gap-2 ${isStickerMessage ? 'max-w-[160px]' : 'max-w-[480px]'}`}>
      <button
        type="button"
        className={cn(
          'w-fit max-w-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          !isStickerMessage && 'relative overflow-hidden bg-muted/20',
        )}
        style={isStickerMessage
          ? undefined
          : {
              width: imageFrame.width,
              aspectRatio: `${imageFrame.width} / ${imageFrame.height}`,
            }}
        onClick={() => handleOpenImage(url)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setTextContextMenu(null)
          setImageContextMenu({ x: e.clientX, y: e.clientY, url })
        }}
        aria-label={
          isStickerMessage
            ? t('openStickerPreview', { defaultValue: '打开贴纸预览' })
            : t('openImagePreview', { defaultValue: '打开图片预览' })
        }
        data-im-sticker={stickerMeta?.id}
      >
        <img
          src={url}
          alt={message.metadata?.file_name || ''}
          className={
            isStickerMessage
              ? 'h-[140px] w-[140px] max-w-full cursor-pointer object-contain'
              : 'absolute inset-0 h-full w-full cursor-pointer rounded-lg object-contain'
          }
          loading="lazy"
          onError={handleImageLoadError}
        />
      </button>
      {message.content && (
        <span className="whitespace-pre-wrap break-words">{message.content}</span>
      )}
      {imageContextMenu?.url === url && (
        <ImImageContextMenu
          x={imageContextMenu.x}
          y={imageContextMenu.y}
          onCopy={() => handleCopyImage(url)}
          onClose={() => setImageContextMenu(null)}
        />
      )}
    </div>
  )

  const rawFileCaption = isFile ? message.content.trim() : ''
  const fileNameForCaption = message.metadata?.file_name || ''
  const fileCaption = rawFileCaption
    && rawFileCaption !== '[文件]'
    && rawFileCaption !== fileNameForCaption
    && rawFileCaption !== `[文件] ${fileNameForCaption}`
    ? rawFileCaption
    : ''

  const renderFileContent = () => {
    const fileName = message.metadata?.file_name || t('unknown')
    const status = fileAttachment?.status ?? 'checking'
    const isUnavailable = status === 'unavailable'
    const isChecking = status === 'checking'
    const canDownload = status === 'available'
    const localPath = fileAttachment?.localPath
    const hasLocalFile = Boolean(localPath)
    const isDownloaded = Boolean(fileAttachment?.downloadedAt || hasLocalFile)
    const openFileContextMenu = fileContextMenu?.path === localPath ? fileContextMenu : null
    // 与侧栏「文件」历史、Agent 对话共用 ChatResourcePreviewModal
    const canPreviewInApp = canDownload && canOpenImFilePreview(message)
    const canActivateCard = canPreviewInApp || hasLocalFile

    const style = getFileTypeStyle(fileName)
    const TypeIcon = isUnavailable ? FileX : style.Icon
    const cardBg = isUnavailable ? 'bg-gray-500 dark:bg-gray-700' : style.bg

    const handleFileCardActivate = () => {
      if (canPreviewInApp) {
        void openImFilePreview(message, t)
        return
      }
      if (hasLocalFile) {
        void handleOpenLocalFile()
      }
    }

    const cardTitle = canPreviewInApp
      ? t('preview', { defaultValue: '预览' })
      : hasLocalFile
        ? t('fileOpenLocal', { defaultValue: '打开文件' })
        : undefined

    return (
      <div className="flex max-w-[180px] flex-col gap-2">
        <div
          role={canActivateCard ? 'button' : undefined}
          tabIndex={canActivateCard ? 0 : undefined}
          aria-label={cardTitle}
          title={cardTitle}
          onClick={canActivateCard ? handleFileCardActivate : undefined}
          onContextMenu={hasLocalFile ? (event) => {
            event.preventDefault()
            event.stopPropagation()
            setImageContextMenu(null)
            setTextContextMenu(null)
            setFileContextMenu({ x: event.clientX, y: event.clientY, path: localPath! })
          } : undefined}
          onKeyDown={canActivateCard ? (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            handleFileCardActivate()
          } : undefined}
          className={`flex h-[200px] w-[180px] max-w-full flex-col justify-between rounded-2xl p-4 text-white ${cardBg} ${
            isUnavailable ? 'opacity-90' : ''
          } ${canActivateCard ? 'cursor-pointer transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70' : ''}`}
        >
          {/* 文件名 + 大小（左上角） */}
          <div className="min-w-0">
            <div className={cn('line-clamp-3 break-words font-semibold leading-snug', IM_MESSAGE_MARKDOWN_TEXT)}>{fileName}</div>
            <div className="mt-1 text-caption text-white/70">
              {isUnavailable
                ? t('fileUnavailable')
                : isChecking
                  ? t('fileChecking')
                  : formatFileSize(message.metadata?.file_size || 0)}
            </div>
          </div>
          {/* 图标（左下角） + 下载 / 文件夹（右下角） */}
          <div className="flex items-end justify-between">
            <TypeIcon className="h-9 w-9 text-white" />
            {hasLocalFile ? (
              <button
                type="button"
                onClick={handleShowLocalFileInFolder}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/20 text-white transition-colors hover:bg-white/30"
                title={t('fileShowInFolder', { defaultValue: '打开文件夹' })}
                aria-label={t('fileShowInFolder', { defaultValue: '打开文件夹' })}
              >
                <FolderOpen className="h-4 w-4" />
              </button>
            ) : canDownload && (
              <button
                type="button"
                disabled={downloadingFile}
                onClick={handleFileDownload}
                className={`flex h-8 w-8 items-center justify-center rounded-lg text-white transition-colors disabled:opacity-70 ${
                  isDownloaded ? 'bg-white/30' : 'bg-white/20 hover:bg-white/30'
                }`}
                title={isDownloaded ? t('fileDownloaded', { defaultValue: '已下载' }) : t('download')}
              >
                {downloadingFile ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : isDownloaded ? (
                  <Check className="h-4 w-4 animate-in fade-in duration-200" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
              </button>
            )}
          </div>
        </div>
        {openFileContextMenu && (
          <ImImageContextMenu
            x={openFileContextMenu.x}
            y={openFileContextMenu.y}
            copyLabel={t('copyFile', { defaultValue: '复制文件' })}
            menuAriaLabel={t('fileMenu', { defaultValue: '文件菜单' })}
            onCopy={() => void handleCopyLocalFile(localPath!)}
            onClose={() => setFileContextMenu(null)}
          />
        )}
        {fileCaption && (
          <span className="whitespace-pre-wrap break-words text-foreground">{fileCaption}</span>
        )}
      </div>
    )
  }

  const resolveDownloadUrl = () => resolveImAttachmentDownloadUrl(message, t)

  const handleFileDownload = async (event: React.MouseEvent) => {
    event.stopPropagation()
    if (downloadingFile || fileAttachment?.status !== 'available' || fileAttachment.downloadedAt) return

    const fileName = message.metadata?.file_name || 'download'
    setDownloadingFile(true)
    try {
      const url = await resolveDownloadUrl()
      if (!url) return
      const result = await downloadImAttachment({ url, fileName, t })
      const status = typeof result === 'string' ? result : result.status
      const savedPath = typeof result === 'object' && result.status === 'saved' ? result.path : undefined
      if (status === 'saved') {
        if (savedPath) {
          markAttachmentDownloaded(message, savedPath)
        } else {
          markAttachmentDownloaded(message)
        }
      }
    } finally {
      setDownloadingFile(false)
    }
  }

  const handleOpenLocalFile = async () => {
    const localPath = fileAttachment?.localPath
    if (!localPath) return
    const openPath = window.tabtin?.openPath
    if (!openPath) {
      toast({
        title: t('fileOpenFailed', { defaultValue: '打开文件失败' }),
        description: t('fileOpenUnsupported', { defaultValue: '当前环境不支持用系统默认应用打开' }),
        variant: 'destructive',
      })
      return
    }
    try {
      const result = await openPath(localPath)
      if (!result?.success) {
        throw new Error(result?.error || 'unknown')
      }
    } catch (err) {
      toast({
        title: t('fileOpenFailed', { defaultValue: '打开文件失败' }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    }
  }

  const handleCopyLocalFile = async (localPath: string) => {
    const writeFile = window.tabtin?.clipboard?.writeFile
    if (!writeFile) {
      toast({
        title: t('copyFileFailed', { defaultValue: '复制文件失败' }),
        variant: 'destructive',
      })
      return
    }
    try {
      const result = await writeFile(localPath)
      if (!result?.success) throw new Error(result?.error || 'clipboard write failed')
      toast({ title: t('copyFileSuccess', { defaultValue: '已复制文件' }) })
    } catch (error) {
      log.warn('copy downloaded file failed', {
        messageId: message.id,
        reason: error instanceof Error ? error.message : String(error),
      })
      toast({
        title: t('copyFileFailed', { defaultValue: '复制文件失败' }),
        variant: 'destructive',
      })
    }
  }

  const handleShowLocalFileInFolder = async (event: React.MouseEvent) => {
    event.stopPropagation()
    const localPath = fileAttachment?.localPath
    if (!localPath) return
    const showItemInFolder = window.tabtin?.showItemInFolder
    const openPath = window.tabtin?.openPath
    try {
      const result = showItemInFolder
        ? await showItemInFolder(localPath)
        : await openPath?.(localPath)
      if (!result?.success) {
        throw new Error(result?.error || 'unknown')
      }
    } catch (err) {
      toast({
        title: t('fileRevealFailed', { defaultValue: '打开文件夹失败' }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    }
  }

  const renderMarkdownContent = () => (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkAutolinkResource]}
      urlTransform={imMarkdownUrlTransform}
      rehypePlugins={rehypePlugins}
      components={messageMarkdownComponents}
    >
      {message.content}
    </ReactMarkdown>
  )

  const renderTextContent = () => (
    <span className="whitespace-pre-wrap">
      {renderRichText(
        message.content,
        mentionedIds,
        (uid) => mentionNames[uid] || uid.slice(0, 8),
        mentionAll,
        conversationCanvas?.scopeKey,
        conversationCanvas?.executionSpaceId,
      )}
    </span>
  )

  const shouldCollapseContent = (
    message.content.length > IM_COLLAPSE_CHAR_THRESHOLD
    && !isImage
    && !isFile
    && !isTabTinCustomCardContent(customCard)
  )
  const collapseMessageKey = resolveIMCollapsibleMessageKey(message)

  const renderContent = () => {
    if (PROJECTS_UI_ENABLED && isAgentUpdateSummary && agentUpdateSessionId) {
      return (
        <div className="flex flex-col gap-2">
          <span className="whitespace-pre-wrap">{message.content}</span>
          <button
            type="button"
            className="w-fit rounded-md bg-accent/10 px-2.5 py-1 text-caption font-medium text-accent hover:bg-accent/15"
            onClick={() => void handleOpenAgentUpdateTask()}
          >
            {t('openAgentTaskThread', { defaultValue: '打开任务线程' })}
          </button>
        </div>
      )
    }

    const imageUrl = isImage ? resolveRenderableAttachmentUrl(message) : ''
    if (isImage && imageUrl) return renderImageContent(imageUrl)

    if (customCard?.type) {
      return (
        <TabTinCustomCardRenderer
          card={customCard}
          message={message}
          conversationId={message.conversation_id}
          messageId={message.id}
          messageRef={typeof message.metadata.message_ref === 'string'
            ? message.metadata.message_ref
            : undefined}
          defaultOrganizationId={conversationOrganizationId}
          isMine={isMine}
          captionContent={hasMarkdown ? renderMarkdownContent() : renderTextContent()}
        />
      )
    }

    const fileUrl = isFile ? sanitizeUrl(message.metadata?.access_url) : ''
    const hasFileAttachment = isFile && (Boolean(fileUrl) || Boolean(message.metadata?.file_id))
    if (hasFileAttachment) return renderFileContent()

    if (hasMarkdown) return renderMarkdownContent()
    return renderTextContent()
  }

  const forwardedFrom = message.metadata?.forwarded_from
  const showForwardedFrom = Boolean(
    forwardedFrom
    && forwardedFrom.original_sender_id
    && forwardedFrom.original_sender_id !== userId,
  )

  // 表情面板 /「更多」菜单都经 portal 挂到气泡外；打开期间要保活操作条，
  // 否则 mouseLeave 会把整条（含触发菜单的「更多」）藏掉，只剩漂浮菜单。
  const showActions = (hovered || emojiPickerOpen || moreMenuOpen)
    && !message._optimistic && !message._failed
  const canCreateAgentTask = Boolean(
    PROJECTS_UI_ENABLED &&
    isTeamSpaceChannel && !isSystem && !message.is_deleted && !message._optimistic && !message._failed,
  )
  // 气泡内容判定：图片 / 文件卡 / 资源卡自带容器样式，不套气泡底色；纯文本与
  // markdown 才包进气泡（参考主窗口对话气泡：rounded-2xl + 主题底色、无边框）。
  // 自己发的靠右、对方靠左；颜色走全局主题 token（accent / muted），随主题方案适配。
  const isCardContent = isTabTinCustomCardContent(customCard)
  const showImageContent = isImage
    && Boolean(resolveRenderableAttachmentUrl(message))
  const showFileCardContent = isFile
    && (Boolean(sanitizeUrl(message.metadata?.access_url)) || Boolean(message.metadata?.file_id))
  // 图片带说明文字时按飞书式「文字 + 图片」合成一条气泡；纯图片仍保留无底卡片。
  const isBubbleContent = (!showImageContent && !showFileCardContent && !isCardContent)
    || (showImageContent && Boolean(message.content))
    || (showFileCardContent && Boolean(fileCaption) && !isCardContent)
  const bubbleClass = isBubbleContent
    ? `w-fit max-w-full rounded-2xl px-3.5 py-2 ${IM_MESSAGE_BUBBLE_TEXT} ${
        isMine
          ? 'bg-foreground/[0.06] dark:bg-foreground/[0.08] rounded-br-md'
          : 'bg-accent/10 rounded-bl-md'
      }`
    : ''

  return (
    <>
      {dateDivider}
      <div
        className={`group relative flex flex-col px-4 ${isGroupStart ? 'mt-1.5' : 'mt-0.5'} ${
          isHighlighted
            ? 'bg-foreground/[0.045] py-2 dark:bg-foreground/[0.06]'
            : ''
        } ${isMine ? 'items-end' : 'items-start'}`}
      >
        <div
          data-im-message-row
          className={`flex gap-2.5 ${isMine ? 'flex-row-reverse' : 'flex-row'}`}
          style={{
            maxWidth: `min(85%, max(${IM_MESSAGE_ROW_MIN_WIDTH}px, calc(100% - ${IM_MESSAGE_ACTION_RAIL_WIDTH}px)))`,
          }}
        >
          {/* 头像槽：仅接收方显示；组内连续消息留白对齐（自己发的不占头像位） */}
          {!isMine && (
            <div className="w-9 flex-shrink-0 pt-0.5">
              {isGroupStart && (canOpenSenderDM ? (
                <button
                  type="button"
                  onClick={openSenderDM}
                  className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={t('messageMember', { name: senderName || message.sender_id, defaultValue: `向 ${senderName || message.sender_id} 发消息` })}
                >
                  <ColorAvatar
                    name={senderName || message.sender_id || '?'}
                    seed={message.sender_id}
                    imageUrl={senderAvatar}
                    className="h-9 w-9"
                  />
                </button>
              ) : (
                <ColorAvatar
                  name={senderName || message.sender_id || '?'}
                  seed={message.sender_id}
                  imageUrl={senderAvatar}
                  fallbackIcon={isAgent ? <Bot className="h-5 w-5 text-white" /> : undefined}
                  isAgent={isAgent}
                  className="h-9 w-9"
                />
              ))}
            </div>
          )}

          <div className={`relative flex min-w-0 flex-col ${isMine ? 'items-end' : 'items-start'}`}>
            {/* 群聊显示发送者名（次级字体）；私聊不显示。仅组首。 */}
            {!isDM && !isMine && isGroupStart && (
              <div className="mb-0.5 flex max-w-full items-center gap-1.5 px-1">
                {canOpenSenderDM ? (
                  <button
                    type="button"
                    onClick={openSenderDM}
                    className="truncate text-caption text-muted-foreground/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t('messageMember', { name: senderName || message.sender_id, defaultValue: `向 ${senderName || message.sender_id} 发消息` })}
                  >
                    {senderName || message.sender_id?.slice(0, 8)}
                  </button>
                ) : (
                  <span className="truncate text-caption text-muted-foreground/80">
                    {senderName || message.sender_id?.slice(0, 8)}
                  </span>
                )}
                {isAgent && <AgentMemberBadges ownerName={agentOwnerName} />}
              </div>
            )}

            {/* 转发来源标识（TC-12：自己转发自己的消息不显示来源） */}
            {showForwardedFrom && forwardedFrom && (
              <div className="mb-0.5 flex items-center gap-1 px-1 text-caption text-muted-foreground">
                <Share2 className="h-2.5 w-2.5" />
                <span>{t('forwardedFrom', { name: forwardedFrom.original_sender_name || t('unknown') })}</span>
              </div>
            )}

            {/* 引用点击后在右侧只读查看原消息与已加载回复，不再跳走主消息流。 */}
            {replyPreview && (
              <button
                type="button"
                onClick={() => onOpenReplyThread?.(message)}
                className="mb-1 flex max-w-full items-center rounded px-1 text-left text-caption text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="查看回复详情"
              >
                <div className="mr-1.5 h-4 w-0.5 flex-shrink-0 rounded-full bg-border" />
                <div className="flex min-w-0 items-center gap-1 truncate">
                  <span className="flex-shrink-0">{t('reply', { defaultValue: '回复' })}</span>
                  <span className="font-medium" style={{ color: getNameColor(replyPreview.sender_id) }}>
                    {replySenderName}:
                  </span>
                  <span className="truncate">{replyPreviewContent}</span>
                </div>
              </button>
            )}
            {replyCount > 0 && (
              <button
                type="button"
                onClick={() => onOpenReplyThread?.(message)}
                className="mb-1 flex items-center gap-1 px-1 text-caption text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                {replyCount} 条回复
              </button>
            )}

            <div
              className="relative max-w-full"
              data-im-message-action-trigger
              onMouseEnter={showActionBar}
              onMouseLeave={scheduleHideActionBar}
            >
              {(isSendingMessage || hasReadStatus) && (
                <span data-im-read-receipt-anchor className={IM_READ_RECEIPT_ANCHOR_CLASS}>
                {isSendingMessage ? (
                  <span
                    role="status"
                    aria-label={t('sending')}
                    className="group/read inline-flex h-4 w-4 items-end justify-center"
                  >
                    <span className={IM_UNREAD_RECEIPT_DOT_CLASS} aria-hidden="true" />
                    <span
                      role="tooltip"
                      className={`pointer-events-none absolute bottom-full right-0 z-tooltip mb-1 whitespace-nowrap rounded-md px-2 py-1 text-caption text-popover-foreground opacity-0 shadow-md transition-opacity group-hover/read:opacity-100 ${OVERLAY_SURFACE_CLASS}`}
                    >
                      {t('sending')}
                    </span>
                  </span>
                ) : (
                  <button
                    ref={readReceiptTriggerRef}
                    type="button"
                  onMouseEnter={() => void loadReadReceiptDetail()}
                  onClick={() => {
                    if (!isDM) {
                      if (!isReadReceiptOpen) void loadReadReceiptDetail(true)
                      if (!isReadReceiptOpen) positionReadReceiptDetail()
                      setIsReadReceiptOpen((open) => !open)
                    }
                  }}
                  className="group/read inline-flex h-4 w-4 items-end justify-center"
                  aria-label={isDM
                    ? isRead ? t('read') : t('notRead')
                    : t('readReceiptSummary', { read: groupReadCount, unread: groupUnreadCount })}
                  aria-expanded={!isDM ? isReadReceiptOpen : undefined}
                  aria-controls={!isDM ? `read-receipt-detail-${message.id}` : undefined}
                >
                  {isDM ? (
                    isRead ? (
                      <CheckCircle2 className={IM_READ_RECEIPT_MARK_CLASS} aria-hidden="true" />
                    ) : (
                      <span className={IM_UNREAD_RECEIPT_DOT_CLASS} aria-hidden="true" />
                    )
                  ) : isGroupReadComplete ? (
                    <CheckCircle2 className={IM_READ_RECEIPT_MARK_CLASS} aria-hidden="true" />
                  ) : (
                    <span
                      className={IM_GROUP_READ_PROGRESS_DOT_CLASS}
                      style={{
                        background: `conic-gradient(#10b981 ${groupReadProgress * 360}deg, transparent 0deg)`,
                      }}
                      aria-hidden="true"
                    />
                  )}
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute bottom-full right-0 z-tooltip mb-1 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-caption text-popover-foreground opacity-0 shadow-md transition-opacity group-hover/read:opacity-100"
                  >
                    {isDM
                      ? isRead ? t('read') : t('notRead')
                      : t('readReceiptSummary', { read: groupReadCount, unread: groupUnreadCount })}
                  </span>
                  </button>
                )}
                  {typeof document !== 'undefined'
                    && !isDM
                    && isReadReceiptOpen
                    && visibleReadReceiptDetail
                    && readReceiptPosition
                    && createPortal(
                      <div
                        ref={readReceiptDetailRef}
                        id={`read-receipt-detail-${message.id}`}
                        data-im-read-receipt-detail
                        data-placement={readReceiptPosition.placement}
                        role="region"
                        aria-label={t('readReceiptSummary', {
                          read: groupReadCount,
                          unread: groupUnreadCount,
                        })}
                        className={`fixed z-dropdown grid max-h-80 w-80 grid-cols-2 overflow-y-auto rounded-lg border border-border/40 text-left text-foreground ${OVERLAY_SURFACE_CLASS}`}
                        style={{
                          top: readReceiptPosition.top,
                          bottom: readReceiptPosition.bottom,
                          left: readReceiptPosition.left,
                        }}
                      >
                        {([
                          ['readers', t('read'), visibleReadReceiptDetail.readers, groupReadCount],
                          ['unreaders', t('notRead'), visibleReadReceiptDetail.unreaders, groupUnreadCount],
                        ] as const).map(([key, label, members, count]) => (
                          <div key={key} className="min-h-24 p-3 first:border-r first:border-border/60">
                            <div className={cn('mb-2 font-medium', IM_MESSAGE_MARKDOWN_TEXT)}>{count} {label}</div>
                            {members.map((member) => {
                              const presentation = resolveReadReceiptMemberPresentation(
                                member,
                                userProfiles?.[member.user_id],
                              )
                              return (
                                <div key={member.user_id} className={cn('flex items-center gap-2 py-1', IM_MESSAGE_MARKDOWN_TEXT)}>
                                  <ColorAvatar name={presentation.name} seed={member.user_id} imageUrl={presentation.avatar} className="h-6 w-6" />
                                  <span className="truncate">{presentation.name}</span>
                                </div>
                              )
                            })}
                          </div>
                        ))}
                      </div>,
                      document.body,
                    )}
                </span>
              )}
              {!isSystem && (
                <IMMessageActionBar
                  visible={showActions}
                  isMine={isMine}
                  messageRef={typeof message.metadata.message_ref === 'string' ? message.metadata.message_ref : ''}
                  messageSequence={reactionSequence}
                  conversationId={message.conversation_id}
                  reactions={message.reactions ?? {}}
                  isPinned={Boolean(message.is_pinned)}
                  canReply={Boolean(onReply)}
                  // handoff / session_share 的展示面与授权范围绑定在原会话，禁止转发扩散
                  canForward={Boolean(
                    !message.is_deleted
                    && canForwardTabTinCustomCard(customCard),
                  )}
                  canPin={canPin}
                  canEdit={canEdit}
                  canRecall={canRecall}
                  canCreateAgentTask={canCreateAgentTask}
                  pinning={pinning}
                  recalling={recalling}
                  creatingAgentTask={creatingAgentTask}
                  emojiPickerOpen={emojiPickerOpen}
                  onEmojiPickerOpenChange={setEmojiPickerOpen}
                  moreMenuOpen={moreMenuOpen}
                  onMoreMenuOpenChange={handleMoreMenuOpenChange}
                  onQuickReaction={handleQuickReaction}
                  onReply={onReply ? () => onReply(message) : undefined}
                  onForward={() => setForwardDialogOpen(true)}
                  onEdit={canEdit ? () => onEdit?.(message) : undefined}
                  onTogglePin={handleTogglePin}
                  onRecall={handleRecall}
                  onCreateAgentTask={() => setAgentTaskDialogOpen(true)}
                />
              )}

              {/* 气泡正文 */}
              <div
                ref={textBubbleRef}
                data-im-message-bubble
                className={`${bubbleClass} ${message._failed ? 'opacity-40' : ''}`}
                onContextMenu={handleTextContextMenu}
              >
                <IMCollapsibleContent
                  // Virtuoso 会复用行组件；消息身份或折叠策略变化时重挂载，不能让
                  // 上一行的展开 state 泄漏到新消息、意外解析一整条长 Markdown。
                  key={`${collapseMessageKey}:${shouldCollapseContent ? 'collapsed' : 'full'}`}
                  messageKey={collapseMessageKey}
                  content={message.content}
                  shouldCollapse={shouldCollapseContent}
                >
                  {() => (
                    <MessageContentBoundary resetKey={message.id}>{renderContent()}</MessageContentBoundary>
                  )}
                </IMCollapsibleContent>
                {message.edited_at && !message.is_deleted && !isSystemManagedTabTinCard(customCard) && (
                  <span className="ml-1 align-baseline text-caption text-muted-foreground/60 select-none">
                    {t('edited')}
                  </span>
                )}
                {message.reactions && Object.keys(message.reactions).length > 0 && (
                  <EmojiReactionBar
                    reactions={message.reactions}
                    reactionCounts={message.reaction_counts}
                    messageRef={typeof message.metadata.message_ref === 'string' ? message.metadata.message_ref : ''}
                    messageSequence={reactionSequence}
                    conversationId={message.conversation_id}
                  />
                )}
                {textContextMenu && (
                  <ImImageContextMenu
                    x={textContextMenu.x}
                    y={textContextMenu.y}
                    copyLabel={t('copyText', { defaultValue: '复制' })}
                    menuAriaLabel={t('textMenu', { defaultValue: '消息菜单' })}
                    onCopy={handleCopyText}
                    onClose={() => setTextContextMenu(null)}
                  />
                )}
              </div>
            </div>

            {!message._optimistic && !message._failed && (
              <div className={`mt-0.5 px-1 text-caption text-muted-foreground/60 tabular-nums select-none opacity-0 transition-opacity group-hover:opacity-100 ${
                isMine ? 'text-right' : 'text-left'
              }`}>
                {formatMessageClock(message.created_at)}
              </div>
            )}

            {message._failed && (
              <div className="mt-0.5 flex items-center gap-2 px-1 text-caption text-destructive">
                <span>{t('sendFailedRetryHint', { defaultValue: '发送失败，请检查网络后重试。' })}</span>
                {onRetryFailed && (
                  <button
                    type="button"
                    className="font-medium underline underline-offset-2 hover:text-destructive/80 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={message._retrying}
                    onClick={() => onRetryFailed(message)}
                  >
                    {message._retrying
                      ? t('retryingSend', { defaultValue: '重试中…' })
                      : t('retrySend', { defaultValue: '重试' })}
                  </button>
                )}
              </div>
            )}

          </div>
        </div>
      </div>

      {/* 转发弹窗 */}
      <ForwardDialog
        isOpen={forwardDialogOpen}
        onClose={() => setForwardDialogOpen(false)}
        message={message}
      />
      <TeamSpaceCreateTaskDialog
        isOpen={agentTaskDialogOpen}
        isSubmitting={creatingAgentTask}
        sourcePreview={message.content}
        onClose={() => setAgentTaskDialogOpen(false)}
        onConfirm={handleCreateAgentTask}
      />
    </>
  )
})

/**
 * 轻量 Markdown 组件映射，避免破坏气泡内布局。
 * 只覆写需要样式的元素，其余用默认渲染。
 */
export { markdownComponents } from './imMarkdownComponents'

interface BoundaryProps { children: React.ReactNode; resetKey?: string | number }
class MessageContentBoundary extends React.Component<BoundaryProps, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(err: unknown) { console.error('[TabChat] message render error:', err) }
  componentDidUpdate(prevProps: BoundaryProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false })
    }
  }
  render() {
    if (this.state.hasError) {
      return <span className="text-caption text-muted-foreground italic">[渲染失败]</span>
    }
    return this.props.children
  }
}

/**
 * 高亮 @mention — 基于 mentioned_user_ids 精确匹配；mention_all 时额外高亮 @所有人/@Everyone。
 *
 * 将 user ID 通过 getDisplayName 映射为显示名，构建精确正则；
 * 长名称优先匹配避免子串误中；profile 未加载时回退到 ID 前缀匹配。
 */
function highlightMentions(
  text: string,
  mentionedIds: string[],
  getDisplayName: (id: string) => string,
  mentionAll = false,
): React.ReactNode {
  if (!mentionedIds.length && !mentionAll) return text

  const matchNames = new Set<string>()
  for (const uid of mentionedIds) {
    const dn = getDisplayName(uid)
    if (dn && dn !== uid.slice(0, 8)) {
      matchNames.add(dn)
    } else {
      matchNames.add(uid.slice(0, 8))
    }
  }
  if (mentionAll) {
    for (const alias of MENTION_ALL_ALIASES) {
      matchNames.add(alias)
    }
  }

  const escaped = [...matchNames]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!escaped.length) return text

  const pattern = new RegExp(`(@(?:${escaped.join('|')}))(?=[\\s,;.!?，。！？、；：]|$)`, 'g')
  const result: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push(<React.Fragment key={lastIndex}>{text.slice(lastIndex, match.index)}</React.Fragment>)
    }
    result.push(
      <span key={match.index} className="rounded px-1 text-info font-medium bg-info/15">
        {match[0]}
      </span>,
    )
    lastIndex = match.index + match[0].length
  }

  if (lastIndex === 0) return text
  if (lastIndex < text.length) {
    result.push(<React.Fragment key={lastIndex}>{text.slice(lastIndex)}</React.Fragment>)
  }
  return result
}

/**
 * 纯文本路径富渲染：先按裸 URL 切分为「链接 / 文本」段，文本段再做 @mention 高亮。
 * 链接点击/右键复用 ResourceRouter helper（与 markdown 路径 a 组件同款，含外链兜底）。
 * markdown 路径不走这里——那条由 GFM autolink + markdownComponents 处理。
 */
function renderRichText(
  text: string,
  mentionedIds: string[],
  getDisplayName: (id: string) => string,
  mentionAll = false,
  tabScopeKey?: string | null,
  executionSpaceId?: string | null,
): React.ReactNode {
  if (!text) return text
  const nodes: React.ReactNode[] = []
  let key = 0
  let lastIndex = 0
  let match: RegExpExecArray | null
  URL_RE.lastIndex = 0

  const pushText = (segment: string) => {
    if (!segment) return
    nodes.push(
      <React.Fragment key={`t${key++}`}>
        {highlightMentions(segment, mentionedIds, getDisplayName, mentionAll)}
      </React.Fragment>,
    )
  }

  while ((match = URL_RE.exec(text)) !== null) {
    const raw = match[0]
    const trailing = raw.match(URL_TRAILING_RE)?.[0] ?? ''
    const linkText = trailing ? raw.slice(0, raw.length - trailing.length) : raw
    if (!linkText) continue
    pushText(text.slice(lastIndex, match.index))
    const href = linkText.startsWith('www.') ? `https://${linkText}` : linkText
    nodes.push(
      <a
        key={`u${key++}`}
        href={href}
        onClick={(e) => handleResourceLinkClick(e, href, tabScopeKey, executionSpaceId)}
        onContextMenu={(e) => handleResourceLinkContextMenu(e, href, tabScopeKey, executionSpaceId)}
        className="text-info underline underline-offset-2 break-all"
      >
        {linkText}
      </a>,
    )
    if (trailing) pushText(trailing)
    lastIndex = match.index + raw.length
  }

  if (nodes.length === 0) return highlightMentions(text, mentionedIds, getDisplayName, mentionAll)
  pushText(text.slice(lastIndex))
  return nodes
}
