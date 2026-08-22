/**
 * TabChat 附件上传服务
 *
 * 基于统一 OSS 直传服务（oss-direct-uploader）+ 统一上传预设，
 * 提供 IM 特定的类型映射、校验和格式化工具。
 */

import { joinApiPath } from '@tabtin/config'
import { API_CONFIG } from '@/config/api'
import { apiRequest, unwrapData } from '@/services/apiBase'
import { directUpload } from './oss-direct-uploader'
import {
  validateUploadFile,
  isImageMime,
  isMediaMime,
  formatFileSize as _formatFileSize,
} from '@/constants/upload'
import type { MessageAttachmentDownloadUrl } from './im/contracts'

export interface IMAttachmentResult {
  file_id: string
  file_name: string
  file_size: number
  file_type: string
  image_width?: number
  image_height?: number
  access_url: string
  cdn_url: string
}

async function readImageDimensions(file: File): Promise<{
  image_width: number
  image_height: number
} | undefined> {
  if (!isImageMime(file.type) || typeof createImageBitmap !== 'function') return undefined

  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(file)
    if (!Number.isSafeInteger(bitmap.width) || bitmap.width <= 0
      || !Number.isSafeInteger(bitmap.height) || bitmap.height <= 0) {
      return undefined
    }
    return {
      image_width: bitmap.width,
      image_height: bitmap.height,
    }
  } catch {
    return undefined
  } finally {
    bitmap?.close()
  }
}

/**
 * 上传 IM 附件到 OSS
 *
 * @param onProgress 上传进度回调 (0-1)
 */
export async function uploadIMAttachment(
  file: File,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
  contextId?: string,
): Promise<IMAttachmentResult> {
  const validation = validateFile(file)
  if (!validation.valid) {
    throw new Error(validation.reason ?? 'File validation failed')
  }
  const [result, imageDimensions] = await Promise.all([
    directUpload(file, file.name, {
      folder: 'im/attachments',
      module: 'tabchat',
      contextType: 'im_message',
      contextId: contextId || `im_upload_${Date.now()}`,
      isPublic: true,
      onProgress,
      signal,
    }),
    readImageDimensions(file),
  ])
  return {
    file_id: result.fileId,
    file_name: result.fileName,
    file_size: result.fileSize,
    file_type: file.type,
    ...imageDimensions,
    access_url: result.accessUrl,
    cdn_url: result.cdnUrl,
  }
}

/**
 * IM 附件走 TabTin OSS（上传时 isPublic=true）。按 file_id 换取当前可用下载 URL。
 */
export async function resolveIMAttachmentDownloadUrl(input: {
  fileId: string
  fileName: string
  conversationId: string
}): Promise<MessageAttachmentDownloadUrl> {
  void input.conversationId
  const fileId = input.fileId.trim()
  const fileName = input.fileName.trim()
  if (!fileId || !fileName) {
    throw new Error('IM attachment requires file_id and file_name')
  }

  const expiresIn = 3600
  const response = await apiRequest({
    url: joinApiPath(API_CONFIG.baseURL, '/services/oss/presigned-url'),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_id: fileId,
      method: 'GET',
      expiration: expiresIn,
    }),
  })
  const data = unwrapData<{
    presigned_url?: string
    expiration?: number
  }>(response, 'Failed to resolve IM attachment URL')
  const downloadUrl = data.presigned_url
  if (typeof downloadUrl !== 'string' || !downloadUrl.trim()) {
    throw new Error('Failed to resolve IM attachment URL')
  }
  return {
    download_url: downloadUrl.trim(),
    file_name: fileName,
    expires_in: Number.isSafeInteger(data.expiration)
      ? Number(data.expiration)
      : expiresIn,
  }
}

export function isImageFile(file: File): boolean {
  return isImageMime(file.type)
}

/** 校验 IM 文件：图片走 IMAGE 预设，媒体走 MEDIA 预设，其他走 FILE 预设 */
export function validateFile(file: File): { valid: boolean; reason?: string } {
  const preset = isImageMime(file.type) ? 'IMAGE' : isMediaMime(file.type) ? 'MEDIA' : 'FILE'
  return validateUploadFile(file, preset)
}

export const formatFileSize = _formatFileSize
