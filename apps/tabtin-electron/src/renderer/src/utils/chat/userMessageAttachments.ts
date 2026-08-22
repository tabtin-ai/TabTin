import type { MessageAttachment, MessageBlock } from '@tabtin/chat-client'
import { isFileContextRefBlock } from './fileContextRefBlock'

type AttachmentMediaBlock = MessageBlock & {
  type: 'file' | 'image' | 'video' | 'document'
  file_id?: string
  filename?: string
  title?: string
  mime_type?: string
  size?: number
  url?: string
  preview_url?: string
  source?: {
    type?: string
    url?: string
    file_id?: string
    media_type?: string
    data?: string
  }
}

function isAttachmentMediaBlock(block: MessageBlock): block is AttachmentMediaBlock {
  return (
    block.type === 'file'
    || block.type === 'image'
    || block.type === 'video'
    || block.type === 'document'
  )
}

function resolveBlockUrl(block: AttachmentMediaBlock): {
  url: string | undefined
  mimeFromSource: string | undefined
  fileIdFromSource: string | undefined
} {
  // 两种格式统一取 url：
  //  1) 扁平持久化格式（DB / attachments 回灌）：block.url / block.file_id
  //  2) Anthropic 格式（本地运行时 USER echo，见 engine/context/user-message.ts）：
  //     block.source = { type:'url', url } | { type:'base64', media_type, data }
  //     | { type:'file_id', file_id }；顶层 file_id 也可能并存。
  let url = block.url
  let mimeFromSource: string | undefined
  let fileIdFromSource: string | undefined
  const source = block.source
  if (source && typeof source === 'object') {
    if (source.type === 'file_id' && typeof source.file_id === 'string' && source.file_id) {
      fileIdFromSource = source.file_id
    }
    if (!url && source.type === 'url' && source.url) {
      url = source.url
    } else if (!url && source.type === 'base64' && source.data) {
      mimeFromSource = source.media_type
      url = `data:${source.media_type || 'image/png'};base64,${source.data}`
    }
  }
  return { url, mimeFromSource, fileIdFromSource }
}

function attachmentIdentityKeys(att: MessageAttachment): string[] {
  return [att.file_id, att.url, att.preview_url]
    .filter((k): k is string => typeof k === 'string' && k.length > 0)
}

/**
 * 用户附件卡片的单一渲染源解析。
 *
 * 服务端已把 `attachments_json` 下线（GET /messages 恒返 `[]`），用户附件的持久化
 * 表示是 `content_blocks_json` 里的 `file` / `image` 块。历史回灌后只能从这些块还原
 * 文件卡片；`attachments_json` 仅在本地乐观消息尚未落库时兜底（那一刻 blocks 里
 * 还没有 file 块）。
 *
 * runtime 的 USER event 会同时带 `attachments_json` 与 `blocks_json`(file)，实时态
 * 下同一条消息可能两源并存——按 file_id / url / preview_url / filename 去重合并，
 * 避免过渡态渲染出重复卡片。
 *
 * ：切会话后本机 transcript 的 DocumentBlock 与 DB FileBlock 叠显时，
 * 先投影 file/image/video，再投影 document；去重登记全部标识键，避免 0 B 双卡。
 *
 * ：同资源先出现无 file_id 的本地 URL 块、后出现带 file_id 的 DB 块时，
 * 去重必须升级保留 file_id，否则切会话后无法走  换链。
 */
export function deriveUserAttachments(
  attachmentsJson: MessageAttachment[] | null | undefined,
  blocks: MessageBlock[],
): MessageAttachment[] {
  const result: MessageAttachment[] = []
  const keyToIndex = new Map<string, number>()

  const rememberKeys = (att: MessageAttachment, index: number): void => {
    for (const key of attachmentIdentityKeys(att)) {
      keyToIndex.set(key, index)
    }
  }

  const add = (att: MessageAttachment): void => {
    const keys = attachmentIdentityKeys(att)
    if (keys.length === 0) {
      result.push(att)
      return
    }

    let existingIndex: number | undefined
    for (const key of keys) {
      const hit = keyToIndex.get(key)
      if (hit !== undefined) {
        existingIndex = hit
        break
      }
    }

    if (existingIndex === undefined) {
      const index = result.length
      result.push(att)
      rememberKeys(att, index)
      return
    }

    const existing = result[existingIndex]
    // 同资源：有 file_id 的条目优先（本地 URL echo + DB FileBlock 叠在一起时）。
    if (!existing.file_id && att.file_id) {
      result[existingIndex] = {
        ...existing,
        ...att,
        // 保留已有可用 URL，避免 DB 块无 url 时把展示源清空。
        url: att.url || existing.url,
        preview_url: att.preview_url || existing.preview_url,
        filename: att.filename || existing.filename,
        mime_type: att.mime_type || existing.mime_type,
        size: att.size || existing.size,
      }
      rememberKeys(result[existingIndex], existingIndex)
      return
    }

    if (existing.file_id && !att.file_id) {
      // 已有可换链条目，忽略纯 URL 回声。
      return
    }

    // 两边都有 / 都没有 file_id：补齐缺失元数据，不新增卡片。
    result[existingIndex] = {
      ...existing,
      url: existing.url || att.url,
      preview_url: existing.preview_url || att.preview_url,
      filename: existing.filename || att.filename,
      mime_type: existing.mime_type || att.mime_type,
      size: existing.size || att.size,
    }
    rememberKeys(result[existingIndex], existingIndex)
  }

  for (const att of attachmentsJson ?? []) add(att)

  const mediaBlocks = blocks.filter(isAttachmentMediaBlock)
  // FileBlock（含 size）优先于 LLM DocumentBlock，避免切会话叠出 0 B 卡
  const orderedBlocks = [
    ...mediaBlocks.filter(b => b.type !== 'document'),
    ...mediaBlocks.filter(b => b.type === 'document'),
  ]

  for (const block of orderedBlocks) {
    // ：云盘 ContextRef（file_id + preview、无附件字段）勿投「附件 0 B」
    if (isFileContextRefBlock(block)) continue
    const { url, mimeFromSource, fileIdFromSource } = resolveBlockUrl(block)
    const fileId = block.file_id || fileIdFromSource
    if (!fileId && !url) continue
    // ：DocumentBlock（type:document）回灌为 UI file 卡片，避免刷新丢附件。
    const cardType: MessageAttachment['type'] =
      block.type === 'document' ? 'file' : block.type
    const filename =
      (typeof block.filename === 'string' && block.filename)
      || (typeof block.title === 'string' && block.title)
      || '附件'
    add({
      type: cardType,
      file_id: fileId,
      filename,
      mime_type: block.mime_type ?? mimeFromSource ?? '',
      size: typeof block.size === 'number' ? block.size : 0,
      url,
      preview_url: block.preview_url,
    })
  }
  return result
}
