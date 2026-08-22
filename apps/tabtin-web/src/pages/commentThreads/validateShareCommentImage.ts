/** 与后端 IMAGE preset 默认对齐（20MB）；最终仍以后端校验为准 */
export const MAX_SHARE_COMMENT_IMAGE_BYTES = 20 * 1024 * 1024

function isImageFile(file: File): boolean {
  const mime = (file.type || '').split(';', 1)[0].trim().toLowerCase()
  if (mime.startsWith('image/')) return true
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name || '')
}

export function validateShareCommentImage(file: File): { valid: boolean; reason?: string } {
  if (!isImageFile(file)) {
    return { valid: false, reason: '仅支持图片附件' }
  }
  if (file.size <= 0) {
    return { valid: false, reason: '图片为空' }
  }
  if (file.size > MAX_SHARE_COMMENT_IMAGE_BYTES) {
    return { valid: false, reason: '图片超过 20MB 上限' }
  }
  return { valid: true }
}
