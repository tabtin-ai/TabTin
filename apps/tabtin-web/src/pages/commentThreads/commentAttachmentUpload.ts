/**
 * 分享页评论私有附件：presign → browser PUT → confirm → 解析短时预览。
 */
import type { AppHostClient } from '@tabtin/app-host-sdk'
import {
  confirmSharedCommentAttachmentUpload,
  isSignedCommentPreviewUrl,
  presignSharedCommentAttachmentUpload,
  resolveSharedCommentAttachmentPreview,
} from '@tabtin/tabdoc-ui/api-client'
import { validateShareCommentImage } from './validateShareCommentImage'

export { validateShareCommentImage } from './validateShareCommentImage'

export async function uploadShareCommentAttachmentImage(
  client: AppHostClient,
  shareId: string,
  file: File,
  password?: string,
): Promise<{ fileId: string; previewUrl?: string }> {
  const validation = validateShareCommentImage(file)
  if (!validation.valid) {
    throw new Error(validation.reason ?? 'Image validation failed')
  }

  const credential = await presignSharedCommentAttachmentUpload(client, shareId, {
    file_name: file.name,
    content_type: file.type || 'application/octet-stream',
    file_size: file.size,
    password,
  })

  if (!credential.upload_url || !credential.upload_token) {
    throw new Error('Comment attachment presign returned empty credential')
  }

  const contentType = credential.headers?.['Content-Type']
    || credential.headers?.['content-type']
    || file.type
    || 'application/octet-stream'

  const putResp = await fetch(credential.upload_url, {
    method: (credential.method || 'PUT').toUpperCase(),
    headers: {
      'Content-Type': contentType,
      ...credential.headers,
    },
    body: file,
  })

  if (!putResp.ok) {
    throw new Error(`Comment attachment PUT failed with status ${putResp.status}`)
  }

  const confirmed = await confirmSharedCommentAttachmentUpload(
    client,
    shareId,
    credential.upload_token,
    password,
  )

  if (!confirmed.file_id) {
    throw new Error('Comment attachment confirm returned empty file_id')
  }

  // 绑定前无法换签；鉴权 path 不能给 <img>，留给 composer blob / 线程刷新 resolve
  let previewUrl: string | undefined
  try {
    const signed = await resolveSharedCommentAttachmentPreview(
      client,
      shareId,
      confirmed.file_id,
      password,
    )
    if (isSignedCommentPreviewUrl(signed)) previewUrl = signed
  } catch {
    // 预览解析失败不挡上传成功；线程卡仍可稍后刷新
  }

  return {
    fileId: confirmed.file_id,
    previewUrl,
  }
}
