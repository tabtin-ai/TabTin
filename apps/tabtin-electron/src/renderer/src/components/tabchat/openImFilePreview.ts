/**
 * IM 非图片附件 → 复用 Agent 对话的 ChatResourcePreviewModal。
 *
 * 侧栏「文件」历史与消息气泡共用此入口，避免各写一份换链 + open store。
 * 图片走 openImImagePreview（同样落到 ChatResourcePreviewModal，并带会话图库）。
 */

import { toast } from '@components/ui'
import { inferPreviewableKind } from '@components/chat/preview/inferPreviewableKind'
import { useResourcePreviewStore } from '@components/chat/preview/useResourcePreviewStore'
import type { PreviewResource } from '@components/chat/preview/types'
import { useFileAttachmentStore } from '@stores/useFileAttachmentStore'
import { messageStableKey } from '@/services/im/messageMerge'
import type { IMMessage } from '@/services/tabchatApi'
import { getMessageAttachmentDownloadUrl } from '@/services/tabchatApi'
import { sanitizeUrl } from '@/lib/sanitizeUrl'
import { createLogger } from '@/utils/logger'

const log = createLogger('ImFilePreview')

// i18next TFunction 比这更宽；此处只约束调用方会用到的形态。
export type ImAttachmentTranslate = (
  key: string,
  options?: { defaultValue?: string } & Record<string, unknown>,
) => string

/** 是否可用 Agent Lightbox 预览（非图片；图片请走 openImImagePreview 以带会话图库）。 */
export function canOpenImFilePreview(message: IMMessage): boolean {
  const fileName = typeof message.metadata?.file_name === 'string'
    ? message.metadata.file_name
    : ''
  const mimeType = typeof message.metadata?.file_type === 'string'
    ? message.metadata.file_type
    : undefined
  return inferPreviewableKind(mimeType, fileName) !== null
}

/**
 * 换链拿可拉取 URL（presigned 可能过期）。
 * 有 file_id 时以服务端为准，不回退历史 access_url。
 */
export async function resolveImAttachmentDownloadUrl(
  message: IMMessage,
  t: ImAttachmentTranslate,
): Promise<string | null> {
  const fileAttachment = useFileAttachmentStore.getState().statuses[messageStableKey(message)]
  const markUnavailable = useFileAttachmentStore.getState().markUnavailable
  const fileId = message.metadata?.file_id
  const fallbackUrl = fileAttachment?.downloadUrl ?? sanitizeUrl(message.metadata?.access_url)

  if (fileId) {
    try {
      const { download_url: freshUrl } = await getMessageAttachmentDownloadUrl(
        message.conversation_id,
        message,
      )
      return freshUrl
    } catch (err) {
      log.error('attachment download url failed', {
        messageId: message.id,
        reason: err instanceof Error ? err.message : String(err),
      })
      markUnavailable(message)
      toast({
        title: t('fileUnavailable'),
        description: t('fileUnavailableDesc'),
        variant: 'destructive',
      })
      return null
    }
  }

  if (fallbackUrl) return fallbackUrl

  markUnavailable(message)
  toast({
    title: t('fileUnavailable'),
    description: t('fileUnavailableDesc'),
    variant: 'destructive',
  })
  return null
}

/**
 * 打开应用内文件预览。成功返回 true；不可预览 / 换链失败返回 false。
 * @param url 可选已解析 URL，传入则跳过换链（侧栏已 resolve 过时复用）。
 */
export async function openImFilePreview(
  message: IMMessage,
  t: ImAttachmentTranslate,
  options?: { url?: string },
): Promise<boolean> {
  const fileName = typeof message.metadata?.file_name === 'string'
    ? message.metadata.file_name
    : t('unknown', { defaultValue: '未知文件' })
  const mimeType = typeof message.metadata?.file_type === 'string'
    ? message.metadata.file_type
    : undefined
  const previewKind = inferPreviewableKind(mimeType, fileName)
  if (!previewKind) {
    toast({
      title: t('previewUnsupported', {
        defaultValue: '暂不支持预览此类型文件',
      }),
    })
    return false
  }

  const url = options?.url ?? await resolveImAttachmentDownloadUrl(message, t)
  if (!url) return false

  useResourcePreviewStore.getState().open([{
    id: `im:${messageStableKey(message)}:${message.metadata?.file_id || url}`,
    kind: previewKind,
    url,
    name: fileName,
    mimeType,
    size: message.metadata?.file_size,
    sourceMessageId: messageStableKey(message),
    fileId: message.metadata?.file_id,
  } satisfies PreviewResource])
  return true
}
