type UserMessageAttachment = {
  type?: string
  file_id?: string
  filename?: string
  mime_type?: string
  size?: number
  url?: string
  preview_url?: string
}

export function buildAttachmentMessageBlocks(
  attachments: UserMessageAttachment[] | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!attachments || attachments.length === 0) return undefined

  return attachments.map(a => ({
    type: a.type,
    file_id: a.file_id,
    filename: a.filename,
    mime_type: a.mime_type,
    size: a.size,
    url: a.url,
    preview_url: a.preview_url,
  }))
}
