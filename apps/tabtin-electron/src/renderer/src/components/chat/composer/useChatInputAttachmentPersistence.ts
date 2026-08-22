import { useCallback, useEffect, useRef } from 'react'
import { usePendingComposerAttachmentsStore } from '@/stores/usePendingComposerAttachmentsStore'
import type { ChatAttachment } from '../types'

/**
 * ：Composer 卸载时把未发送附件 stash 进 pending store，重挂后由
 * useChatInputPendingAttachmentClaim 领取（与  /  文本草稿对称）。
 *
 * - 已有 fileId：视为 ready（避免 abort 后残留 uploading 0%）。
 * - 仍在上传且无 fileId：归一 pending，重挂后续传。
 * 不 revoke previewUrl——重挂仍要展示缩略图；真正丢弃走 clearScope / 用户移除。
 */
export function prepareAttachmentForStash(attachment: ChatAttachment): ChatAttachment {
  if (attachment.fileId) {
    if (attachment.status === 'ready' && attachment.uploadProgress === 1 && !attachment.error) {
      return attachment
    }
    return {
      ...attachment,
      status: 'ready',
      uploadProgress: 1,
      error: undefined,
    }
  }
  if (attachment.status !== 'uploading') return attachment
  return {
    ...attachment,
    status: 'pending',
    uploadProgress: undefined,
    error: undefined,
  }
}

export function resolveComposerAttachmentScopeId(
  presetScopeId: string | null | undefined,
  sessionId: string | null | undefined,
): string | null {
  return presetScopeId ?? sessionId ?? null
}

export function useChatInputAttachmentPersistence(
  scopeId: string | null,
  attachments: ChatAttachment[],
): { discardAttachmentDraft: () => void } {
  const attachmentsRef = useRef(attachments)
  const scopeIdRef = useRef(scopeId)
  attachmentsRef.current = attachments
  scopeIdRef.current = scopeId

  const discardAttachmentDraft = useCallback(() => {
    // 发送/清空时同步清掉 ref，避免紧接着卸载时 cleanup 把已发送附件又 enqueue 回去
    attachmentsRef.current = []
  }, [])

  useEffect(() => {
    return () => {
      const id = scopeIdRef.current
      const current = attachmentsRef.current
      if (!id || current.length === 0) return
      const store = usePendingComposerAttachmentsStore.getState()
      for (const attachment of current) {
        store.enqueue(id, prepareAttachmentForStash(attachment))
      }
    }
  }, [])

  return { discardAttachmentDraft }
}
