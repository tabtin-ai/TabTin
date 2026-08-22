import type { AppHostClient } from '@tabtin/app-host-sdk'
import {
  resolveSharedCommentAttachmentPreview,
  type CommentThread,
} from '@tabtin/tabdoc-ui/api-client'

/**
 * 将线程附件的鉴权 preview path 解析为短时 OSS URL（分享页 img 可直接显示）。
 */
export async function resolveThreadAttachmentPreviews(
  client: AppHostClient,
  shareId: string,
  threads: CommentThread[],
  password?: string,
): Promise<CommentThread[]> {
  const cache = new Map<string, string>()

  const resolveOne = async (fileId: string, fallback: string): Promise<string> => {
    if (!fileId) return fallback
    const cached = cache.get(fileId)
    if (cached) return cached
    try {
      const signed = await resolveSharedCommentAttachmentPreview(client, shareId, fileId, password)
      if (signed) {
        cache.set(fileId, signed)
        return signed
      }
    } catch {
      // 保持原 path，避免整批失败
    }
    return fallback
  }

  return Promise.all(threads.map(async (thread) => ({
    ...thread,
    messages: await Promise.all(thread.messages.map(async (message) => ({
      ...message,
      attachments: await Promise.all(message.attachments.map(async (attachment) => ({
        ...attachment,
        preview_url: await resolveOne(attachment.file_id, attachment.preview_url),
      }))),
    }))),
  })))
}
