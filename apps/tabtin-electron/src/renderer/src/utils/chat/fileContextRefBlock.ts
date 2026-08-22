/**
 * ：云盘 / TabFiles ContextRef（type=file + file_id + preview）
 * 与聊天上传附件（同 type=file，但带 filename/size/url/source）共用线格式。
 * 判别与  video /  document 门控同构，供气泡 ContextRef 与附件投影共用。
 */

export type FileContextRefLike = {
  type?: string
  file_id?: unknown
  filename?: unknown
  size?: unknown
  url?: unknown
  source?: { type?: string; url?: string; data?: string } | null
  preview?: unknown
}

function hasAttachmentUrlSource(source: FileContextRefLike['source']): boolean {
  if (!source || typeof source !== 'object') return false
  if (source.type === 'url' && typeof source.url === 'string' && source.url.length > 0) {
    return true
  }
  if (source.type === 'base64' && typeof source.data === 'string' && source.data.length > 0) {
    return true
  }
  return false
}

/** 上传附件形态：有文件名 / 正 size / 可访问 url（扁平或 source） */
export function isChatFileAttachmentBlock(block: FileContextRefLike): boolean {
  if (block.type !== 'file') return false
  if (typeof block.filename === 'string' && block.filename.length > 0) return true
  if (typeof block.size === 'number' && block.size > 0) return true
  if (typeof block.url === 'string' && block.url.length > 0) return true
  return hasAttachmentUrlSource(block.source)
}

/**
 * 云盘等「添加到对话」文件引用：有 file_id，且不具备附件字段。
 * （encode 侧写 preview / tab_type，不写 filename/size/url）
 */
export function isFileContextRefBlock(block: FileContextRefLike): boolean {
  if (block.type !== 'file') return false
  const fileId = block.file_id
  if (typeof fileId !== 'string' || fileId.length === 0) return false
  return !isChatFileAttachmentBlock(block)
}
