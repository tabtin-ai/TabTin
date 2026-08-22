const ACTIVE_UPLOAD_STATUSES = new Set(['pending', 'uploading'])

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

const isTransientAttachmentOverlay = (value: unknown): boolean => {
  if (!isRecordValue(value)) {
    return false
  }

  if (
    value.__uploading === true ||
    value.uploading === true ||
    value.__local_upload_overlay === true ||
    value.localUploadOverlay === true
  ) {
    return true
  }

  const status = value.upload_status ?? value.uploadStatus
  return typeof status === 'string' && ACTIVE_UPLOAD_STATUSES.has(status)
}

/** Removes attachment values that exist only to render local upload progress. */
export const sanitizeAttachmentValueForPersistence = (value: unknown): unknown => {
  if (!Array.isArray(value)) {
    return isTransientAttachmentOverlay(value) ? null : value
  }

  if (value.length === 0) {
    return value
  }

  const persistedItems = value.filter((item) => !isTransientAttachmentOverlay(item))
  return persistedItems.length > 0 ? persistedItems : null
}

/** A transient-only edit is a display update, not a record update. */
export const isTransientAttachmentValueOnly = (value: unknown): boolean => {
  const items = Array.isArray(value) ? value : value == null ? [] : [value]
  return items.length > 0 && items.every(isTransientAttachmentOverlay)
}
