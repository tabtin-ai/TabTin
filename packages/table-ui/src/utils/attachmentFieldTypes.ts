export const ATTACHMENT_FIELD_TYPE = 'attachment'

export const normalizeFieldType = (fieldType: unknown): string =>
  typeof fieldType === 'string' ? fieldType.trim().toLowerCase() : ''

export const isAttachmentFieldType = (fieldType: unknown): boolean =>
  normalizeFieldType(fieldType) === ATTACHMENT_FIELD_TYPE

/** 看板 / 画廊「卡片封面」可选字段：仅附件（不含 URL / 文本等）。 */
export const isViewCoverFieldType = (fieldType: unknown): boolean =>
  isAttachmentFieldType(fieldType)
