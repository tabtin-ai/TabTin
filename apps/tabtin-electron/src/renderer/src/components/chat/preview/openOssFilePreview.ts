/**
 * 按 file_id 打开 OSS 附件的应用内预览。
 *
 * 交接冻结快照里的 url 是生成时刻的下载地址（会过期），预览一律按
 * file_id 现场换新鲜 access_url（/services/oss/files/{id}，同 org 成员可读）。
 * 供交接查看弹窗 / HandoffCard 材料弹窗等「只有 file_id」的场景共用。
 */

import { toast } from '@tabtin/smartsheet-ui'
import { inferPreviewableKind } from './inferPreviewableKind'
import { resolveOssFileDetail } from './resolveOssFileAccessUrl'
import { useResourcePreviewStore } from './useResourcePreviewStore'
import type { PreviewResource } from './types'

export interface OpenOssFilePreviewMessages {
  /** 类型不支持预览时的 toast 文案 */
  unsupported: string
  /** 换链失败（无权限/已删除/网络）时的 toast 文案 */
  unavailable: string
}

/** 换链并打开预览；失败或类型不支持时 toast，不抛错。 */
export async function openOssFilePreviewById(
  fileId: string,
  messages: OpenOssFilePreviewMessages,
): Promise<void> {
  try {
    const detail = await resolveOssFileDetail(fileId)
    const kind = inferPreviewableKind(detail.mimeType, detail.fileName)
    if (!kind) {
      toast({ title: messages.unsupported })
      return
    }
    useResourcePreviewStore.getState().open([{
      id: `oss-file:${fileId}`,
      kind,
      url: detail.url,
      name: detail.fileName,
      mimeType: detail.mimeType,
      size: detail.fileSize,
      fileId,
    } as PreviewResource], 0)
  } catch {
    toast({ title: messages.unavailable, variant: 'destructive' })
  }
}
