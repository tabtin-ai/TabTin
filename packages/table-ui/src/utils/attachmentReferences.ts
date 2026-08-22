import type { AttachmentReference } from '@tabtin/table-core'

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i

/**
 * mime / 扩展名可判定为图片 → true；明确非图片 → false；未知 → null。
 * 对齐网格 `isLikelyImageAsset`：上传链路常把真实图片标成 application/octet-stream，
 * 必须先信文件名扩展名，再硬拒 pdf/xlsx 等非图 mime。
 */
export const classifyCoverImageHint = (
  mimeType?: string | null,
  name?: string | null,
): boolean | null => {
  const mime = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : ''
  const fileName = typeof name === 'string' ? name.trim() : ''

  if (mime.startsWith('image/')) return true
  // 少数链路把扩展名塞进 type
  if (mime && IMAGE_EXT_RE.test(mime)) return true
  // 文件名已标明是图片：覆盖 octet-stream 等错误 mime（ 回归）
  if (fileName && IMAGE_EXT_RE.test(fileName)) return true
  // 明确非图片 mime（pdf/xlsx/…）且文件名也不是图片
  if (mime.includes('/')) return false
  if (fileName) return null
  return null
}

const pickCoverUrlFromRef = (ref: AttachmentReference): string | null => {
  const thumb =
    ref.thumbnail_url
    ?? ref.lgThumbnailUrl
    ?? ref.smThumbnailUrl
    ?? null
  if (thumb) return thumb

  const imageHint = classifyCoverImageHint(ref.mime_type, ref.name)
  // 明确非图片且无缩略图：不要把 PDF/docx 原文件 URL 塞进 <img>
  if (imageHint === false) return null

  return ref.preview_url ?? ref.url ?? null
}

/**
 * 从看板 / 画廊封面字段值提取可展示的图片 URL。
 * 兼容：纯字符串 URL、附件对象或数组（优先缩略图）。
 * 非图片附件（有 mime）且无缩略图时返回 null，避免裂图。
 */
export const extractViewCoverUrl = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim()) {
    return value[0].trim()
  }

  const refs = normalizeAttachmentReferences(value)
  for (const ref of refs) {
    const url = pickCoverUrlFromRef(ref)
    if (url) return url
  }
  return null
}

export const normalizeAttachmentReferences = (value: unknown): AttachmentReference[] => {
  const rawItems = Array.isArray(value) ? value : value == null ? [] : [value]
  return rawItems.flatMap((item): AttachmentReference[] => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const referenceId = pickString(record, ['reference_id', 'id', 'file_id', 'token'])
    const fileId = pickString(record, ['file_id', 'id', 'token']) ?? referenceId
    const url = pickString(record, ['url', 'presignedUrl', 'access_url', 'accessUrl', 'download_url', 'downloadUrl'])
    const name = pickString(record, ['name', 'file_name', 'fileName', 'filename', 'title']) ?? fileId ?? url
    const sizeValue = record.size
    // 勿把业务字段 `type`（如 "file"）当成 mime，避免误伤封面判定
    const mimeType = pickString(record, ['mime_type', 'mimeType', 'mimetype'])
    const stableId = referenceId ?? fileId ?? url ?? name

    if (!stableId) return []

    return [{
      reference_id: referenceId ?? stableId,
      file_id: fileId ?? stableId,
      table_id: pickString(record, ['table_id', 'tableId']),
      field_id: pickString(record, ['field_id', 'fieldId']),
      record_id: pickString(record, ['record_id', 'recordId']),
      name: name ?? stableId,
      url,
      size: typeof sizeValue === 'number' ? sizeValue : undefined,
      mime_type: mimeType,
      thumbnail_url: pickString(record, ['thumbnail_url', 'thumbnailUrl']),
      smThumbnailUrl: pickString(record, ['smThumbnailUrl']),
      lgThumbnailUrl: pickString(record, ['lgThumbnailUrl']),
      preview_url: pickString(record, ['preview_url', 'previewUrl']),
    }]
  })
}

export const filterCurrentFieldAttachments = (
  attachments: AttachmentReference[],
  fieldId: string,
): AttachmentReference[] =>
  attachments.filter((attachment) => !attachment.field_id || attachment.field_id === fieldId)

export const findUniqueAttachmentNameMatch = (
  candidates: AttachmentReference[],
  name: string | undefined,
): AttachmentReference | undefined => {
  if (!name) return undefined
  const matches = candidates.filter((candidate) => candidate.name === name)
  return matches.length === 1 ? matches[0] : undefined
}

export const buildAttachmentKeyCounts = (items: AttachmentReference[]): Map<string, number> => {
  const counts = new Map<string, number>()
  items.forEach((item, index) => {
    getAttachmentIdentityKeys(item, index).forEach((key) => {
      counts.set(key, (counts.get(key) ?? 0) + 1)
    })
  })
  return counts
}

export const consumeAttachmentKeyCount = (
  counts: Map<string, number>,
  item: AttachmentReference,
  fallbackIndex: number,
): boolean => {
  for (const key of getAttachmentIdentityKeys(item, fallbackIndex)) {
    const count = counts.get(key) ?? 0
    if (count > 0) {
      counts.set(key, count - 1)
      return true
    }
  }
  return false
}

export const enrichAttachmentReferences = (
  base: AttachmentReference[],
  authoritative: AttachmentReference[],
): AttachmentReference[] => {
  const authoritativeByKey = new Map<string, AttachmentReference>()
  authoritative.forEach((item, index) => {
    getAttachmentIdentityKeys(item, index).forEach((key) => {
      authoritativeByKey.set(key, item)
    })
  })

  return base.map((item, index) => {
    for (const key of getAttachmentIdentityKeys(item, index)) {
      const authoritativeItem = authoritativeByKey.get(key)
      if (authoritativeItem) {
        return authoritativeItem
      }
    }
    return item
  })
}

const pickString = (record: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

const getAttachmentIdentityKeys = (item: AttachmentReference | any, fallbackIndex: number): string[] => {
  if (!item) return [`unknown-${fallbackIndex}`]
  const rawKeys = [
    item.reference_id,
    item.file_id,
    item.id,
    item.token,
    item.url,
    item.presignedUrl,
    item.access_url,
    item.accessUrl,
    item.download_url,
    item.downloadUrl,
  ]
  const keys = Array.from(new Set(
    rawKeys.filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
      .map(key => key.trim()),
  ))
  if (keys.length > 0) return keys
  return typeof item.name === 'string' && item.name.trim()
    ? [`name:${item.name.trim()}`]
    : [`unknown-${fallbackIndex}`]
}
