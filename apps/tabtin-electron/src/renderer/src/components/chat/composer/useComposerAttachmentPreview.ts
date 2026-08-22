/**
 * useComposerAttachmentPreview — Composer 附件（发送前）预览逻辑。
 *
 * ChatInput.AttachmentPreview 与 UserMessageEditMode.EditAttachmentPreview 共用。
 *
 *  / ：添加即上传完成前，composer 阶段非图片附件可能尚无 remoteUrl/fileId
 *（createAttachment 只给图片建 blob）。因此对可预览的非图片，这里用手上的原始 File
 * 就地建本地 blob URL——
 * 预览栈全链路客户端渲染（pdf.js / docx-preview / xlsx / tabslide / CsvViewer /
 * TextFileEditor / MarkdownViewer，数据经 `getAttachmentBuffer` fetch(url) 取
 * ArrayBuffer），blob URL 直接可用，无服务端依赖。
 *
 * 刻意**不**在 createAttachment 里为非图片补 previewUrl：sendMessageAction 会把
 * attachment.previewUrl 序列化进消息 attachments_json 的 preview_url，短命 blob URL
 * 一旦落库/传给后端，刷新后就是死链。本 hook 的 blob URL 只活在预览组件生命周期内，
 * 卸载即 revoke，不流入发送链路。
 *
 * 不可预览类型（如 .zip）：仍可点击（与可预览附件同款 hover），toast「暂不支持预览」。
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import { useResourcePreviewStore } from '../preview/useResourcePreviewStore'
import { inferPreviewableKind } from './AttachmentCard'
import type { PreviewResourceKind } from '../preview/types'
import type { ChatAttachment } from '../types'

interface ComposerAttachmentPreview {
  previewKind: PreviewResourceKind | null
  previewUrl: string | undefined
  /** 是否可点击（含不可预览类型的 toast 反馈） */
  canPreview: boolean
  handlePreview: () => void
}

export function useComposerAttachmentPreview(attachment: ChatAttachment): ComposerAttachmentPreview {
  const { t } = useTranslation('chat')
  const openPreview = useResourcePreviewStore(s => s.open)
  const isImage = attachment.type === 'image'
  const previewKind = inferPreviewableKind(attachment.mimeType, attachment.filename)
    ?? (isImage ? 'image' : null)

  // 已有 URL（图片 blob / 上传完成的 remoteUrl）时不建本地 blob。
  // prefill 恢复的附件 file 是空壳（new File([], name)，size 0），内容不在本地，
  // 不能拿它建 blob——这类附件靠 remoteUrl（ready 态），否则保持不可预览。
  const needLocalBlob = Boolean(previewKind)
    && !attachment.previewUrl
    && !attachment.remoteUrl
    && attachment.file instanceof File
    && attachment.file.size > 0

  const [localBlobUrl, setLocalBlobUrl] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!needLocalBlob) {
      setLocalBlobUrl(undefined)
      return
    }
    const url = URL.createObjectURL(attachment.file)
    setLocalBlobUrl(url)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [attachment.file, needLocalBlob])

  const previewUrl = attachment.previewUrl || attachment.remoteUrl || localBlobUrl
  const canOpenLightbox = Boolean(previewKind) && Boolean(previewUrl)
  // 非图片一律可点（不支持则 toast）；图片仍要有可预览 URL
  const canPreview = isImage ? canOpenLightbox : true

  const handlePreview = useCallback(() => {
    if (canOpenLightbox && previewUrl && previewKind) {
      openPreview([{
        id: `composer:${attachment.id}`,
        kind: previewKind,
        url: previewUrl,
        name: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        fileId: attachment.fileId,
      }])
      return
    }
    toast({
      title: t('preview.typeUnsupported', {
        defaultValue: '暂不支持预览此类型文件',
      }),
    })
  }, [
    attachment.fileId,
    attachment.filename,
    attachment.id,
    attachment.mimeType,
    attachment.size,
    canOpenLightbox,
    openPreview,
    previewKind,
    previewUrl,
    t,
  ])

  return { previewKind, previewUrl, canPreview, handlePreview }
}
