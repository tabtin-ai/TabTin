/**
 * IMMessageInput — 输入框（文件选择 / 拖拽 / 粘贴图片 / Enter 发送 / Shift+Enter 换行 / 回复预览栏）
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  X, Paperclip, Loader2, FileSymlink, IdCard, Send, Code, FileText, Table2,
  SquareTerminal, Share2,
} from 'lucide-react'
import { toast } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import { useIMStore } from '@stores/useIMStore'
import { useUserProfile, useUserProfileCache } from '@stores/useUserProfileCache'
import { SIDEBAR_ICON_INACTIVE } from '@components/layout/sidebarUi'
import {
  COMPOSER_TOOLBAR_BUTTON,
  COMPOSER_TOOLBAR_ICON_CLASS,
  COMPOSER_TOOLBAR_ICON_STROKE,
} from '@components/chat/registry/chatDesignTokens'
import {
  IM_COMPOSER_GLYPH_ICON,
  IM_COMPOSER_PILL_MIN_HEIGHT,
  IM_COMPOSER_SHELL_CLASS,
  IM_COMPOSER_TEXT,
  IM_COMPOSER_TEXTAREA_MIN_HEIGHT,
} from './tabchatUi'
import {
  ImComposerAddIcon,
  ImComposerBoldIcon,
  ImComposerBulletListIcon,
  ImComposerCloseAddIcon,
  ImComposerEmojiIcon,
  ImComposerFormatIcon,
  ImComposerHeadingIcon,
  ImComposerItalicIcon,
  ImComposerLinkIcon,
  ImComposerOrderedListIcon,
  ImComposerQuoteIcon,
} from './imComposerIcons'
import { IMResourcePickerDialog } from './IMResourcePickerDialog'
import { resolveResourcePickerOrganizationId } from './imResourcePickerData'
import { ContactPickerDialog } from './ContactPickerDialog'
import { PromptComposeDialog } from './PromptComposeDialog'
import { SessionSharePickerDialog } from './SessionSharePickerDialog'
import { CodexSessionShareDialog } from './CodexSessionShareDialog'
import { OpenAIIcon } from './OpenAIIcon'
import { isCodexSessionShareAvailable } from './codexSessionShareAvailability'
import { EmojiPanel } from './EmojiPanel'
import {
  TABTIN_ROBOT_PACK_ID,
  type TabtinRobotSticker,
} from './stickers/tabtinRobotPack'
import { stickerSrcToFile } from './stickers/stickerSrcToFile'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import {
  buildResourceCardMetadata,
  formatResourceCardContent,
  type ImResourceCardRef,
} from '@/lib/imResourceCard'
import {
  uploadIMAttachment,
  isImageFile,
  validateFile,
} from '@/services/tabchatAttachmentApi'
import {
  UPLOAD_PRESETS,
  buildAttachmentPickerAccept,
  formatFileSize,
  isMediaMime,
} from '@/constants/upload'
import {
  listExternalContacts,
  type IMMessage,
  type ConversationMember,
  type SearchMemberResult,
} from '@/services/tabchatApi'
import { MentionSelector, type MentionSelectorRef, type MentionTarget } from './MentionSelector'
import { ImMentionComposer, type ImMentionComposerHandle } from './ImMentionComposer'
import { findComposerMentionTrigger, formatMentionMarkdown, textHasMentionTarget } from './mentionMarkdown'
import { resolveMentionsFromText } from './resolveMentionsFromText'
import { MESSAGE_TYPE_IMAGE, MESSAGE_TYPE_FILE, MESSAGE_TYPE_TEXT, CONVERSATION_TYPE_DM } from '@/constants/tabchat'
import { AttachmentPreview } from '@components/chat/composer/AttachmentPreview'
import type { ChatAttachment } from '@components/chat/types'
import { createLogger } from '@/utils/logger'
import {
  resolveFloatingMenuLayout,
  type FloatingMenuLayout,
} from '@components/chat/panel/floatingMenuLayout'
import {
  getIMMessageContentByteLength,
  IM_MESSAGE_CONTENT_MAX_BYTES,
  isIMMessageContentWithinLimit,
} from './imMessageContent'

const log = createLogger('IMMessageInput')

const IM_ATTACH_MENU_WIDTH = 240
const IM_ATTACH_MENU_MIN_HEIGHT = 168
const IM_EMOJI_PANEL_WIDTH = 420
const IM_EMOJI_PANEL_MIN_HEIGHT = 320

const MAX_PENDING_ATTACHMENTS = 9

/**
 * 飞书风输入井：外层不透明卡片（两侧留暗底），内层只做横向排布与垂直居中。
 * 避免半透明 pill 与消息叠影，也避免整条底栏铺满实色。
 *
 * 不能加 overflow-hidden：加号菜单 / 表情面板用 absolute bottom-14 向上弹出，
 * 会被裁成「完全看不见」。圆角靠 rounded-xl + inset ring 即可。
 */
const IM_COMPOSER_SURFACE =
  'rounded-xl bg-background ring-1 ring-inset ring-border/60 shadow-sm'

const IM_COMPOSER_PILL = cn(
  'flex min-w-0 items-center gap-1 px-1.5 py-1.5',
  IM_COMPOSER_PILL_MIN_HEIGHT,
)

interface PendingAttachment {
  id: string
  file: File
  isImage: boolean
  previewUrl?: string
}

/** IM 待发 → Agent Composer 的 ChatAttachment，直接复用 AttachmentPreview。 */
function toComposerAttachment(pending: PendingAttachment): ChatAttachment {
  return {
    id: pending.id,
    file: pending.file,
    filename: pending.file.name,
    mimeType: pending.file.type,
    size: pending.file.size,
    type: pending.isImage ? 'image' : 'file',
    status: 'pending',
    previewUrl: pending.previewUrl,
  }
}

interface Props {
  conversationId: string
  onSend: (content: string, replyTo?: IMMessage, messageType?: number, metadata?: Record<string, unknown>) => void
  isSending: boolean
  replyTo?: IMMessage | null
  replyToName?: string
  onCancelReply?: () => void
  members?: ConversationMember[]
  /** 共享成员快照完成首轮加载后，DM 可据此判断对端是否仍可交互。 */
  membersLoaded?: boolean
  /** 群聊开启：@ 选择器提供「所有人」 */
  allowMentionAll?: boolean
  /** 受控草稿：token 变化时把 text 覆写进输入框（撤回后「重新编辑」回填） */
  draft?: { text: string; token: number } | null
  /** 编辑态（功能4）：非空时输入框进入编辑模式，发送走 onSubmitEdit */
  editingMessage?: IMMessage | null
  onSubmitEdit?: (message: IMMessage, content: string, metadata?: Record<string, unknown>) => void
  onCancelEdit?: () => void
  /** 外部会话仅允许文本、回复和普通表情。 */
  allowRichContent?: boolean
}

export const IMMessageInput: React.FC<Props> = ({
  conversationId,
  onSend,
  isSending,
  replyTo,
  replyToName,
  onCancelReply,
  members,
  membersLoaded = false,
  allowMentionAll = false,
  draft,
  editingMessage,
  onSubmitEdit,
  onCancelEdit,
  allowRichContent = true,
}) => {
  const { t } = useTranslation('tabchat')
  // 资源卡发送入口①（TC-5/TC-17）：按 IM 会话所属 organization 取资源，
  // Conversation.space_id 已不再作为 picker anchor。
  const conversation = useIMStore(
    (s) => s.conversations.find((c) => c.id === conversationId),
  )
  const conversationOrganizationId = useIMStore(
    (s) => resolveResourcePickerOrganizationId(s.conversations, conversationId),
  )
  const updateConversation = useIMStore((s) => s.updateConversation)
  const canShareCodexSession = isCodexSessionShareAvailable(conversationOrganizationId)
  const isDMConversation = conversation?.type === CONVERSATION_TYPE_DM
  const dmPeerUserId = isDMConversation ? (conversation?.dm_peer_user_id ?? null) : null
  const dmPeerOrganizationId = conversation?.dm_peer_organization_id ?? null
  // 同一自然人在不同外部组织下是两段独立关系，缓存键必须带上对端 organization。
  const externalContactKey = conversation?.is_external
    && conversationOrganizationId
    && dmPeerUserId
    ? `${conversationOrganizationId}:${dmPeerOrganizationId ?? ''}:${dmPeerUserId}`
    : null
  const [externalContactAccess, setExternalContactAccess] = useState<{
    key: string
    active: boolean
  } | null>(null)
  const currentExternalContactAccess = externalContactAccess?.key === externalContactKey
    ? externalContactAccess.active
    : null
  const isUnavailableExternalContact = Boolean(
    externalContactKey && (
      (conversation?.external_contact_relationship !== undefined
        && conversation.external_contact_relationship !== 'friend')
      || currentExternalContactAccess !== true
    ),
  )
  useEffect(() => {
    if (!externalContactKey || !conversationOrganizationId || !dmPeerUserId) return
    let cancelled = false
    void listExternalContacts(conversationOrganizationId)
      .then(({ items }) => {
        if (cancelled) return
        const relationship = items.find(
          (contact) => (
            contact.peer_user_id === dmPeerUserId
            && contact.peer_organization_id === conversation?.dm_peer_organization_id
          ),
        )?.relationship
        const active = relationship === 'friend'
        setExternalContactAccess({
          key: externalContactKey,
          active,
        })
        if (relationship) {
          updateConversation(conversationId, {
            external_contact_relationship: relationship,
          })
        }
      })
      .catch((error) => {
        log.warn('Failed to verify external contact access', {
          conversationId,
          organizationId: conversationOrganizationId,
          peerUserId: dmPeerUserId,
          error,
        })
        if (!cancelled) {
          setExternalContactAccess({ key: externalContactKey, active: false })
        }
      })
    return () => { cancelled = true }
  }, [
    conversation?.dm_peer_organization_id,
    conversationId,
    conversationOrganizationId,
    dmPeerUserId,
    externalContactKey,
    updateConversation,
  ])
  const isRemovedDmPeer = Boolean(
    isDMConversation
    && dmPeerUserId
    && membersLoaded
    && !members?.some((member) => member.user_id === dmPeerUserId),
  )
  const dmPeerProfile = useUserProfile(dmPeerUserId)
  const ensureProfiles = useUserProfileCache((s) => s.ensureProfiles)
  useEffect(() => {
    if (dmPeerUserId) ensureProfiles([dmPeerUserId])
  }, [dmPeerUserId, ensureProfiles])
  const [showResourcePicker, setShowResourcePicker] = useState(false)
  const [showContactPicker, setShowContactPicker] = useState(false)
  const [showPromptCompose, setShowPromptCompose] = useState(false)
  const [showSessionSharePicker, setShowSessionSharePicker] = useState(false)
  const [showCodexSessionShare, setShowCodexSessionShare] = useState(false)
  const [showEmojiPanel, setShowEmojiPanel] = useState(false)
  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const [showFormatToolbar, setShowFormatToolbar] = useState(false)
  const [text, setText] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [isSendingSticker, setIsSendingSticker] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [pendingResource, setPendingResource] = useState<ImResourceCardRef | null>(null)
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composerHandleRef = useRef<ImMentionComposerHandle>(null)
  const applyComposerCaret = useCallback((start: number, end = start) => {
    const el = textareaRef.current
    if (el) {
      el.selectionStart = start
      el.selectionEnd = end
    }
    composerHandleRef.current?.restoreCaretFromTextarea()
    composerHandleRef.current?.syncHeight()
    composerHandleRef.current?.focus()
  }, [])
  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => composerHandleRef.current?.focus())
  }, [])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachMenuAnchorRef = useRef<HTMLButtonElement>(null)
  const attachMenuRef = useRef<HTMLDivElement>(null)
  const emojiPanelAnchorRef = useRef<HTMLButtonElement>(null)
  const emojiPanelRef = useRef<HTMLDivElement>(null)
  const [attachMenuLayout, setAttachMenuLayout] = useState<FloatingMenuLayout>({
    width: IM_ATTACH_MENU_WIDTH,
    height: IM_ATTACH_MENU_MIN_HEIGHT,
    left: 16,
    placement: 'up',
    bottom: 16,
  })
  const [emojiPanelLayout, setEmojiPanelLayout] = useState<FloatingMenuLayout>({
    width: IM_EMOJI_PANEL_WIDTH,
    height: IM_EMOJI_PANEL_MIN_HEIGHT,
    left: 16,
    placement: 'up',
    bottom: 16,
  })
  const dragCounterRef = useRef(0)
  const mountedRef = useRef(true)
  const hasConversationAccessRef = useRef(
    Boolean(conversation) && !isRemovedDmPeer && !isUnavailableExternalContact,
  )
  hasConversationAccessRef.current = Boolean(conversation)
    && !isRemovedDmPeer
    && !isUnavailableExternalContact
  const onSendRef = useRef(onSend)
  onSendRef.current = (...args) => {
    if (hasConversationAccessRef.current) onSend(...args)
  }

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments
  }, [pendingAttachments])

  useEffect(() => {
    // mount 时必须设回 true：StrictMode（dev）会「挂载→cleanup→再挂载」，
    // 若只在 cleanup 设 false，mountedRef 会被永久卡死 false，导致上传 finally
    // 里的 setIsUploading(false) 永不执行 → 上传指示器一直转。
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      pendingAttachmentsRef.current.forEach((attachment) => {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
      })
    }
  }, [])

  const [mentionState, setMentionState] = useState<{
    isOpen: boolean
    query: string
    startIndex: number
  } | null>(null)
  const [mentions, setMentions] = useState<MentionTarget[]>([])
  const mentionSelectorRef = useRef<MentionSelectorRef>(null)

  useEffect(() => {
    focusComposer()
  }, [focusComposer])

  useEffect(() => {
    if (replyTo) {
      focusComposer()
    }
  }, [focusComposer, replyTo])

  // 受控草稿注入（撤回后「重新编辑」）：token 变化时把原文覆写进输入框、聚焦、光标移到末尾。
  const lastDraftTokenRef = useRef<number | null>(null)
  useEffect(() => {
    if (!draft || draft.token === lastDraftTokenRef.current) return
    lastDraftTokenRef.current = draft.token
    setText(draft.text)
    requestAnimationFrame(() => {
      applyComposerCaret(draft.text.length)
    })
  }, [applyComposerCaret, draft])

  // 进入编辑态时，把原文塞回输入框、聚焦、光标移到末尾（按 message id 触发一次）。
  const editingIdRef = useRef<number | null>(null)
  useEffect(() => {
    if (!editingMessage) {
      editingIdRef.current = null
      return
    }
    if (editingMessage.id === editingIdRef.current) return
    editingIdRef.current = editingMessage.id
    setText(editingMessage.content)
    requestAnimationFrame(() => {
      applyComposerCaret(editingMessage.content.length)
    })
  }, [applyComposerCaret, editingMessage])

  const processFiles = useCallback(
    (files: File[]) => {
      if (!allowRichContent || files.length === 0 || isUploading) return

      const accepted: PendingAttachment[] = []
      for (const file of files) {
        const isImage = isImageFile(file)
        const validation = validateFile(file)
        if (!validation.valid) {
          if (validation.reason === 'fileTypeNotAllowed') {
            toast({
              title: t('fileTypeNotSupported'),
              description: file.name,
              variant: 'destructive',
            })
          } else {
            const preset = isImage
              ? UPLOAD_PRESETS.IMAGE
              : isMediaMime(file.type)
                ? UPLOAD_PRESETS.MEDIA
                : UPLOAD_PRESETS.FILE
            toast({
              title: t(isImage ? 'imageTooLarge' : 'fileTooLarge', {
                maxSize: formatFileSize(preset.maxSize),
              }),
              description: `${file.name} (${formatFileSize(file.size)})`,
              variant: 'destructive',
            })
          }
          continue
        }

        accepted.push({
          id: crypto.randomUUID(),
          file,
          isImage,
          previewUrl: isImage ? URL.createObjectURL(file) : undefined,
        })
      }

      setPendingAttachments((current) => {
        const available = Math.max(0, MAX_PENDING_ATTACHMENTS - current.length)
        const next = accepted.slice(0, available)
        accepted.slice(available).forEach((attachment) => {
          if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
        })
        return [...current, ...next]
      })
    },
    [allowRichContent, isUploading, t],
  )

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id)
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      return current.filter((attachment) => attachment.id !== id)
    })
  }, [])

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const updateAttachMenuLayout = useCallback(() => {
    setAttachMenuLayout(resolveFloatingMenuLayout({
      trigger: attachMenuAnchorRef.current,
      maxWidth: IM_ATTACH_MENU_WIDTH,
      minHeight: IM_ATTACH_MENU_MIN_HEIGHT,
      contentHeight: attachMenuRef.current?.scrollHeight ?? 0,
    }))
  }, [])

  const updateEmojiPanelLayout = useCallback(() => {
    setEmojiPanelLayout(resolveFloatingMenuLayout({
      trigger: emojiPanelAnchorRef.current,
      maxWidth: IM_EMOJI_PANEL_WIDTH,
      minHeight: IM_EMOJI_PANEL_MIN_HEIGHT,
      contentHeight: emojiPanelRef.current?.scrollHeight ?? 0,
    }))
  }, [])

  useEffect(() => {
    if (!showAttachMenu) return
    const rafId = requestAnimationFrame(updateAttachMenuLayout)
    return () => cancelAnimationFrame(rafId)
  }, [showAttachMenu, updateAttachMenuLayout])

  useEffect(() => {
    if (!showEmojiPanel) return
    const rafId = requestAnimationFrame(updateEmojiPanelLayout)
    return () => cancelAnimationFrame(rafId)
  }, [showEmojiPanel, updateEmojiPanelLayout])

  useEffect(() => {
    if (!showAttachMenu && !showEmojiPanel) return
    const handleViewportChange = () => {
      if (showAttachMenu) updateAttachMenuLayout()
      if (showEmojiPanel) updateEmojiPanelLayout()
    }
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [showAttachMenu, showEmojiPanel, updateAttachMenuLayout, updateEmojiPanelLayout])

  const handleOpenAttachMenu = useCallback(() => {
    setShowEmojiPanel(false)
    setShowAttachMenu((open) => {
      if (open) return false
      updateAttachMenuLayout()
      return true
    })
  }, [updateAttachMenuLayout])

  const handleToggleEmojiPanel = useCallback(() => {
    setShowAttachMenu(false)
    setShowFormatToolbar(false)
    setShowEmojiPanel((open) => {
      if (open) return false
      updateEmojiPanelLayout()
      return true
    })
  }, [updateEmojiPanelLayout])

  const handleAttachLocalFile = useCallback(() => {
    setShowAttachMenu(false)
    handleFileSelect()
  }, [handleFileSelect])

  const handleAttachCloudFile = useCallback(() => {
    setShowAttachMenu(false)
    setShowResourcePicker(true)
  }, [])

  const handleAttachContact = useCallback(() => {
    setShowAttachMenu(false)
    setShowContactPicker(true)
  }, [])

  const handleAttachPrompt = useCallback(() => {
    setShowAttachMenu(false)
    setShowPromptCompose(true)
  }, [])

  const handleAttachShareSession = useCallback(() => {
    setShowAttachMenu(false)
    setShowSessionSharePicker(true)
  }, [])

  const handleAttachCodexSession = useCallback(() => {
    if (!canShareCodexSession) return
    setShowAttachMenu(false)
    setShowCodexSessionShare(true)
  }, [canShareCodexSession])

  const focusMessageInput = focusComposer

  const handlePickResource = useCallback((ref: ImResourceCardRef) => {
    setPendingResource(ref)
  }, [])

  const handleCloseResourcePicker = useCallback(() => {
    setShowResourcePicker(false)
    focusMessageInput()
  }, [focusMessageInput])

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || [])
      if (files.length > 0) {
        void processFiles(files)
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
      focusMessageInput()
    },
    [focusMessageInput, processFiles],
  )

  // 插入 emoji 到光标处（不引第三方库，复用 EmojiPanel 同一份常用表）。
  const handleInsertEmoji = useCallback((emoji: string) => {
    composerHandleRef.current?.syncSelectionToTextarea()
    const el = textareaRef.current
    setText((prev) => {
      const start = el?.selectionStart ?? prev.length
      const end = el?.selectionEnd ?? prev.length
      const next = prev.slice(0, start) + emoji + prev.slice(end)
      requestAnimationFrame(() => {
        applyComposerCaret(start + emoji.length)
      })
      return next
    })
    setShowEmojiPanel(false)
  }, [applyComposerCaret])

  // TabTin 贴纸：点选后立刻作为 IMAGE + metadata.sticker 发出，不插入输入框。
  const handlePickSticker = useCallback(async (sticker: TabtinRobotSticker) => {
    if (!allowRichContent || isSendingSticker || isUploading || isSending || editingMessage) return
    setIsSendingSticker(true)
    setShowEmojiPanel(false)
    try {
      const file = await stickerSrcToFile(sticker.src, `tabtin-${sticker.id}.png`)
      const result = await uploadIMAttachment(
        file,
        undefined,
        undefined,
        conversationId,
      )
      onSendRef.current('', replyTo ?? undefined, MESSAGE_TYPE_IMAGE, {
        file_id: result.file_id,
        file_name: result.file_name,
        file_size: result.file_size,
        file_type: result.file_type,
        sticker: { pack: TABTIN_ROBOT_PACK_ID, id: sticker.id },
      })
      onCancelReply?.()
    } catch (uploadErr) {
      log.error('Sticker upload failed', {
        stickerId: sticker.id,
        reason: uploadErr instanceof Error ? uploadErr.message : String(uploadErr),
      })
      toast({
        title: t('uploadFailed'),
        description: uploadErr instanceof Error ? uploadErr.message : sticker.id,
        variant: 'destructive',
      })
    } finally {
      if (mountedRef.current) {
        setIsSendingSticker(false)
      }
    }
  }, [
    conversationId,
    allowRichContent,
    editingMessage,
    isSending,
    isSendingSticker,
    isUploading,
    onCancelReply,
    replyTo,
    t,
  ])

  // 发名片：选中成员后发一条 contact 卡消息（content 为人类可读回退文本，
  // 后端会以 DB 真实昵称/头像回填 card，防伪造）。
  const handlePickContact = useCallback((member: SearchMemberResult) => {
    const label = member.nickname || member.username || '用户'
    onSendRef.current(`[名片] ${label}`, undefined, MESSAGE_TYPE_TEXT, {
      card: { type: 'contact', user_id: member.id, name: label },
    })
  }, [])

  // 发指令卡：content 为人类可读回退文本（标题或正文首行截断，供搜索与旧端），
  // 服务端限长校验并回填 prompt_version。
  const handleComposePromptSend = useCallback((promptText: string, title: string) => {
    const firstLine = promptText
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
    const label = (title || firstLine).slice(0, 60) || '指令'
    onSendRef.current(`[指令] ${label}`, undefined, MESSAGE_TYPE_TEXT, {
      card: {
        type: 'prompt',
        prompt_text: promptText,
        ...(title ? { title } : {}),
      },
    })
  }, [])

  const clearTextDraft = useCallback(() => {
    setText('')
    setMentions([])
    setMentionState(null)
    requestAnimationFrame(() => {
      applyComposerCaret(0)
    })
  }, [applyComposerCaret])

  const trimmedText = text.trim()
  const messageContentBytes = useMemo(
    () => getIMMessageContentByteLength(trimmedText),
    [trimmedText],
  )
  const isMessageTooLong = !isIMMessageContentWithinLimit(trimmedText)
  const handleSend = useCallback(async () => {
    const trimmed = trimmedText
    if (isMessageTooLong) return
    if (!conversation || (!trimmed && pendingAttachments.length === 0 && !pendingResource) || isSending || isUploading) return
    const parsed = resolveMentionsFromText(trimmed, members ?? [])
    const userIds = new Set<string>(parsed.mentioned_user_ids)
    const agentIds = new Set<string>(parsed.mentioned_agent_ids)
    // 仅群聊允许 mention_all；以正文为准，避免选过后又删掉 @所有人仍误带 metadata。
    const mentionAll = Boolean(allowMentionAll && parsed.mention_all)
    for (const mention of mentions) {
      if (mention.member_type === 'all') {
        continue
      }
      if (!textHasMentionTarget(trimmed, mention)) {
        continue
      }
      if (mention.member_type === 'agent' && mention.agent_id) {
        agentIds.add(mention.agent_id)
      } else if (mention.member_type === 'user' && mention.user_id) {
        userIds.add(mention.user_id)
      }
    }
    const mentionMetadata = (userIds.size > 0 || agentIds.size > 0 || mentionAll)
      ? {
          ...(userIds.size > 0 ? { mentioned_user_ids: [...userIds] } : {}),
          ...(agentIds.size > 0 ? { mentioned_agent_ids: [...agentIds] } : {}),
          ...(mentionAll ? { mention_all: true } : {}),
        }
      : undefined

    if (editingMessage) {
      if (!trimmed) return
      // 编辑态：保存编辑而非发新消息；显式带 mention 字段以便重算（含清空 mention_all）。
      onSubmitEdit?.(editingMessage, trimmed, {
        mentioned_user_ids: [...userIds],
        ...(agentIds.size > 0 ? { mentioned_agent_ids: [...agentIds] } : {}),
        mention_all: mentionAll,
      })
      onCancelEdit?.()
      clearTextDraft()
      return
    }

    if (!pendingResource && pendingAttachments.length === 0) {
      onSendRef.current(trimmed, replyTo ?? undefined, undefined, mentionMetadata)
      onCancelReply?.()
      clearTextDraft()
      return
    }

    let hasSentFirstAttachment = false
    if (pendingResource) {
      const cardMetadata = buildResourceCardMetadata(pendingResource)
      onSendRef.current(
        trimmed || formatResourceCardContent(pendingResource),
        replyTo ?? undefined,
        MESSAGE_TYPE_TEXT,
        {
          ...mentionMetadata,
          ...cardMetadata,
          card: {
            ...cardMetadata.card,
            ...(trimmed ? { caption: trimmed } : {}),
          },
        },
      )
      setPendingResource(null)
      hasSentFirstAttachment = true
      onCancelReply?.()
      clearTextDraft()
    }

    if (pendingAttachments.length === 0) return

    setIsUploading(true)
    setUploadProgress(0)
    try {
      for (let index = 0; index < pendingAttachments.length; index++) {
        const attachment = pendingAttachments[index]
        try {
          const result = await uploadIMAttachment(
            attachment.file,
            (progress) => {
              if (mountedRef.current) {
                setUploadProgress(((index + progress) / pendingAttachments.length) * 100)
              }
            },
            undefined,
            conversationId,
          )
          const localPath = !attachment.isImage
            ? window.electron?.webUtils?.getPathForFile?.(attachment.file)
              ?? (attachment.file as File & { path?: string }).path
              ?? null
            : null
          const metadata = {
            file_id: result.file_id,
            file_name: result.file_name,
            file_size: result.file_size,
            file_type: result.file_type,
            ...(result.image_width && result.image_height
              ? {
                  image_width: result.image_width,
                  image_height: result.image_height,
                }
              : {}),
            ...(!hasSentFirstAttachment ? mentionMetadata : {}),
            ...(localPath ? { __client_local_path: localPath } : {}),
          }
          onSendRef.current(
            hasSentFirstAttachment ? '' : trimmed,
            hasSentFirstAttachment ? undefined : replyTo ?? undefined,
            attachment.isImage ? MESSAGE_TYPE_IMAGE : MESSAGE_TYPE_FILE,
            metadata,
          )
          removePendingAttachment(attachment.id)
          if (!hasSentFirstAttachment) {
            hasSentFirstAttachment = true
            onCancelReply?.()
            clearTextDraft()
          }
        } catch (uploadErr) {
          console.error('[TabChat] File upload failed:', uploadErr)
          toast({
            title: t('uploadFailed'),
            description: uploadErr instanceof Error ? uploadErr.message : attachment.file.name,
            variant: 'destructive',
          })
          break
        }
      }
    } finally {
      if (mountedRef.current) {
        setIsUploading(false)
        setUploadProgress(0)
      }
    }
  }, [trimmedText, isMessageTooLong, pendingAttachments, pendingResource, isSending, isUploading, members, mentions, allowMentionAll, editingMessage, onSubmitEdit, onCancelEdit, clearTextDraft, replyTo, onCancelReply, conversationId, conversation, removePendingAttachment, t])

  // 轻量富文本辅助：往选区两侧插入 markdown 标记（粗体/斜体/行内代码）。
  // 无选区时插入一对标记并把光标停在中间，方便继续输入。
  const wrapSelection = useCallback((marker: string) => {
    composerHandleRef.current?.syncSelectionToTextarea()
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart ?? 0
    const end = el.selectionEnd ?? 0
    setText((prev) => {
      const selected = prev.slice(start, end)
      const next = prev.slice(0, start) + marker + selected + marker + prev.slice(end)
      requestAnimationFrame(() => {
        applyComposerCaret(start + marker.length, end + marker.length)
      })
      return next
    })
  }, [applyComposerCaret])

  // 行首前缀类（标题/引用/列表）：给选区涉及的每一行行首加前缀。
  const prefixLines = useCallback((prefix: string) => {
    composerHandleRef.current?.syncSelectionToTextarea()
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart ?? 0
    const end = el.selectionEnd ?? 0
    setText((prev) => {
      const lineStart = prev.lastIndexOf('\n', start - 1) + 1
      const block = prev.slice(lineStart, end)
      const prefixed = block
        .split('\n')
        .map((line) => (line.startsWith(prefix) ? line : prefix + line))
        .join('\n')
      const next = prev.slice(0, lineStart) + prefixed + prev.slice(end)
      const delta = prefixed.length - block.length
      requestAnimationFrame(() => {
        applyComposerCaret(start + prefix.length, end + delta)
      })
      return next
    })
  }, [applyComposerCaret])

  const prefixOrderedLines = useCallback(() => {
    composerHandleRef.current?.syncSelectionToTextarea()
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart ?? 0
    const end = el.selectionEnd ?? 0
    setText((prev) => {
      const lineStart = prev.lastIndexOf('\n', start - 1) + 1
      const hasSelection = end > start
      const nextLineBreak = prev.indexOf('\n', start)
      const blockEnd = hasSelection
        ? end
        : nextLineBreak === -1
          ? prev.length
          : nextLineBreak
      const block = prev.slice(lineStart, blockEnd)
      const lines = block.split('\n')
      const prefixed = lines
        .map((line, index) => {
          const content = line.replace(/^\s*\d+\.\s*/, '')
          return `${index + 1}. ${content}`
        })
        .join('\n')
      const next = prev.slice(0, lineStart) + prefixed + prev.slice(blockEnd)
      const delta = prefixed.length - block.length
      requestAnimationFrame(() => {
        applyComposerCaret(start + 3, hasSelection ? end + delta : start + 3)
      })
      return next
    })
  }, [applyComposerCaret])

  // 链接：有选区 → [选中](url) 并把光标停在 url 处；无选区 → [文字](url)。
  const insertLink = useCallback(() => {
    composerHandleRef.current?.syncSelectionToTextarea()
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart ?? 0
    const end = el.selectionEnd ?? 0
    setText((prev) => {
      const selected = prev.slice(start, end) || t('linkText', { defaultValue: '链接文字' })
      const snippet = `[${selected}](url)`
      const next = prev.slice(0, start) + snippet + prev.slice(end)
      const urlStart = start + selected.length + 3
      requestAnimationFrame(() => {
        applyComposerCaret(urlStart, urlStart + 3)
      })
      return next
    })
  }, [applyComposerCaret, t])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (mentionState?.isOpen && mentionSelectorRef.current) {
        const handled = mentionSelectorRef.current.handleKeyDown(e)
        if (handled) return
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const key = e.key.toLowerCase()
        if (key === 'b') { e.preventDefault(); wrapSelection('**'); return }
        if (key === 'i') { e.preventDefault(); wrapSelection('*'); return }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        handleSend()
      }
      if (e.key === 'Escape') {
        if (editingMessage) {
          setText('')
          onCancelEdit?.()
        } else if (replyTo) {
          onCancelReply?.()
        }
      }
    },
    [handleSend, replyTo, onCancelReply, mentionState, wrapSelection, editingMessage, onCancelEdit],
  )

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value
      setText(value)
      const cursorPos = e.target.selectionStart ?? value.length
      const trigger = findComposerMentionTrigger(value, cursorPos)
      setMentionState(trigger ? { isOpen: true, ...trigger } : null)
    },
    [],
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      composerHandleRef.current?.syncSelectionToTextarea()
      const el = textareaRef.current
      const pastedText = e.clipboardData?.getData('text/plain')?.trim() ?? ''
      if (el && pastedText && /^(?:https?:\/\/|www\.)\S+$/i.test(pastedText)) {
        const start = el.selectionStart ?? 0
        const end = el.selectionEnd ?? 0
        if (start !== end) {
          e.preventDefault()
          const url = pastedText.startsWith('www.') ? `https://${pastedText}` : pastedText
          const cursorPos = start + (end - start) + url.length + 4
          setText((prev) => `${prev.slice(0, start)}[${prev.slice(start, end)}](${url})${prev.slice(end)}`)
          requestAnimationFrame(() => {
            applyComposerCaret(cursorPos)
          })
          return
        }
      }

      const items = e.clipboardData?.files
      if (!items || items.length === 0) return

      const validFiles = Array.from(items).filter(f => {
        const v = validateFile(f)
        return v.valid
      })
      if (validFiles.length > 0) {
        e.preventDefault()
        void processFiles(validFiles)
      } else if (items.length > 0) {
        e.preventDefault()
        toast({
          title: t('fileTypeNotSupported'),
          variant: 'destructive',
        })
      }
    },
    [applyComposerCaret, processFiles, t],
  )

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDragging(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current = 0
      setIsDragging(false)

      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) {
        void processFiles(files)
      }
    },
    [processFiles],
  )

  const handleMentionSelect = useCallback(
    (target: MentionTarget) => {
      if (!mentionState) return
      const before = text.slice(0, mentionState.startIndex)
      const after = text.slice(mentionState.startIndex + 1 + mentionState.query.length)
      const inserted = `${formatMentionMarkdown(target)} `
      const newText = before + inserted + after
      setText(newText)
      setMentionState(null)
      setMentions((prev) => {
        if (target.member_type === 'all') {
          if (prev.some((m) => m.member_type === 'all')) return prev
          return [...prev, target]
        }
        const identity = target.agent_id || target.user_id
        if (prev.some((m) => m.member_type !== 'all' && (m.agent_id || m.user_id) === identity)) {
          return prev
        }
        return [...prev, target]
      })
      requestAnimationFrame(() => {
        applyComposerCaret(before.length + inserted.length)
      })
    },
    [applyComposerCaret, mentionState, text],
  )

  const handleMentionClose = useCallback(() => {
    setMentionState(null)
  }, [])

  // DM 的会话名可能是传输层为保持契约填入的用户 ID；面向用户的文案只认公开资料。
  // 资料尚未返回时使用通用提示，避免首次打开会话时短暂闪出内部 ID。
  const recipientDisplayName = isDMConversation
    ? dmPeerProfile?.nickname || dmPeerProfile?.username || ''
    : conversation?.name || ''
  const isReadOnlyConversation = conversation?.can_send === false
  const inputPlaceholder = isReadOnlyConversation
    ? t('conversationReadOnly', { defaultValue: '你已退出该群，只能查看历史消息' })
    : recipientDisplayName
      ? t('messagePlaceholderNamed', {
        name: recipientDisplayName,
        defaultValue: '发给 {{name}}',
      })
      : t('typeMessage')
  const isSendBusy = isSending || isUploading
  const canSendMessage = useMemo(() => {
    if (!conversation || isReadOnlyConversation || isRemovedDmPeer || isUnavailableExternalContact || isSendBusy || isSendingSticker || isMessageTooLong) return false
    const trimmed = text.trim()
    if (editingMessage) return trimmed.length > 0
    return Boolean(trimmed || pendingAttachments.length > 0 || pendingResource)
  }, [
    conversation,
    editingMessage,
    isSendBusy,
    isSendingSticker,
    isMessageTooLong,
    isReadOnlyConversation,
    isRemovedDmPeer,
    isUnavailableExternalContact,
    pendingAttachments.length,
    pendingResource,
    text,
  ])
  const PendingResourceIcon = pendingResource?.type === 'table' ? Table2 : FileText
  const pendingResourceTypeLabel = pendingResource?.type === 'table'
    ? t('resourceCardTable', { defaultValue: '多维表格' })
    : t('resourceCardDocument', { defaultValue: '云文档' })
  // 任务共享仅 DM 可用：编排端点按 owner↔grantee 建 DM 发卡，群聊没有唯一对端。
  const canShareSession = Boolean(isDMConversation && dmPeerUserId)
  const attachActions = useMemo(() => [
    {
      id: 'local-file',
      label: t('attachLocalFile', { defaultValue: '本地文件' }),
      description: t('attachLocalFileDesc', { defaultValue: '从电脑选择文件或图片' }),
      Icon: Paperclip,
      disabled: isUploading,
      onSelect: handleAttachLocalFile,
    },
    {
      id: 'cloud-file',
      label: t('attachCloudFile', { defaultValue: '云文件' }),
      description: t('attachCloudFileDesc', { defaultValue: '分享表格或云文档' }),
      Icon: FileSymlink,
      disabled: false,
      onSelect: handleAttachCloudFile,
    },
    {
      id: 'contact-card',
      label: t('shareContact', { defaultValue: '发送名片' }),
      description: t('shareContactDesc', { defaultValue: '选择成员并分享名片' }),
      Icon: IdCard,
      disabled: false,
      onSelect: handleAttachContact,
    },
    {
      id: 'prompt-card',
      label: t('sendPrompt', { defaultValue: '发送指令' }),
      description: t('sendPromptDesc', { defaultValue: '发一条对方可直接使用的指令' }),
      Icon: SquareTerminal,
      disabled: false,
      onSelect: handleAttachPrompt,
    },
    ...(canShareCodexSession ? [{
      id: 'codex-session',
      label: t('codexSessionShare.menuLabel', { defaultValue: 'Codex 会话' }),
      description: t('codexSessionShare.menuDescription', { defaultValue: '发送可导入 Codex 的完整会话文件' }),
      Icon: OpenAIIcon,
      disabled: isUploading,
      onSelect: handleAttachCodexSession,
    }] : []),
    {
      id: 'share-session',
      label: t('shareSession', { defaultValue: '共享任务' }),
      description: canShareSession
        ? t('shareSessionDesc', { defaultValue: '选择自己的任务共享给对方' })
        : t('shareSessionGroupUnsupported', { defaultValue: '群聊暂不支持' }),
      Icon: Share2,
      disabled: !canShareSession,
      onSelect: handleAttachShareSession,
    },
  ], [
    canShareSession,
    canShareCodexSession,
    handleAttachCloudFile,
    handleAttachCodexSession,
    handleAttachContact,
    handleAttachLocalFile,
    handleAttachPrompt,
    handleAttachShareSession,
    isUploading,
    t,
  ])

  if (!conversation || isReadOnlyConversation || isRemovedDmPeer || isUnavailableExternalContact) {
    const unavailablePlaceholder = isReadOnlyConversation
      ? t('conversationReadOnly', { defaultValue: '你已退出该群，只能查看历史消息' })
      : isUnavailableExternalContact
      ? currentExternalContactAccess === null
        ? t('checkingExternalContactRelationship', {
          defaultValue: '正在确认外部联系人关系…',
        })
        : t('removedExternalContactCannotMessage', {
          defaultValue: '外部联系人当前不可发送消息',
        })
      : isRemovedDmPeer
        ? t('removedOrganizationMemberCannotMessage', {
        defaultValue: '该成员已退出组织，无法发送消息',
      })
        : t('removedFromGroup', { defaultValue: '你已不在此群聊中' })
    return (
      <div className="pl-4 pr-[calc(1rem+var(--im-scrollbar-compensation,0px))] pb-3 pt-2">
        <div data-im-composer className={IM_COMPOSER_PILL}>
          <textarea
            disabled
            placeholder={unavailablePlaceholder}
            rows={1}
            className={cn(
              'min-w-0 flex-1 resize-none border-0 bg-transparent px-0.5 py-0 text-muted-foreground placeholder:text-muted-foreground focus:outline-none',
              IM_COMPOSER_TEXTAREA_MIN_HEIGHT,
              IM_COMPOSER_TEXT,
            )}
          />
        </div>
      </div>
    )
  }

  return (
    <div
      className={IM_COMPOSER_SHELL_CLASS}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* 拖拽覆盖层 */}
      {isDragging && (
        <div className="absolute inset-0 z-sticky m-1 flex items-center justify-center rounded-lg border-2 border-dashed border-accent/60 bg-accent/5 pointer-events-none">
          <span className="text-body text-accent font-medium">{t('dropFileHere')}</span>
        </div>
      )}

      {/* 上传进度条：贴在卡片上方，不拉宽整条底栏 */}
      {isUploading && (
        <div className="mb-1.5 flex items-center gap-2 text-body text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>{t('uploading')}</span>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted/30">
            <div
              className="h-full rounded-full bg-accent transition-all duration-200"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* 飞书风：不透明输入卡片；左对齐消息行，右侧含滚动条补偿 */}
      <div data-testid="im-composer-surface" className={IM_COMPOSER_SURFACE}>
        {/* 编辑态提示栏（功能4） */}
        {editingMessage && (
          <div className="flex items-center gap-2 px-3 pt-2.5 pb-0">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-body text-muted-foreground">
              <div className="h-4 w-0.5 flex-shrink-0 rounded-full bg-accent/60" />
              <span className="flex-shrink-0 font-medium text-foreground/80">
                {t('editingMessage', { defaultValue: '正在编辑' })}
              </span>
            </div>
            <button
              type="button"
              onClick={() => { setText(''); onCancelEdit?.() }}
              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
              title={t('cancelEdit', { defaultValue: '取消编辑' })}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* 回复预览栏 */}
        {replyTo && !editingMessage && (
          <div className="flex items-center gap-2 px-3 pt-2.5 pb-0">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-body text-muted-foreground">
              <div className="h-4 w-0.5 flex-shrink-0 rounded-full bg-accent/60" />
              <span className="flex-shrink-0 font-medium text-foreground/80">
                {t('replyingTo', { name: replyToName || replyTo.sender_id.slice(0, 8) })}
              </span>
              <span className="truncate">{replyTo.content.slice(0, 80)}</span>
            </div>
            <button
              type="button"
              onClick={onCancelReply}
              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

      <div className="relative px-1.5 pb-1.5 pt-1">
        {/* Mention 选择器 */}
        {mentionState?.isOpen && (
          <MentionSelector
            ref={mentionSelectorRef}
            conversationId={conversationId}
            query={mentionState.query}
            onSelect={handleMentionSelect}
            onClose={handleMentionClose}
            position={{ bottom: 52, left: 16 }}
            allowMentionAll={allowMentionAll}
          />
        )}

        {/* Emoji 面板：portal 到 body，避免 IM_COMPOSER_SURFACE overflow-hidden 裁切 */}
        {showEmojiPanel && typeof document !== 'undefined' && createPortal(
          <>
            <div
              className="fixed inset-0 z-dropdown"
              onClick={() => setShowEmojiPanel(false)}
            />
            <div
              ref={emojiPanelRef}
              data-im-emoji-panel
              className={`fixed z-dropdown overflow-hidden rounded-xl ${OVERLAY_SURFACE_CLASS}`}
              style={{
                top: emojiPanelLayout.top,
                bottom: emojiPanelLayout.bottom,
                left: emojiPanelLayout.left,
                width: emojiPanelLayout.width,
                maxHeight: emojiPanelLayout.height,
                maxWidth: 'calc(100vw - 32px)',
              }}
            >
              <EmojiPanel
                variant="full"
                onPick={handleInsertEmoji}
                onPickSticker={(sticker) => { void handlePickSticker(sticker) }}
                stickerSending={isSendingSticker}
              />
            </div>
          </>,
          document.body,
        )}

        {/* 加号菜单：portal 到 body，避免 IM_COMPOSER_SURFACE overflow-hidden 裁切 */}
        {showAttachMenu && typeof document !== 'undefined' && createPortal(
          <>
            <div
              className="fixed inset-0 z-dropdown"
              onClick={() => setShowAttachMenu(false)}
            />
            <div
              ref={attachMenuRef}
              data-im-attach-menu
              className={`fixed z-dropdown overflow-hidden rounded-xl ${OVERLAY_SURFACE_CLASS}`}
              style={{
                top: attachMenuLayout.top,
                bottom: attachMenuLayout.bottom,
                left: attachMenuLayout.left,
                width: attachMenuLayout.width,
                maxHeight: attachMenuLayout.height,
              }}
            >
              {attachActions.map(({ id, label, description, Icon, disabled, onSelect }) => (
                <button
                  key={id}
                  type="button"
                  onClick={onSelect}
                  disabled={disabled}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/30 disabled:opacity-40"
                >
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
                    <Icon className={COMPOSER_TOOLBAR_ICON_CLASS} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium text-foreground">{label}</span>
                    <span className="block truncate text-caption text-muted-foreground/60">{description}</span>
                  </span>
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}

        {(pendingResource || pendingAttachments.length > 0) && (
          <div className="mb-2 flex flex-wrap gap-2.5" data-im-pending-attachments>
            {pendingResource && (
              <div
                data-im-pending-resource
                className="group/attachment relative flex h-20 min-w-48 max-w-64 items-center gap-3 overflow-hidden rounded-lg bg-background/60 px-3 ring-1 ring-inset ring-border/40"
              >
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-interactive bg-foreground/[0.06] text-accent-text">
                  <PendingResourceIcon className={COMPOSER_TOOLBAR_ICON_CLASS} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium text-foreground">
                    {pendingResource.name || pendingResourceTypeLabel}
                  </span>
                  <span className="block truncate text-caption text-muted-foreground/60">
                    {pendingResourceTypeLabel}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setPendingResource(null)}
                  className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity hover:bg-black/80 group-hover/attachment:opacity-100 focus-visible:opacity-100"
                  aria-label={t('removeAttachment', { defaultValue: '移除附件' })}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
            {pendingAttachments.map((attachment) => (
              <AttachmentPreview
                key={attachment.id}
                attachment={toComposerAttachment(attachment)}
                onRemove={(id) => {
                  if (isUploading) return
                  removePendingAttachment(id)
                }}
              />
            ))}
          </div>
        )}

        {showFormatToolbar && !isReadOnlyConversation && (
          <div className="mb-1.5 flex items-center gap-0.5 rounded-lg border border-border/30 bg-background px-1.5 py-1">
            {[
              { id: 'bold', Icon: ImComposerBoldIcon, label: t('formatBold', { defaultValue: '加粗' }), run: () => wrapSelection('**') },
              { id: 'italic', Icon: ImComposerItalicIcon, label: t('formatItalic', { defaultValue: '斜体' }), run: () => wrapSelection('*') },
              { id: 'code', Icon: Code, label: t('formatCode', { defaultValue: '代码' }), run: () => wrapSelection('`') },
              { id: 'link', Icon: ImComposerLinkIcon, label: t('formatLink', { defaultValue: '链接' }), run: insertLink },
              { id: 'heading', Icon: ImComposerHeadingIcon, label: t('formatHeading', { defaultValue: '标题' }), run: () => prefixLines('## ') },
              { id: 'quote', Icon: ImComposerQuoteIcon, label: t('formatQuote', { defaultValue: '引用' }), run: () => prefixLines('> ') },
              { id: 'ul', Icon: ImComposerBulletListIcon, label: t('formatBulletList', { defaultValue: '无序列表' }), run: () => prefixLines('- ') },
              { id: 'ol', Icon: ImComposerOrderedListIcon, label: t('formatNumberedList', { defaultValue: '有序列表' }), run: prefixOrderedLines },
            ].map(({ id, Icon, label, run }) => (
              <button
                key={id}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); run() }}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                title={label}
                aria-label={label}
              >
                {id === 'code' ? (
                  <Icon className={COMPOSER_TOOLBAR_ICON_CLASS} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
                ) : (
                  <Icon className={IM_COMPOSER_GLYPH_ICON} />
                )}
              </button>
            ))}
          </div>
        )}

        <div data-im-composer className={IM_COMPOSER_PILL}>
          {allowRichContent ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={buildAttachmentPickerAccept()}
                className="hidden"
                onChange={handleFileChange}
              />

              <button
                ref={attachMenuAnchorRef}
                type="button"
                onClick={handleOpenAttachMenu}
                disabled={isUploading}
                aria-expanded={showAttachMenu}
                className={cn(COMPOSER_TOOLBAR_BUTTON, 'disabled:opacity-40')}
                title={t('attachMore', { defaultValue: '添加' })}
              >
                {showAttachMenu ? (
                  <ImComposerCloseAddIcon className={cn(IM_COMPOSER_GLYPH_ICON, SIDEBAR_ICON_INACTIVE)} />
                ) : (
                  <ImComposerAddIcon className={cn(IM_COMPOSER_GLYPH_ICON, SIDEBAR_ICON_INACTIVE)} />
                )}
              </button>
            </>
          ) : null}

          <ImMentionComposer
            ref={textareaRef}
            composerRef={composerHandleRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={inputPlaceholder}
            disabled={isReadOnlyConversation}
          />

          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => {
                setShowAttachMenu(false)
                setShowEmojiPanel(false)
                setShowFormatToolbar((value) => !value)
              }}
              disabled={isReadOnlyConversation}
              aria-pressed={showFormatToolbar}
              className={cn(
                COMPOSER_TOOLBAR_BUTTON,
                showFormatToolbar && 'bg-foreground/[0.04] text-foreground dark:bg-foreground/[0.06]',
              )}
              title={t('formatText', { defaultValue: '格式' })}
            >
              <ImComposerFormatIcon className={cn(IM_COMPOSER_GLYPH_ICON, SIDEBAR_ICON_INACTIVE)} />
            </button>

            <button
              ref={emojiPanelAnchorRef}
              type="button"
              onClick={handleToggleEmojiPanel}
              disabled={isReadOnlyConversation}
              className={cn(
                COMPOSER_TOOLBAR_BUTTON,
                showEmojiPanel && 'bg-foreground/[0.04] text-foreground dark:bg-foreground/[0.06]',
              )}
              title={t('insertEmoji', { defaultValue: '表情' })}
            >
              <ImComposerEmojiIcon className={cn(IM_COMPOSER_GLYPH_ICON, SIDEBAR_ICON_INACTIVE)} />
            </button>

            <button
              type="button"
              onClick={() => { void handleSend() }}
              disabled={!canSendMessage}
              data-im-send-button
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-interactive transition-[background-color,color,opacity,transform] duration-150',
                canSendMessage
                  ? 'bg-accent text-accent-foreground hover:bg-accent/85 active:scale-[0.97]'
                  : 'cursor-default bg-muted/30 text-muted-foreground/30',
              )}
              title={t('sendMessage', { defaultValue: '发送' })}
              aria-label={t('sendMessage', { defaultValue: '发送' })}
            >
              {isSendBusy ? (
                <Loader2 className={cn(COMPOSER_TOOLBAR_ICON_CLASS, 'animate-spin')} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
              ) : (
                <Send className={COMPOSER_TOOLBAR_ICON_CLASS} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
              )}
            </button>
          </div>
        </div>
        {isMessageTooLong && (
          <div
            role="alert"
            data-testid="im-message-too-long"
            className="px-3 pb-2 text-caption text-destructive"
          >
            {t('messageTooLongDetail', {
              current: Math.ceil(messageContentBytes / 1_000),
              max: IM_MESSAGE_CONTENT_MAX_BYTES / 1_000,
              defaultValue: '消息过长（{{current}} KB），请缩短至 {{max}} KB 以内再发送。',
            })}
          </div>
        )}
      </div>
      </div>

      <IMResourcePickerDialog
        isOpen={showResourcePicker}
        onClose={handleCloseResourcePicker}
        organizationId={conversationOrganizationId}
        onPick={handlePickResource}
      />

      <ContactPickerDialog
        isOpen={showContactPicker}
        onClose={() => setShowContactPicker(false)}
        organizationId={conversationOrganizationId}
        onPick={handlePickContact}
      />

      <PromptComposeDialog
        isOpen={showPromptCompose}
        onClose={() => setShowPromptCompose(false)}
        onSend={handleComposePromptSend}
        recipientName={recipientDisplayName || null}
      />

      <SessionSharePickerDialog
        isOpen={showSessionSharePicker}
        onClose={() => setShowSessionSharePicker(false)}
        conversationId={conversationId}
        organizationId={conversationOrganizationId}
        granteeUserId={dmPeerUserId}
      />

      {canShareCodexSession && (
        <CodexSessionShareDialog
          isOpen={showCodexSessionShare}
          onClose={() => setShowCodexSessionShare(false)}
          conversationId={conversationId}
          onSend={onSendRef.current}
        />
      )}
    </div>
  )
}
