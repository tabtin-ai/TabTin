/**
 * IM 图片 → 复用 Agent 对话的 ChatResourcePreviewModal。
 *
 * 列表只取当前已加载消息（或侧栏传入的资产列表），不预拉全量历史、
 * 不展示 2/2 计数；左右切换即可。邻图按需换链，切换时再扩展。
 */

import type { IMMessage } from '@/services/tabchatApi'
import { useFileAttachmentStore } from '@stores/useFileAttachmentStore'
import { useIMStore } from '@stores/useIMStore'
import { sanitizeUrl } from '@/lib/sanitizeUrl'
import { MESSAGE_TYPE_IMAGE } from '@/constants/tabchat'
import { useResourcePreviewStore } from '@components/chat/preview/useResourcePreviewStore'
import type { PreviewResource } from '@components/chat/preview/types'
import { messageStableKey } from '@/services/im/messageMerge'

/** 当前图两侧各预换链的张数；切换时再按新中心扩展。 */
const NEARBY_RESOLVE_RADIUS = 2
/** 邻近换链并发上限，避免一次打爆 /attachment-url。 */
const NEARBY_RESOLVE_CONCURRENCY = 3

function resolveRenderableAttachmentUrl(message: IMMessage): string {
  const cached = useFileAttachmentStore.getState().statuses[messageStableKey(message)]
  if (message.metadata?.file_id) {
    return cached?.status === 'available' ? sanitizeUrl(cached.downloadUrl) : ''
  }
  if (cached?.status === 'unavailable') return ''
  return sanitizeUrl(cached?.downloadUrl || message.metadata?.access_url)
}

function isImageMessage(message: IMMessage): boolean {
  return message.message_type === MESSAGE_TYPE_IMAGE && !message.is_deleted && message.id > 0
}

function defaultImageFileName(mimeType?: string): string {
  if (mimeType === 'image/jpeg') return 'image.jpg'
  if (mimeType === 'image/gif') return 'image.gif'
  if (mimeType === 'image/webp') return 'image.webp'
  return 'image.png'
}

function toPreviewResource(message: IMMessage, url: string): PreviewResource {
  const fileId = typeof message.metadata?.file_id === 'string' ? message.metadata.file_id : undefined
  const mimeType = typeof message.metadata?.file_type === 'string' ? message.metadata.file_type : undefined
  return {
    id: `im:${messageStableKey(message)}:${fileId || url || 'pending'}`,
    kind: 'image',
    url,
    name: typeof message.metadata?.file_name === 'string'
      ? message.metadata.file_name
      : defaultImageFileName(mimeType),
    mimeType,
    size: message.metadata?.file_size,
    sourceMessageId: messageStableKey(message),
    fileId,
  }
}

function buildPreviewResources(
  messages: IMMessage[],
  clicked: IMMessage,
  clickedUrl: string,
): { resources: PreviewResource[]; clickedIndex: number; galleryMessages: IMMessage[] } {
  const resources: PreviewResource[] = []
  const galleryMessages: IMMessage[] = []
  let clickedIndex = -1

  for (const item of messages) {
    if (!isImageMessage(item)) continue
    const itemKey = messageStableKey(item)
    const clickedKey = messageStableKey(clicked)
    const cached = useFileAttachmentStore.getState().statuses[itemKey]
    if (itemKey !== clickedKey && cached?.status === 'unavailable') continue

    const url = itemKey === clickedKey ? clickedUrl : resolveRenderableAttachmentUrl(item)
    if (itemKey === clickedKey) clickedIndex = resources.length
    resources.push(toPreviewResource(item, url))
    galleryMessages.push(item)
  }

  if (clickedIndex < 0) {
    clickedIndex = resources.length
    resources.push(toPreviewResource(clicked, clickedUrl))
    galleryMessages.push(clicked)
  }

  return { resources, clickedIndex, galleryMessages }
}

function isViewerActive(generation: number): boolean {
  const state = useResourcePreviewStore.getState()
  return state.isOpen && state.generation === generation
}

async function resolveImageUrl(
  message: IMMessage,
  clickedKey: string,
  clickedUrl: string,
): Promise<string> {
  if (messageStableKey(message) === clickedKey) return clickedUrl

  const existing = resolveRenderableAttachmentUrl(message)
  if (existing) return existing

  // 与 ensureChecked / 其它并发路径共享 in-flight，避免重复换链。
  return useFileAttachmentStore.getState().resolveDownloadUrl(message)
}

function pickNearbyPendingMessageIds(
  resources: PreviewResource[],
  centerIndex: number,
  pendingIds: Set<string>,
): string[] {
  const start = Math.max(0, centerIndex - NEARBY_RESOLVE_RADIUS)
  const end = Math.min(resources.length - 1, centerIndex + NEARBY_RESOLVE_RADIUS)
  const ids: Array<{ id: string; distance: number }> = []
  for (let index = start; index <= end; index += 1) {
    const sourceMessageId = resources[index]?.sourceMessageId
    if (!sourceMessageId || !pendingIds.has(sourceMessageId)) continue
    ids.push({ id: sourceMessageId, distance: Math.abs(index - centerIndex) })
  }
  ids.sort((left, right) => left.distance - right.distance)
  return ids.map((item) => item.id)
}

/**
 * 只换当前图与邻图链接；用户切换时再扩展。关闭预览或世代过期立即停排新任务。
 */
async function hydrateNearbyImageUrls(params: {
  messages: IMMessage[]
  clicked: IMMessage
  clickedUrl: string
  generation: number
}): Promise<void> {
  const { messages, clicked, clickedUrl, generation } = params
  if (messages.length === 0) return

  const messagesById = new Map(messages.map((message) => [messageStableKey(message), message]))
  const pendingIds = new Set<string>()
  const clickedKey = messageStableKey(clicked)
  for (const message of messages) {
    const messageKey = messageStableKey(message)
    if (messageKey === clickedKey) continue
    if (resolveRenderableAttachmentUrl(message)) continue
    pendingIds.add(messageKey)
  }

  let hydrating: Promise<void> | null = null

  const runHydration = (): Promise<void> => {
    if (hydrating) return hydrating
    hydrating = (async () => {
      try {
        while (isViewerActive(generation) && pendingIds.size > 0) {
          const { resources, currentIndex } = useResourcePreviewStore.getState()
          const batch = pickNearbyPendingMessageIds(resources, currentIndex, pendingIds)
            .slice(0, NEARBY_RESOLVE_CONCURRENCY)
          if (batch.length === 0) break

          for (const messageId of batch) pendingIds.delete(messageId)

          await Promise.all(
            batch.map(async (messageId) => {
              if (!isViewerActive(generation)) return
              const message = messagesById.get(messageId)
              if (!message) return
              const url = await resolveImageUrl(message, clickedKey, clickedUrl)
              if (!isViewerActive(generation)) return
              if (url) {
                useResourcePreviewStore.getState().patchResourceUrl(
                  messageStableKey(message),
                  url,
                  generation,
                )
                return
              }
              useResourcePreviewStore.getState().removeResource(messageStableKey(message), generation)
            }),
          )
        }
      } finally {
        hydrating = null
      }
    })()
    return hydrating
  }

  await runHydration()
  if (!isViewerActive(generation) || pendingIds.size === 0) return

  await new Promise<void>((resolve) => {
    const unsubscribe = useResourcePreviewStore.subscribe((state, prev) => {
      if (!state.isOpen || state.generation !== generation) {
        unsubscribe()
        resolve()
        return
      }
      if (pendingIds.size === 0) {
        unsubscribe()
        resolve()
        return
      }
      if (state.currentIndex === prev.currentIndex) return
      void runHydration().then(() => {
        if (pendingIds.size === 0 || !isViewerActive(generation)) {
          unsubscribe()
          resolve()
        }
      })
    })
  })
}

export function openImImagePreview(
  message: IMMessage,
  clickedUrl: string,
  imageMessages?: IMMessage[],
): void {
  const safeClickedUrl = sanitizeUrl(clickedUrl)
  if (!safeClickedUrl) return

  // 只用当前已加载列表：会话消息窗或侧栏资产列表，不另拉历史页。
  const seedMessages = imageMessages
    ?? (useIMStore.getState().messages[message.conversation_id] || [])
  const { resources, clickedIndex, galleryMessages } = buildPreviewResources(
    seedMessages,
    message,
    safeClickedUrl,
  )
  const opened = useResourcePreviewStore.getState().open(resources, clickedIndex, {
    // IM 只要左右切换，不展示 2/2 · 来自 N 条消息
    showNavMeta: false,
  })
  if (!opened) return
  const generation = useResourcePreviewStore.getState().generation

  void hydrateNearbyImageUrls({
    messages: galleryMessages,
    clicked: message,
    clickedUrl: safeClickedUrl,
    generation,
  })
}
