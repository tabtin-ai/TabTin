import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, ExternalLink, FileText, Image as ImageIcon, Loader2, RefreshCcw, Cloud, Table2 } from 'lucide-react'
import { useFileAttachmentStore } from '@stores/useFileAttachmentStore'
import { useUserProfileCache, useDisplayNames } from '@stores/useUserProfileCache'
import { useIMStore } from '@stores/useIMStore'
import type { IMMessage } from '@/services/tabchatApi'
import { compareMessages, messageStableKey } from '@/services/im/messageMerge'
import {
  CHAT_CONTENT_FILTER_DOCUMENT,
  MESSAGE_TYPE_FILE,
  MESSAGE_TYPE_IMAGE,
  type ChatContentFilter,
} from '@/constants/tabchat'
import { sanitizeUrl } from '@/lib/sanitizeUrl'
import { formatFileSize } from '@/services/tabchatAttachmentApi'
import { formatMessageTimestamp } from '@/lib/dateUtils'
import { downloadImAttachment } from './downloadImAttachment'
import { openIMResourceFromChat, openImResourceInCanvas } from './IMResourceCard'
import { useImConversationCanvas } from './ImConversationCanvasContext'
import { inferPreviewableKind } from '@components/chat/preview/inferPreviewableKind'
import { openImFilePreview, resolveImAttachmentDownloadUrl } from './openImFilePreview'
import { openImImagePreview } from './openImImagePreview'

interface Props {
  messages: IMMessage[]
  conversationId: string
  contentFilter: Exclude<ChatContentFilter, 'message'>
  isLoading: boolean
  hasMore: boolean
  onLoadMore: () => Promise<boolean | void>
  emptyLabel: string
  /** 顶部浮动栏（顶栏）高度，作为列表上内衬 */
  topInset?: number
  /** 底部浮动栏（输入框）高度，作为列表下内衬 */
  bottomInset?: number
}

export interface FilteredHistoryEntry {
  message: IMMessage
  duplicateCount: number
}

export function buildFilteredHistoryEntries(
  messages: IMMessage[],
  contentFilter: Exclude<ChatContentFilter, 'message'>,
): FilteredHistoryEntry[] {
  if (contentFilter !== CHAT_CONTENT_FILTER_DOCUMENT) {
    return [...messages]
      .sort((a, b) => compareMessages(b, a))
      .map((message) => ({ message, duplicateCount: 1 }))
  }

  const byResourceId = new Map<string, FilteredHistoryEntry>()
  for (const message of messages) {
    const resourceType = message.metadata?.card?.type || 'unknown'
    const resourceId = message.metadata?.card?.resource_id
    const key = resourceId
      ? `${resourceType}:${resourceId}`
      : `message:${message.metadata.message_ref ?? message.id}`
    const existing = byResourceId.get(key)
    if (!existing) {
      byResourceId.set(key, { message, duplicateCount: 1 })
      continue
    }

    existing.duplicateCount += 1
    if (compareMessages(message, existing.message) > 0) {
      existing.message = message
    }
  }

  return [...byResourceId.values()].sort((a, b) => compareMessages(b.message, a.message))
}

export const FilteredHistoryList: React.FC<Props> = ({
  messages,
  conversationId,
  contentFilter,
  isLoading,
  hasMore,
  onLoadMore,
  emptyLabel,
  topInset = 0,
  bottomInset = 0,
}) => {
  const { t } = useTranslation('tabchat')
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const entries = useMemo(
    () => buildFilteredHistoryEntries(messages, contentFilter),
    [contentFilter, messages],
  )
  const senderIds = useMemo(
    () => entries
      .map((entry) => entry.message)
      .filter((message) => message.sender_type !== 'agent')
      .map((message) => message.sender_id)
      .filter(Boolean),
    [entries],
  )
  const senderNames = useDisplayNames(senderIds)
  const imageMessages = useMemo(
    () => entries.map((entry) => entry.message).filter((message) => message.message_type === MESSAGE_TYPE_IMAGE),
    [entries],
  )

  useEffect(() => {
    if (senderIds.length) {
      useUserProfileCache.getState().ensureProfiles(senderIds)
    }
  }, [senderIds])

  const handleLoadMore = useCallback(async () => {
    if (isLoadingMore) return
    setIsLoadingMore(true)
    try {
      await onLoadMore()
    } finally {
      setIsLoadingMore(false)
    }
  }, [isLoadingMore, onLoadMore])

  if (entries.length === 0 && isLoading) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="w-10 h-10 mx-auto rounded-full bg-muted/20 flex items-center justify-center">
            {contentFilter === CHAT_CONTENT_FILTER_DOCUMENT
              ? <Cloud className="h-5 w-5 text-muted-foreground" />
              : <FileText className="h-5 w-5 text-muted-foreground" />}
          </div>
          <p className="text-body text-muted-foreground">{emptyLabel}</p>
          {hasMore && (
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={isLoading || isLoadingMore}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-body text-muted-foreground hover:bg-muted/30 hover:text-foreground disabled:opacity-50 transition-colors"
            >
              {isLoading || isLoadingMore ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCcw className="h-3.5 w-3.5" />
              )}
              {t('contentListLoadMore')}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      data-testid="filtered-history-scroll"
      className="min-h-0 min-w-0 w-full max-w-full flex-1 overflow-x-hidden overflow-y-auto px-4 py-3"
      style={{ paddingTop: topInset + 12, paddingBottom: bottomInset + 12 }}
    >
      <div data-testid="filtered-history-list" className="mx-auto min-w-0 w-full max-w-5xl space-y-2 @container">
        <div className="overflow-hidden rounded-xl border border-border/30 bg-background">
          {entries.map(({ message, duplicateCount }) => {
            const senderName = message.sender_type === 'agent'
              ? (message.sender_name || t('aiAssistant'))
              : (senderNames[message.sender_id] || message.sender_name || message.sender_id.slice(0, 8))
            return (
              <HistoryListRow
                key={messageStableKey(message)}
                message={message}
                conversationId={conversationId}
                contentFilter={contentFilter}
                senderName={senderName}
                duplicateCount={duplicateCount}
                imageMessages={imageMessages}
              />
            )
          })}
        </div>
        {hasMore && (
        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={handleLoadMore}
            disabled={isLoading || isLoadingMore}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-body text-muted-foreground hover:bg-muted/30 hover:text-foreground disabled:opacity-50 transition-colors"
          >
            {isLoading || isLoadingMore ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="h-3.5 w-3.5" />
            )}
            {t('contentListLoadMore')}
          </button>
        </div>
        )}
      </div>
    </div>
  )
}

interface RowProps {
  message: IMMessage
  conversationId: string
  contentFilter: Exclude<ChatContentFilter, 'message'>
  senderName: string
  duplicateCount: number
  imageMessages: IMMessage[]
}

const HistoryListRow: React.FC<RowProps> = ({ message, conversationId, contentFilter, senderName, duplicateCount, imageMessages }) => {
  const conversationOrganizationId = useIMStore(
    (state) => state.conversations.find((conversation) => conversation.id === conversationId)?.organization_id,
  )

  if (contentFilter === CHAT_CONTENT_FILTER_DOCUMENT) {
    return (
      <DocumentHistoryRow
        message={message}
        senderName={senderName}
        duplicateCount={duplicateCount}
        conversationOrganizationId={conversationOrganizationId}
      />
    )
  }

  return <FileHistoryRow message={message} senderName={senderName} imageMessages={imageMessages} />
}

const DocumentHistoryRow: React.FC<{
  message: IMMessage
  senderName: string
  duplicateCount: number
  conversationOrganizationId?: string
}> = ({ message, senderName, duplicateCount, conversationOrganizationId }) => {
  const { t } = useTranslation('tabchat')
  const conversationCanvas = useImConversationCanvas()
  const card = message.metadata?.card
  const isTable = card?.type === 'table'
  const name = card?.name || t(isTable ? 'contentListTable' : 'contentListDocument')
  const handleOpen = useCallback(async () => {
    if (!card) return
    const target = {
      resourceType: (isTable ? 'table' : 'document') as 'table' | 'document',
      resourceId: card.resource_id ?? '',
      name,
      spaceId: card.space_id,
      organizationId: card.organization_id ?? conversationOrganizationId,
    }
    // 会话桌面态：就地开在本会话画布；否则退回既有跳转。
    if (conversationCanvas) {
      openImResourceInCanvas(target, conversationCanvas)
      return
    }
    await openIMResourceFromChat(target, t)
  }, [card, conversationCanvas, conversationOrganizationId, isTable, name, t])
  const Icon = isTable ? Table2 : FileText
  const typeLabel = t(isTable ? 'contentListTable' : 'contentListDocument')
  const accentClass = isTable
    ? 'bg-teal-500/10 text-teal-700 dark:text-teal-300'
    : 'bg-blue-500/10 text-blue-700 dark:text-blue-300'

  return (
    <button
      type="button"
      onClick={handleOpen}
      className="flex min-w-0 w-full max-w-full items-center gap-2 border-b border-border/20 px-2 py-3 text-left last:border-b-0 hover:bg-muted/20 transition-colors @[800px]:gap-3 @[800px]:px-3"
      disabled={!card?.resource_id || (!(card?.space_id && card.space_id !== 'None') && !card?.organization_id && !conversationOrganizationId)}
    >
      <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg ${accentClass}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-body font-medium text-foreground">{name}</span>
          <span className={`hidden flex-shrink-0 rounded-full px-2 py-0.5 text-caption font-medium @[460px]:inline-flex ${accentClass}`}>
            {typeLabel}
          </span>
        </div>
        <RowMeta message={message} senderName={senderName} />
        {duplicateCount > 1 && (
          <div className="mt-0.5 text-caption text-muted-foreground/60">
            {t('contentListShareCount', { count: duplicateCount })}
          </div>
        )}
      </div>
      <span className="inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-md px-2 text-body text-muted-foreground">
        <ExternalLink className="h-3.5 w-3.5" />
        <span className="hidden @[800px]:inline">{t('contentListOpen')}</span>
      </span>
    </button>
  )
}

const ImageHistoryThumbnail: React.FC<{ src: string; name: string }> = ({ src, name }) => {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [src])

  if (!src || failed) {
    return (
      <div className="flex h-14 w-20 flex-shrink-0 items-center justify-center rounded-lg bg-muted/30 text-muted-foreground">
        <ImageIcon className="h-5 w-5" />
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={name}
      data-testid="history-image-thumbnail"
      className="h-14 w-20 flex-shrink-0 rounded-lg object-cover"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  )
}

const FileHistoryRow: React.FC<{ message: IMMessage; senderName: string; imageMessages: IMMessage[] }> = ({
  message,
  senderName,
  imageMessages,
}) => {
  const { t } = useTranslation('tabchat')
  const [isDownloading, setIsDownloading] = useState(false)
  const [isOpeningPreview, setIsOpeningPreview] = useState(false)
  const fileAttachment = useFileAttachmentStore((state) =>
    (message.message_type === MESSAGE_TYPE_FILE || message.message_type === MESSAGE_TYPE_IMAGE)
      ? state.statuses[messageStableKey(message)]
      : undefined,
  )
  const markAttachmentDownloaded = useFileAttachmentStore((state) => state.markDownloaded)
  const fileName = message.metadata?.file_name || t('unknown')
  const isImage = message.message_type === MESSAGE_TYPE_IMAGE
  const status = fileAttachment?.status ?? 'checking'
  const isUnavailable = status === 'unavailable'
  const isChecking = status === 'checking'
  const canDownload = status === 'available'
  const previewKind = inferPreviewableKind(
    typeof message.metadata?.file_type === 'string' ? message.metadata.file_type : undefined,
    fileName,
  )
  const canPreview = canDownload && previewKind !== null

  const resolveDownloadUrl = useCallback(
    () => resolveImAttachmentDownloadUrl(message, t),
    [message, t],
  )

  const handlePreview = useCallback(async () => {
    if (isOpeningPreview || !canPreview || !previewKind) return
    setIsOpeningPreview(true)
    try {
      const url = await resolveDownloadUrl()
      if (!url) return
      if (isImage) {
        openImImagePreview(message, url, imageMessages)
        return
      }
      await openImFilePreview(message, t, { url })
    } finally {
      setIsOpeningPreview(false)
    }
  }, [canPreview, imageMessages, isImage, isOpeningPreview, message, previewKind, resolveDownloadUrl, t])

  const handleDownload = useCallback(async () => {
    if (isDownloading || !canDownload) return
    setIsDownloading(true)
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
      setIsDownloading(false)
    }
  }, [canDownload, fileName, isDownloading, markAttachmentDownloaded, message, resolveDownloadUrl, t])

  const Icon = isImage ? ImageIcon : FileText
  const detailText = isUnavailable
    ? t('fileUnavailable')
    : isChecking
      ? t('fileChecking')
      : formatFileSize(message.metadata?.file_size || 0)

  const thumbnailUrl = isImage && canDownload
    ? sanitizeUrl(fileAttachment?.downloadUrl ?? message.metadata?.access_url)
    : ''
  const canOpenPreview = canPreview && !isOpeningPreview
  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canOpenPreview || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    void handlePreview()
  }

  return (
    <div
      role={canOpenPreview ? 'button' : undefined}
      aria-label={canOpenPreview ? t('preview') : undefined}
      tabIndex={canOpenPreview ? 0 : undefined}
      onClick={canOpenPreview ? handlePreview : undefined}
      onKeyDown={handleRowKeyDown}
      className={`flex min-w-0 w-full max-w-full items-center gap-2 border-b border-border/20 px-2 py-3 last:border-b-0 @[800px]:gap-3 @[800px]:px-3 ${isUnavailable ? 'opacity-60' : ''} ${canOpenPreview ? 'cursor-pointer hover:bg-muted/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60' : ''}`}
    >
      {isImage ? (
        <ImageHistoryThumbnail src={thumbnailUrl} name={fileName} />
      ) : (
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-muted/30 text-muted-foreground">
          <Icon className="h-5 w-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-body font-medium text-foreground">{fileName}</span>
          <span className="hidden flex-shrink-0 rounded-full bg-muted/40 px-2 py-0.5 text-caption font-medium text-muted-foreground @[460px]:inline-flex">
            {isImage ? t('contentListImage') : t('contentListFile')}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className={`text-caption ${isUnavailable ? 'text-destructive/80' : 'text-muted-foreground/60'}`}>
            {detailText}
          </span>
          <span className="text-caption text-muted-foreground/60">·</span>
          <RowMeta message={message} senderName={senderName} inline />
        </div>
      </div>
      <div
        className="ml-auto flex flex-shrink-0 items-center gap-1"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={handleDownload}
          disabled={!canDownload || isDownloading}
          aria-label={t('download')}
          title={t('download')}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-body text-muted-foreground hover:bg-muted/30 hover:text-foreground disabled:opacity-50 transition-colors"
        >
          {isDownloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          <span className="hidden @[800px]:inline">{t('download')}</span>
        </button>
      </div>
    </div>
  )
}

const RowMeta: React.FC<{ message: IMMessage; senderName: string; inline?: boolean }> = ({
  message,
  senderName,
  inline = false,
}) => {
  const { t } = useTranslation('tabchat')
  const sentAt = formatMessageTimestamp(message.created_at, t)
  const content = `${t('contentListSentBy', { name: senderName })} · ${sentAt}`
  if (inline) {
    return <span className="truncate text-caption text-muted-foreground/60">{content}</span>
  }
  return (
    <div className="mt-0.5 truncate text-caption text-muted-foreground/60">
      {content}
    </div>
  )
}
