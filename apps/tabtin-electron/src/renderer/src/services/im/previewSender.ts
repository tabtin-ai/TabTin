const MAX_PREVIEW_LENGTH = 200
const MAX_SENDER_NAME_LENGTH = 18

/** 为会话摘要统一补发送者，并保持摘要总长度上限。 */
export function prependPreviewSender(preview: string, senderName?: string): string {
  const normalizedName = senderName?.trim()
  if (!normalizedName) return preview.slice(0, MAX_PREVIEW_LENGTH)
  const namePart = normalizedName.slice(0, MAX_SENDER_NAME_LENGTH)
  const prefix = `${namePart}: `
  return `${prefix}${preview.slice(0, MAX_PREVIEW_LENGTH - prefix.length)}`
}
