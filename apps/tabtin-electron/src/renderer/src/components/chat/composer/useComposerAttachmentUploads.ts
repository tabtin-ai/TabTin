/**
 * useComposerAttachmentUploads — Composer 添加即上传。
 *
 * 附件一进 composer 就上传 OSS；发送路径只接受 status=ready 的附件，
 * 不再在 sendMessageAction 二次上传。
 * 每附件一把 AbortController，移除 / 卸载 / 清空时取消。
 */

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { uploadChatAttachment } from '@/services/chatAttachmentApi'
import { UploadAbortedError } from '@/services/oss-direct-uploader'
import type { ChatAttachment } from '../types'

export function isAttachmentStillUploading(att: ChatAttachment): boolean {
  return att.status === 'uploading'
    || (att.status === 'pending' && att.file instanceof File && att.file.size > 0)
}

function isReadyAttachmentMissingResource(att: ChatAttachment): boolean {
  return att.status === 'ready'
    && !att.fileId
    && (!(att.file instanceof File) || att.file.size === 0)
}

export function useComposerAttachmentUploads(
  attachments: ChatAttachment[],
  setAttachments: Dispatch<SetStateAction<ChatAttachment[]>>,
): {
  attachmentsUploading: boolean
  cancelUpload: (id: string) => void
  cancelAllUploads: () => void
} {
  const { t } = useTranslation('chat')
  const uploadControllersRef = useRef<Map<string, AbortController>>(new Map())

  const patchAttachment = useCallback((id: string, patch: Partial<ChatAttachment>) => {
    setAttachments(prev => prev.map(a => (a.id === id ? { ...a, ...patch } : a)))
  }, [setAttachments])

  const startAttachmentUpload = useCallback((att: ChatAttachment) => {
    // file_id 是跨 renderer / Host 的唯一资源身份；仅有 URL 不能替代上传完成。
    if (att.fileId) return
    if (!(att.file instanceof File) || att.file.size === 0) return
    if (uploadControllersRef.current.has(att.id)) return

    const controller = new AbortController()
    uploadControllersRef.current.set(att.id, controller)
    patchAttachment(att.id, { status: 'uploading', uploadProgress: 0, error: undefined })
    void uploadChatAttachment(att, controller.signal, (p) => {
      patchAttachment(att.id, { uploadProgress: p })
    })
      .then((uploaded) => {
        patchAttachment(att.id, {
          status: 'ready',
          uploadProgress: 1,
          fileId: uploaded.file_id,
          filename: uploaded.file_name || att.filename,
          mimeType: uploaded.file_type || att.mimeType,
          size: uploaded.file_size || att.size,
          remoteUrl: uploaded.cdn_url || uploaded.access_url,
        })
      })
      .catch((err) => {
        if (err instanceof UploadAbortedError) {
          // ：abort 后勿停留在 uploading 0%，否则重挂 effect 只认 pending 会永远卡住
          patchAttachment(att.id, {
            status: 'pending',
            uploadProgress: undefined,
            error: undefined,
          })
          return
        }
        patchAttachment(att.id, {
          status: 'error',
          error: err instanceof Error ? err.message : t('input.uploadFailed', { defaultValue: '上传失败' }),
        })
      })
      .finally(() => {
        uploadControllersRef.current.delete(att.id)
      })
  }, [patchAttachment, t])

  useEffect(() => {
    for (const att of attachments) {
      // 切页 stash/claim 后可能带着 fileId 但 status 仍是 uploading——直接收口为 ready
      if (att.fileId && att.status !== 'ready') {
        patchAttachment(att.id, {
          status: 'ready',
          uploadProgress: 1,
          error: undefined,
        })
        continue
      }
      if (isReadyAttachmentMissingResource(att)) {
        patchAttachment(att.id, {
          status: 'error',
          error: t('input.attachmentResourceMissing', {
            defaultValue: '附件缺少资源引用，请重新添加',
          }),
        })
        continue
      }
      const needsUpload = ((att.status === 'pending' || att.status === 'ready') && !att.fileId)
        || (
          att.status === 'uploading'
          && !uploadControllersRef.current.has(att.id)
        )
      if (
        needsUpload
        && att.file instanceof File
        && att.file.size > 0
        && !uploadControllersRef.current.has(att.id)
      ) {
        startAttachmentUpload(att)
      }
    }
  }, [attachments, patchAttachment, startAttachmentUpload, t])

  useEffect(() => {
    const controllers = uploadControllersRef.current
    return () => {
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
    }
  }, [])

  const cancelUpload = useCallback((id: string) => {
    const controller = uploadControllersRef.current.get(id)
    if (controller) {
      controller.abort()
      uploadControllersRef.current.delete(id)
    }
  }, [])

  const cancelAllUploads = useCallback(() => {
    for (const controller of uploadControllersRef.current.values()) controller.abort()
    uploadControllersRef.current.clear()
  }, [])

  const attachmentsUploading = attachments.some(isAttachmentStillUploading)

  return { attachmentsUploading, cancelUpload, cancelAllUploads }
}
