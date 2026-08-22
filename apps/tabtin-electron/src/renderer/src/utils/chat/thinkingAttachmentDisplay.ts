import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import { readMessageBlocks } from '@components/chat/blocks/messageContentBlocks'
import { isFileContextRefBlock } from './fileContextRefBlock'

type AttachmentIdentityBlock = {
  type?: string
  file_id?: string
  filename?: string
  title?: string
  source?: {
    type?: string
    file_id?: string
  }
}

const EMPTY_FILENAME_BY_ID: ReadonlyMap<string, string> = new Map()
const filenameMapCache = new WeakMap<readonly ChatMessage[], ReadonlyMap<string, string>>()

function normalizeDisplayValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized || null
}

function isAttachmentIdentityBlock(block: unknown): block is AttachmentIdentityBlock {
  if (!block || typeof block !== 'object') return false
  const type = (block as { type?: unknown }).type
  return (
    type === 'file'
    || type === 'image'
    || type === 'video'
    || type === 'document'
  )
}

/**
 * 收集用户上传附件的展示身份。
 *
 * `file_id` 仍是模型与工具调用的稳定身份；这里只建立展示层映射，不修改消息原文。
 * 历史消息以 `message.blocks` 为 SSoT，`attachments_json` 仅覆盖本地乐观消息阶段。
 */
export function collectAttachmentFilenameById(
  messages: readonly ChatMessage[] | null | undefined,
): ReadonlyMap<string, string> {
  if (!messages) return EMPTY_FILENAME_BY_ID
  const cached = filenameMapCache.get(messages)
  if (cached) return cached

  const filenames = new Map<string, string>()

  const remember = (fileIdValue: unknown, filenameValue: unknown): void => {
    const fileId = normalizeDisplayValue(fileIdValue)
    const filename = normalizeDisplayValue(filenameValue)
    if (fileId && filename) filenames.set(fileId, filename)
  }

  for (const message of messages) {
    if (message.role !== 'user') continue

    for (const attachment of message.attachments_json ?? []) {
      remember(attachment.file_id, attachment.filename)
    }

    for (const block of readMessageBlocks(message)) {
      if (!isAttachmentIdentityBlock(block) || isFileContextRefBlock(block)) continue
      const fileId = block.file_id ?? block.source?.file_id
      const filename = block.filename ?? block.title
      remember(fileId, filename)
    }
  }

  filenameMapCache.set(messages, filenames)
  return filenames
}

/** 将 Thinking 中已知的附件 ID 投影为文件名；未知或缺少文件名的 ID 原样保留。 */
export function projectThinkingTextForDisplay(
  thinkingText: string,
  filenames: ReadonlyMap<string, string>,
): string {
  let displayText = thinkingText
  // 长 ID 优先，避免极端情况下一个 ID 是另一个 ID 的前缀而被提前替换。
  const entries = [...filenames.entries()].sort(([left], [right]) => right.length - left.length)
  for (const [fileId, filename] of entries) {
    if (fileId === filename || !displayText.includes(fileId)) continue
    displayText = displayText.split(fileId).join(filename)
  }
  return displayText
}

/**
 * 在 assistant 时间轴进入渲染前复制发生变化的附件相关 block。
 * 覆盖 Thinking 文本、parse_document 步骤和 document_excerpt 标题；未命中
 * 附件 ID 的 entry 保持原引用，避免无意义重渲染。
 */
export function projectAttachmentBlocksForDisplay(
  blocks: ContentBlockEntry[],
  filenames: ReadonlyMap<string, string>,
): ContentBlockEntry[] {
  if (filenames.size === 0) return blocks

  let changed = false
  const projected = blocks.map((entry) => {
    const block = entry.block as {
      type?: string
      thinking?: string
      name?: string
      input?: unknown
      kind?: string
      payload?: unknown
      file_id?: string
      filename?: string
    }

    let displayBlock: typeof block | null = null

    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      const displayThinking = projectThinkingTextForDisplay(block.thinking, filenames)
      if (displayThinking !== block.thinking) {
        displayBlock = { ...block, thinking: displayThinking }
      }
    }

    if (
      block.type === 'tool_use'
      && block.name === 'parse_document'
      && block.input
      && typeof block.input === 'object'
    ) {
      const input = block.input as Record<string, unknown>
      const fileId = normalizeDisplayValue(input.file_id)
      const filename = fileId ? filenames.get(fileId) : undefined
      if (filename) {
        displayBlock = { ...block, input: { ...input, filename } }
      }
    }

    if (
      block.type === 'tabtin_rich_content'
      && block.kind === 'document_excerpt'
      && block.payload
      && typeof block.payload === 'object'
    ) {
      const payload = block.payload as Record<string, unknown>
      const fileId = normalizeDisplayValue(payload.file_id)
      const filename = fileId ? filenames.get(fileId) : undefined
      if (filename) {
        displayBlock = { ...block, payload: { ...payload, filename } }
      }
    }

    if (block.type === 'rich_content' && block.kind === 'document_excerpt') {
      const fileId = normalizeDisplayValue(block.file_id)
      const filename = fileId ? filenames.get(fileId) : undefined
      if (filename) {
        displayBlock = { ...block, filename }
      }
    }

    if (!displayBlock) return entry

    changed = true
    return {
      ...entry,
      block: displayBlock,
    } as ContentBlockEntry
  })

  return changed ? projected : blocks
}
