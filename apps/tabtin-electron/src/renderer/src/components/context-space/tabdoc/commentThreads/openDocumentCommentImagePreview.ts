/**
 * TabDoc 评论图片 → Electron 全局资源预览 Lightbox。
 *
 * 公共 tabdoc-ui 只上报预览意图；宿主在这里刷新同消息图片的短期签名 URL，
 * 再复用聊天已验证的缩放、键盘、遮罩关闭和显式下载体验。
 */
import type { CommentAttachment } from '@tabtin/tabdoc-ui/api-client'
import type { CommentAttachmentPreviewRequest } from '@tabtin/tabdoc-ui/editor'
import type { PreviewResource } from '@components/chat/preview/types'
import { useResourcePreviewStore } from '@components/chat/preview/useResourcePreviewStore'

type ResolvePreviewUrl = (fileId: string) => Promise<string>

function isSameAttachment(left: CommentAttachment, right: CommentAttachment): boolean {
  if (left.id && right.id) return left.id === right.id
  return left.file_id === right.file_id
}

function collectImageAttachments(request: CommentAttachmentPreviewRequest): CommentAttachment[] {
  const images = request.attachments.filter((attachment) => attachment.type === 'image')
  if (images.some((attachment) => isSameAttachment(attachment, request.attachment))) {
    return images
  }
  return request.attachment.type === 'image' ? [request.attachment, ...images] : images
}

export async function openDocumentCommentImagePreview(
  request: CommentAttachmentPreviewRequest,
  resolvePreviewUrl: ResolvePreviewUrl,
): Promise<boolean> {
  if (request.attachment.type !== 'image') return false
  const images = collectImageAttachments(request)
  if (images.length === 0) return false

  const resolved = await Promise.all(images.map(async (attachment) => {
    if (isSameAttachment(attachment, request.attachment)) {
      return request.previewUrl || attachment.preview_url
    }
    try {
      return await resolvePreviewUrl(attachment.file_id) || attachment.preview_url
    } catch {
      return attachment.preview_url
    }
  }))

  const entries = images.flatMap((attachment, index) => {
    const url = resolved[index]
    if (!url) return []
    return [{ attachment, url, index }]
  })
  const resources: PreviewResource[] = entries.map(({ attachment, url, index }) => ({
    id: `tabdoc-comment:${attachment.id || attachment.file_id}:${index}`,
    kind: 'image',
    url,
    name: attachment.metadata.file_name || 'image',
    mimeType: attachment.metadata.mime_type,
    size: attachment.metadata.file_size,
  } satisfies PreviewResource))
  if (resources.length === 0) return false

  const clickedIndex = Math.max(
    0,
    entries.findIndex(({ attachment }) => isSameAttachment(attachment, request.attachment)),
  )
  return useResourcePreviewStore.getState().open(resources, clickedIndex, {
    showNavMeta: true,
  })
}
