import { useCallback } from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import {
  createAttachment,
  revokeAttachmentPreview,
  FILE_LIMITS,
  type ChatAttachment,
} from '../types'
import { validateUploadFile, isImageMime, isMediaMime } from '@/constants/upload'
import { useComposerAttachmentUploads } from './useComposerAttachmentUploads'

export function useChatInputAttachments(
  attachments: ChatAttachment[],
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>,
) {
  const { t } = useTranslation('chat')
  const {
    attachmentsUploading,
    cancelUpload,
    cancelAllUploads,
  } = useComposerAttachmentUploads(attachments, setAttachments)

  const addFiles = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files).filter(f => !(f.size === 0 && f.type === ''))
    if (fileArray.length === 0) return

    // React Strict Mode 会在开发环境重复执行 state updater。通知属于副作用，
    // 必须按一次用户选择去重，不能跟着 updater 执行次数重复弹出。
    let notificationsScheduled = false
    setAttachments(prev => {
      const remaining = FILE_LIMITS.MAX_ATTACHMENTS - prev.length
      const imageLimitReached = fileArray
        .slice(Math.max(remaining, 0))
        .some(file => isImageMime(file.type))

      if (remaining <= 0) {
        if (!notificationsScheduled && imageLimitReached) {
          notificationsScheduled = true
          queueMicrotask(() => {
            toast.warning(t('input.imageLimitReached', {
              defaultValue: '最多添加10张图片',
            }))
          })
        }
        return prev
      }

      const rejected: Array<{ name: string; reason: string }> = []
      const newAttachments: ChatAttachment[] = []
      const selectedFiles = fileArray.slice(0, remaining)
      for (const file of selectedFiles) {
        const preset = isImageMime(file.type) ? 'IMAGE' as const : isMediaMime(file.type) ? 'MEDIA' as const : 'FILE' as const
        const validation = validateUploadFile(file, preset)
        if (!validation.valid) {
          const reason = validation.reason?.startsWith('fileTooLarge:')
            ? t('input.fileTooLarge', { limit: validation.reason.split(':')[1], defaultValue: '超过 {{limit}}MB 大小限制' })
            : t('input.fileTypeNotAllowed', { defaultValue: '不支持的文件类型' })
          rejected.push({ name: file.name, reason })
          continue
        }
        const attachment = createAttachment(file)
        newAttachments.push(attachment)
      }

      if (!notificationsScheduled) {
        notificationsScheduled = true
        if (imageLimitReached) {
          queueMicrotask(() => {
            toast.warning(t('input.imageLimitReached', {
              defaultValue: '最多添加10张图片',
            }))
          })
        }

        if (rejected.length > 0) {
          queueMicrotask(() => {
            const summary = rejected.length === 1
              ? t('input.fileRejectedSingle', {
                  name: rejected[0].name,
                  reason: rejected[0].reason,
                  defaultValue: '文件 {{name}} 被跳过：{{reason}}',
                })
              : t('input.fileRejectedMultiple', {
                  count: rejected.length,
                  defaultValue: '{{count}} 个文件被跳过',
                })
            const description = rejected.length > 1
              ? rejected.map(r => `${r.name}：${r.reason}`).join('\n')
              : undefined
            toast.warning(summary, description ? { description } : undefined)
          })
        }
      }

      return [...prev, ...newAttachments]
    })
  }, [setAttachments, t])

  const removeAttachment = useCallback((id: string) => {
    cancelUpload(id)
    setAttachments(prev => {
      const target = prev.find(a => a.id === id)
      if (target) revokeAttachmentPreview(target)
      return prev.filter(a => a.id !== id)
    })
  }, [cancelUpload, setAttachments])

  return {
    attachmentsUploading,
    cancelAllUploads,
    addFiles,
    removeAttachment,
  }
}
