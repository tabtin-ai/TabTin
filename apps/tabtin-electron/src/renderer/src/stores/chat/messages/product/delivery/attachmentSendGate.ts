import type { ChatAttachment } from '../../../../../components/chat/types'

/** Composer 添加即传完成后的发送门禁：未 ready 不得打 Host。 */
export function isAttachmentReadyForHostSend(att: ChatAttachment): boolean {
  if (att.status !== 'ready') return false
  return Boolean(att.fileId?.trim())
}
