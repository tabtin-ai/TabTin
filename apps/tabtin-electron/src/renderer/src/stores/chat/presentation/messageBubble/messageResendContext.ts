import type { ChatMessage } from '@tabtin/chat-client'
import type { SerializableAttachment } from '@stores/useChatRuntimeStore'
import type { ChatAttachment } from '@components/chat/types'
import { isFileContextRefBlock } from '@utils/chat/fileContextRefBlock'
import { isUserMediaBlock } from '@utils/chat/userMediaBlocks'
import { deriveUserAttachments } from '@utils/chat/userMessageAttachments'
import { deriveUserMessageDisplayContent } from '@utils/chat/messageDisplayContent'
import { isTextSummaryPlaceholder } from '@/utils/contentBlockSummary'

function dedupeContextBlocks(
  allBlocks: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> | undefined {
  const seen = new Set<string>()
  const dedupedBlocks = allBlocks.filter((block) => {
    const fileId = (block as { file_id?: string }).file_id
    const key = fileId || JSON.stringify(block)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return dedupedBlocks.length > 0 ? dedupedBlocks : undefined
}

function attachmentBlocksFromJson(
  attachmentsJson: ChatMessage['attachments_json'],
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = []
  if (!attachmentsJson || attachmentsJson.length === 0) return blocks
  for (const att of attachmentsJson) {
    if (!att.file_id) continue
    blocks.push({
      type: att.type,
      file_id: att.file_id,
      filename: att.filename,
      mime_type: att.mime_type,
      size: att.size,
      url: att.url,
      preview_url: att.preview_url,
    })
  }
  return blocks
}

function attachmentTypeForPrefill(
  type: string | undefined,
): SerializableAttachment['type'] {
  if (type === 'image' || type === 'video') return type
  return 'file'
}

function isUploadAttachmentBlock(block: Record<string, unknown>): boolean {
  if (block.type === 'document') return true
  if (!isUserMediaBlock(block)) return false
  return !isFileContextRefBlock(block)
}

function attachmentBlockFileId(block: Record<string, unknown>): string {
  const direct = typeof block.file_id === 'string' ? block.file_id.trim() : ''
  if (direct) return direct
  const source = block.source
  if (!source || typeof source !== 'object') return ''
  const sourceFileId = (source as { file_id?: unknown }).file_id
  return typeof sourceFileId === 'string' ? sourceFileId.trim() : ''
}

function attachmentBlockFilename(block: Record<string, unknown>): string {
  if (typeof block.filename === 'string' && block.filename.trim()) return block.filename
  if (typeof block.title === 'string' && block.title.trim()) return block.title
  return '附件'
}

function attachmentBlockHasUrl(block: Record<string, unknown>): boolean {
  if (typeof block.url === 'string' && block.url.trim()) return true
  const source = block.source
  if (!source || typeof source !== 'object') return false
  const sourceUrl = (source as { url?: unknown }).url
  return typeof sourceUrl === 'string' && sourceUrl.trim().length > 0
}

function attachmentIdentityKeys(
  attachment: NonNullable<ChatMessage['attachments_json']>[number],
): string[] {
  const keys: string[] = []
  const fileId = attachment.file_id?.trim()
  const url = attachment.url?.trim()
  const previewUrl = attachment.preview_url?.trim()
  if (fileId) keys.push(`file:${fileId}`)
  if (url) keys.push(`url:${url}`)
  if (previewUrl) keys.push(`url:${previewUrl}`)
  return keys
}

function attachmentBlockIdentityKeys(block: Record<string, unknown>): string[] {
  const keys: string[] = []
  const fileId = attachmentBlockFileId(block)
  const directUrl = typeof block.url === 'string' ? block.url.trim() : ''
  const previewUrl = typeof block.preview_url === 'string' ? block.preview_url.trim() : ''
  const source = block.source
  const sourceUrl = source && typeof source === 'object'
    && typeof (source as { url?: unknown }).url === 'string'
    ? (source as { url: string }).url.trim()
    : ''
  if (fileId) keys.push(`file:${fileId}`)
  if (directUrl) keys.push(`url:${directUrl}`)
  if (previewUrl) keys.push(`url:${previewUrl}`)
  if (sourceUrl) keys.push(`url:${sourceUrl}`)
  return keys
}

function hasRemovedIdentity(keys: string[], removedIdentities: ReadonlySet<string>): boolean {
  return keys.some(key => removedIdentities.has(key))
}

function collectRemovedAttachmentIdentities(
  message: ChatMessage,
  removedAttachmentKeys: ReadonlySet<string>,
  removedBlockIndices: ReadonlySet<number>,
): Set<string> {
  const removedIdentities = new Set<string>()
  for (const [index, attachment] of (message.attachments_json ?? []).entries()) {
    const key = attachment.file_id ?? `att-${index}-${attachment.filename}`
    if (!removedAttachmentKeys.has(key)) continue
    for (const identity of attachmentIdentityKeys(attachment)) removedIdentities.add(identity)
  }
  for (const [index, block] of (message.content_blocks_json ?? []).entries()) {
    const rawBlock = block as Record<string, unknown>
    if (!removedBlockIndices.has(index) || !isUploadAttachmentBlock(rawBlock)) continue
    for (const identity of attachmentBlockIdentityKeys(rawBlock)) removedIdentities.add(identity)
  }
  return removedIdentities
}

function toReadyChatAttachment(
  attachment: NonNullable<ChatMessage['attachments_json']>[number],
  index: number,
): ChatAttachment {
  const filename = attachment.filename || '附件'
  const fileId = attachment.file_id?.trim()
  const remoteUrl = attachment.url?.trim()
  return {
    id: fileId || remoteUrl || `original-${index}-${filename}`,
    file: new File([], filename),
    filename,
    mimeType: attachment.mime_type || '',
    size: attachment.size || 0,
    type: attachmentTypeForPrefill(attachment.type),
    status: 'ready',
    fileId: fileId || undefined,
    remoteUrl: remoteUrl || undefined,
    previewUrl: attachment.preview_url,
  }
}

function dedupeChatAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  const seen = new Set<string>()
  return attachments.filter((attachment) => {
    const key = attachment.fileId?.trim() || attachment.remoteUrl?.trim() || attachment.id
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export type EditResendMaterial = {
  attachments?: ChatAttachment[]
  contextBlocks?: Array<Record<string, unknown>>
  missingResourceNames: string[]
}

/** 编辑重发沿用普通发送的附件通道；只有真正的 ContextRef 留在 contextBlocks。 */
export function buildEditResendMaterial(
  message: ChatMessage,
  removedAttachmentKeys: ReadonlySet<string>,
  removedBlockIndices: ReadonlySet<number>,
  newAttachments: ChatAttachment[],
): EditResendMaterial {
  const removedIdentities = collectRemovedAttachmentIdentities(
    message,
    removedAttachmentKeys,
    removedBlockIndices,
  )

  const retainedAttachmentJson = (message.attachments_json ?? []).filter((attachment, index) => {
    const key = attachment.file_id ?? `att-${index}-${attachment.filename}`
    return !removedAttachmentKeys.has(key)
      && !hasRemovedIdentity(attachmentIdentityKeys(attachment), removedIdentities)
  })
  const retainedBlocks = (message.content_blocks_json ?? []).filter((block, index) => {
    if (removedBlockIndices.has(index)) return false
    const rawBlock = block as Record<string, unknown>
    return !isUploadAttachmentBlock(rawBlock)
      || !hasRemovedIdentity(attachmentBlockIdentityKeys(rawBlock), removedIdentities)
  })
  const originalAttachments = deriveUserAttachments(retainedAttachmentJson, retainedBlocks)
    .map(toReadyChatAttachment)
  const attachments = dedupeChatAttachments([...originalAttachments, ...newAttachments])
  const contextBlocks = retainedBlocks
    .filter((block) => {
      const rawBlock = block as Record<string, unknown>
      return block.type !== 'text' && !isUploadAttachmentBlock(rawBlock)
    })
    .map(block => block as Record<string, unknown>)
  const missingResourceNames = new Set(
    originalAttachments
      .filter(attachment => !attachment.fileId?.trim())
      .map(attachment => attachment.filename),
  )
  for (const block of retainedBlocks) {
    const rawBlock = block as Record<string, unknown>
    if (!isUploadAttachmentBlock(rawBlock)) continue
    if (attachmentBlockFileId(rawBlock) || attachmentBlockHasUrl(rawBlock)) continue
    missingResourceNames.add(attachmentBlockFilename(rawBlock))
  }

  return {
    attachments: attachments.length > 0 ? attachments : undefined,
    contextBlocks: contextBlocks.length > 0 ? contextBlocks : undefined,
    missingResourceNames: [...missingResourceNames],
  }
}

/** Regenerate / rewind：跳过 text block，与 MessageBubble handleRegenerate 一致。 */
export function buildResendContextBlocks(
  message: ChatMessage,
): Array<Record<string, unknown>> | undefined {
  const allBlocks: Array<Record<string, unknown>> = [
    ...attachmentBlocksFromJson(message.attachments_json),
  ]
  if (message.content_blocks_json && message.content_blocks_json.length > 0) {
    for (const block of message.content_blocks_json) {
      if (block.type === 'text') continue
      allBlocks.push(block as Record<string, unknown>)
    }
  }
  return dedupeContextBlocks(allBlocks)
}

/** SendStatusIndicator 重试：保留全部 content_blocks（含 text）。 */
export function buildSendRetryContextBlocks(
  attachmentsJson: ChatMessage['attachments_json'],
  blocksJson: ChatMessage['content_blocks_json'],
): Array<Record<string, unknown>> | undefined {
  try {
    const allBlocks: Array<Record<string, unknown>> = [
      ...attachmentBlocksFromJson(attachmentsJson),
    ]
    if (blocksJson && blocksJson.length > 0) {
      for (const block of blocksJson) {
        allBlocks.push(block as Record<string, unknown>)
      }
    }
    return dedupeContextBlocks(allBlocks)
  } catch {
    return undefined
  }
}

export function mapAttachmentsForPrefill(
  attachmentsJson: ChatMessage['attachments_json'],
): SerializableAttachment[] | undefined {
  if (!attachmentsJson || attachmentsJson.length === 0) return undefined
  const mapped = attachmentsJson
    .filter(att => att.file_id)
    .map(att => ({
      id: att.file_id!,
      filename: att.filename || '',
      mimeType: att.mime_type || '',
      size: att.size || 0,
      // ：保留 video，禁止塌成 file（否则预填后视频附件丢失 / 误入 ContextRef）
      type: attachmentTypeForPrefill(att.type),
      fileId: att.file_id,
      remoteUrl: att.url,
      previewUrl: att.preview_url,
    }))
  return mapped.length > 0 ? mapped : undefined
}

/**
 * Prefill 只恢复 ContextRef 类块。上传 media（image/file/video）走 attachments，
 * 避免带 file_id 的 video 块被 blockToContextRef 当 TabVideo 引用（要 video_id）而丢弃。
 */
export function mapBlocksForPrefill(
  blocksJson: ChatMessage['content_blocks_json'],
): Array<Record<string, unknown>> | undefined {
  if (!blocksJson || blocksJson.length === 0) return undefined
  const blocks = blocksJson
    .filter((block) => block?.type !== 'text' && !isUserMediaBlock(block))
    .map(b => b as Record<string, unknown>)
  return blocks.length > 0 ? blocks : undefined
}

/**
 * ：错误卡「重试」从用户消息还原可发送的 ChatAttachment。
 * 权威来源与气泡附件卡一致（attachments_json + content_blocks media）。
 * 已有 fileId/remoteUrl 标 ready，uploadAllAttachments 会跳过二次上传。
 */
export function mapMessageAttachmentsForRetry(
  message: ChatMessage,
): ChatAttachment[] | undefined {
  const media = deriveUserAttachments(
    message.attachments_json,
    message.content_blocks_json ?? [],
  )
  if (media.length === 0) return undefined
  const mapped: ChatAttachment[] = []
  for (const att of media) {
    const remoteUrl = (att.url || att.preview_url || '').trim()
    const fileId = (att.file_id || '').trim()
    if (!remoteUrl && !fileId) continue
    const filename = att.filename || '附件'
    const type = attachmentTypeForPrefill(att.type)
    mapped.push({
      id: fileId || remoteUrl,
      file: new File([], filename),
      filename,
      mimeType: att.mime_type || '',
      size: typeof att.size === 'number' ? att.size : 0,
      type,
      status: 'ready',
      fileId: fileId || undefined,
      remoteUrl: remoteUrl || undefined,
      previewUrl: att.preview_url,
    })
  }
  return mapped.length > 0 ? mapped : undefined
}

/**
 * ：错误卡重试的可见正文——只读 content_blocks text，且拒绝摘要占位
 * （`[富内容]` / `[工具调用]` / `[思考中]`），避免把投影字段当用户话重发。
 */
export function resolveRetrySendContent(message: ChatMessage): string {
  const fromBlocks = deriveUserMessageDisplayContent(message).trim()
  if (fromBlocks && !isTextSummaryPlaceholder(fromBlocks)) return fromBlocks
  const raw = typeof message.content === 'string' ? message.content.trim() : ''
  if (raw && !isTextSummaryPlaceholder(raw)) return raw
  return ''
}
