/**
 * 评论私有附件上传：presign → PUT → confirm。
 * 复用 IMAGE 校验与主进程 OSS PUT（与正文图上传同通道）。
 *
 * 注意：confirm 返回的 preview_url 是鉴权 API path，不能直接给 <img>。
 * 绑定消息前也无法换签，因此这里不返回 previewUrl，保留 composer 的 blob 预览。
 */
import type { AppHostClient } from '@tabtin/app-host-sdk'
import {
  confirmCommentAttachmentUpload,
  isSignedCommentPreviewUrl,
  presignCommentAttachmentUpload,
} from '@tabtin/tabdoc-ui/api-client'
import { validateUploadFile } from '@/constants/upload'
import { putPresignedObjectViaMainProcess } from '@/services/mainProcessOssUploader'
import { createLogger } from '@/utils/logger'

const log = createLogger('TabDocCommentAttachment')

export async function uploadCommentAttachmentImage(
  client: AppHostClient,
  documentId: string,
  file: File,
): Promise<{ fileId: string; previewUrl?: string }> {
  const validation = validateUploadFile(file, 'IMAGE')
  if (!validation.valid) {
    throw new Error(validation.reason ?? 'Image validation failed')
  }

  const startedAt = Date.now()
  log.info(`comment attachment upload start name=${file.name} size=${file.size} doc=${documentId}`)

  const credential = await presignCommentAttachmentUpload(client, documentId, {
    file_name: file.name,
    content_type: file.type || 'application/octet-stream',
    file_size: file.size,
  })

  if (!credential.upload_url || !credential.upload_token) {
    throw new Error('Comment attachment presign returned empty credential')
  }

  const contentType = credential.headers?.['Content-Type']
    || credential.headers?.['content-type']
    || file.type
    || 'application/octet-stream'

  const putResult = await putPresignedObjectViaMainProcess({
    presignedUrl: credential.upload_url,
    body: file,
    contentType,
  })

  if (putResult.status < 200 || putResult.status >= 300) {
    throw new Error(`Comment attachment PUT failed with status ${putResult.status}`)
  }

  const confirmed = await confirmCommentAttachmentUpload(
    client,
    documentId,
    credential.upload_token,
  )

  if (!confirmed.file_id) {
    throw new Error('Comment attachment confirm returned empty file_id')
  }

  log.info(
    `comment attachment upload done fileId=${confirmed.file_id} (${Date.now() - startedAt}ms)`,
  )

  // 仅当后端意外返回绝对签名 URL 时才透传；鉴权 path 留给线程刷新后 resolve。
  const previewUrl = isSignedCommentPreviewUrl(confirmed.preview_url)
    ? confirmed.preview_url
    : undefined

  return {
    fileId: confirmed.file_id,
    previewUrl,
  }
}
