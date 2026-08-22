/**
 * ImConversationAssetPane —— IM 会话桌面画布内的「会话资产」列表页。
 *
 * 复用 IM 历史内容筛选 API（content_filter=document|file）拉取该会话分享过的
 * 云盘 / 文件，并用 FilteredHistoryList 渲染（与旧 ChatHeader 三 tab 同款数据 +
 * 去重逻辑）。由 imassets context handler 在会话桌面画布中挂载。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getMessages, type IMMessage } from '@/services/tabchatApi'
import { useFileAttachmentStore } from '@stores/useFileAttachmentStore'
import { useIMStore } from '@stores/useIMStore'
import {
  CHAT_CONTENT_FILTER_DOCUMENT,
  CHAT_CONTENT_FILTER_FILE,
  MESSAGE_TYPE_FILE,
  MESSAGE_TYPE_IMAGE,
} from '@/constants/tabchat'
import { FilteredHistoryList } from './FilteredHistoryList'
import { createLogger } from '@/utils/logger'
import { messageStableKey } from '@/services/im/messageMerge'

const log = createLogger('ImAssetPane')
const EMPTY_MESSAGES: IMMessage[] = []

export type ImAssetKind = 'document' | 'file'

interface UseConversationAssetsResult {
  messages: IMMessage[]
  isLoading: boolean
  hasMore: boolean
  loadMore: () => Promise<boolean>
}

/**
 * 拉取某会话在指定筛选（云盘 / 文件）下的历史消息。逻辑对齐 ChatView 的
 * loadFilteredMessages：requestSeq 防竞态、按 before 游标向前翻页、附件可用性预检。
 */
function useConversationAssets(conversationId: string, kind: ImAssetKind): UseConversationAssetsResult {
  const contentFilter = kind === 'file' ? CHAT_CONTENT_FILTER_FILE : CHAT_CONTENT_FILTER_DOCUMENT
  const [messages, setMessages] = useState<IMMessage[]>(EMPTY_MESSAGES)
  const [isLoading, setIsLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const seqRef = useRef(0)
  const liveMessages = useIMStore((state) => state.messages[conversationId] ?? EMPTY_MESSAGES)

  const load = useCallback(
    async (before?: IMMessage): Promise<boolean> => {
      const seq = ++seqRef.current
      setIsLoading(true)
      try {
        const result = await getMessages(conversationId, before, undefined, contentFilter)
        if (seqRef.current !== seq) return false
        if (result.length === 0) setHasMore(false)
        useFileAttachmentStore.getState().ensureChecked(result)
        setMessages((current) => (before == null ? result : [...result, ...current]))
        return result.length > 0
      } catch (err) {
        if (seqRef.current === seq) {
          log.error('load conversation assets failed', { conversationId, kind, err })
        }
        return false
      } finally {
        if (seqRef.current === seq) setIsLoading(false)
      }
    },
    [conversationId, contentFilter, kind],
  )

  useEffect(() => {
    seqRef.current += 1
    setMessages(EMPTY_MESSAGES)
    setIsLoading(false)
    setHasMore(true)
    void load()
  }, [load])

  const loadMore = useCallback(async (): Promise<boolean> => {
    const current = messages
    // 首屏请求短暂失败时仍允许「加载更多」重新拉取，不能因空数组把恢复入口锁死。
    if (current.length === 0) return load()
    return load(current[0])
  }, [load, messages])

  const mergedMessages = useMemo(() => {
    const matchesKind = (message: IMMessage) => kind === 'file'
      ? message.message_type === MESSAGE_TYPE_FILE || message.message_type === MESSAGE_TYPE_IMAGE
      : message.metadata?.card?.type === 'document' || message.metadata?.card?.type === 'table'
    const byId = new Map(messages.map((message) => [messageStableKey(message), message]))
    for (const message of liveMessages) {
      const messageKey = messageStableKey(message)
      if (message.is_deleted || message._failed) {
        byId.delete(messageKey)
      } else if (matchesKind(message)) {
        byId.set(messageKey, message)
      }
    }
    return [...byId.values()]
  }, [kind, liveMessages, messages])

  return { messages: mergedMessages, isLoading, hasMore, loadMore }
}

interface Props {
  conversationId: string
  kind: ImAssetKind
}

export const ImConversationAssetPane: React.FC<Props> = ({ conversationId, kind }) => {
  const { t } = useTranslation('tabchat')
  const { messages, isLoading, hasMore, loadMore } = useConversationAssets(conversationId, kind)
  const isFile = kind === 'file'
  const emptyLabel = isFile
    ? t('contentFilterFilesEmpty', { defaultValue: '还没有分享过文件' })
    : t('context:canvasRail.assetDocumentsEmpty', { defaultValue: '当前对话暂无云盘内容' })

  return (
    <div className="flex h-full min-h-0 min-w-0 w-full max-w-full flex-col overflow-hidden bg-transparent">
      <FilteredHistoryList
        messages={messages}
        conversationId={conversationId}
        contentFilter={isFile ? CHAT_CONTENT_FILTER_FILE : CHAT_CONTENT_FILTER_DOCUMENT}
        isLoading={isLoading}
        hasMore={hasMore}
        onLoadMore={loadMore}
        emptyLabel={emptyLabel}
      />
    </div>
  )
}

ImConversationAssetPane.displayName = 'ImConversationAssetPane'
