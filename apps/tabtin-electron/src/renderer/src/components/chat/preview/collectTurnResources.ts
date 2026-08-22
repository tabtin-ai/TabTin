/**
 * 聊天资源预览 - 同回合资源聚合
 *
 * 一个"回合"的定义：
 * - 用户消息：自身一条即一回合的发起，仅聚合该消息的资源
 * - 助手消息：以 `agent_run_id` 为单位聚合该回合内全部 assistant 消息的资源；
 *   若助手消息没有 agent_run_id（旧数据 / 流式中尚未落地），仅聚合自身
 */

import type { ChatMessage, MessageAttachment, MessageBlock } from '@tabtin/chat-client'
import type { PreviewResource, PreviewResourceKind } from './types'
import { readMessageBlocks } from '../blocks/messageContentBlocks'
import { inferPreviewableKind } from './inferPreviewableKind'

function inferKind(
  mime?: string,
  pathOrName?: string,
  fallback?: PreviewResourceKind,
): PreviewResourceKind {
  return inferPreviewableKind(mime, pathOrName) ?? fallback ?? 'file'
}

function mediaUrlFromBlock(block: MessageBlock): string | undefined {
  if (block.url) return block.url
  if (block.preview_url) return block.preview_url
  // Anthropic 形态（本地 runtime / message-blocks）：source.url
  const source = (block as { source?: { type?: string; url?: string } }).source
  if (source && typeof source === 'object' && source.type === 'url' && source.url) {
    return source.url
  }
  return undefined
}

function fromAttachment(att: MessageAttachment, msgId: string, idx: number): PreviewResource | null {
  const url = att.url || att.preview_url
  if (!url) return null
  const fallback: PreviewResourceKind =
    att.type === 'image' ? 'image' : att.type === 'video' ? 'video' : 'file'
  return {
    id: `${msgId}:att:${idx}`,
    kind: inferKind(att.mime_type, att.filename || url, fallback),
    url,
    name: att.filename || url.split('/').pop() || 'file',
    mimeType: att.mime_type,
    size: att.size,
    sourceMessageId: msgId,
    fileId: att.file_id,
  }
}

function fromBlock(block: MessageBlock, msgId: string, idx: number): PreviewResource | null {
  if (block.type === 'image') {
    const url = mediaUrlFromBlock(block)
    if (!url) return null
    return {
      id: `${msgId}:blk:${idx}`,
      kind: 'image',
      url,
      name: block.filename || url.split('/').pop() || 'image',
      mimeType: block.mime_type,
      size: block.size,
      sourceMessageId: msgId,
    }
  }
  if (block.type === 'video') {
    const url = mediaUrlFromBlock(block)
    if (!url) return null
    return {
      id: `${msgId}:blk:${idx}`,
      kind: 'video',
      url,
      name: block.filename || url.split('/').pop() || 'video',
      mimeType: block.mime_type,
      size: block.size,
      sourceMessageId: msgId,
      fileId: block.file_id,
    }
  }
  if (block.type === 'file') {
    const url = block.url
    if (!url) return null
    return {
      id: `${msgId}:blk:${idx}`,
      kind: inferKind(block.mime_type, block.filename || url, 'file'),
      url,
      name: block.filename || url.split('/').pop() || 'file',
      mimeType: block.mime_type,
      size: block.size,
      sourceMessageId: msgId,
      fileId: block.file_id,
    }
  }
  // rich_content（老扁平）与 tabtin_rich_content（native，展示字段在 payload 内）
  // 统一处理——读模型归一后历史消息是 native 形态，字段藏在 payload。
  if (block.type === 'rich_content' || block.type === 'tabtin_rich_content') {
    const flat = block.type === 'tabtin_rich_content' && block.payload && typeof block.payload === 'object'
      ? { ...(block.payload as Record<string, unknown>), kind: block.kind, summary: block.summary }
      : (block as unknown as Record<string, unknown>)
    const kind = flat.kind as string | undefined

    // show_widget：无 url，靠 code / image_url；pending 占位不进预览列表
    if (kind === 'widget') {
      const widgetId = typeof flat.widget_id === 'string' ? flat.widget_id : ''
      if (!widgetId || widgetId.startsWith('pending:')) return null
      const format =
        flat.format === 'html' || flat.format === 'mermaid' ? flat.format : 'svg'
      const rawCode = typeof flat.code === 'string' ? flat.code : ''
      const rendered = typeof flat.rendered_code === 'string' ? flat.rendered_code : ''
      const code =
        format === 'mermaid'
          ? (rendered || (rawCode.trimStart().startsWith('<svg') ? rawCode : ''))
          : rawCode
      const imageUrl = typeof flat.image_url === 'string' ? flat.image_url : ''
      if (!code && !imageUrl) return null
      return {
        id: `${msgId}:widget:${widgetId}`,
        kind: 'widget',
        url: imageUrl,
        name:
          (typeof flat.title === 'string' && flat.title)
          || (typeof flat.summary === 'string' && flat.summary)
          || 'widget',
        sourceMessageId: msgId,
        widgetId,
        format,
        code: code || undefined,
        imageUrl: imageUrl || undefined,
      }
    }

    const url = flat.url as string | undefined
    if (!url) return null
    if (kind === 'image') {
      return {
        id: `${msgId}:rich:${idx}`,
        kind: 'image',
        url,
        name: (flat.alt_text as string) || (flat.caption as string) || (flat.summary as string) || url.split('/').pop() || 'image',
        sourceMessageId: msgId,
      }
    }
    if (kind === 'file') {
      const filename = (flat.filename as string) || undefined
      return {
        id: `${msgId}:rich:${idx}`,
        kind: inferKind(flat.mime_type as string | undefined, filename || url, 'file'),
        url,
        name: filename || (flat.summary as string) || url.split('/').pop() || 'file',
        mimeType: flat.mime_type as string | undefined,
        size: (flat.file_size as number) ?? (flat.size as number | undefined),
        sourceMessageId: msgId,
      }
    }
  }
  return null
}

/**
 * 取一条消息用于预览的内容块——统一读入口：只读 `message.blocks`
 * （实时 commit / 入口 hydrate）。默认即走它，调用方不再注入 resolver 补丁
 * （流式期图片 / 文件产物也能即时预览）。参数保留供单测覆盖。
 */
export type MessageBlocksResolver = (msg: ChatMessage) => MessageBlock[]

const defaultBlocksResolver: MessageBlocksResolver = (msg) =>
  readMessageBlocks(msg) as MessageBlock[]

function collectFromMessage(msg: ChatMessage, getBlocks: MessageBlocksResolver): PreviewResource[] {
  const out: PreviewResource[] = []
  const atts = msg.attachments_json ?? []
  atts.forEach((att, i) => {
    const r = fromAttachment(att, msg.id, i)
    if (r) out.push(r)
  })
  const blocks = getBlocks(msg)
  blocks.forEach((b, i) => {
    const r = fromBlock(b, msg.id, i)
    if (r) out.push(r)
  })
  return out
}

/**
 * 聚合锚点消息所在"回合"的全部可预览资源。
 *
 * @param messages 该会话的全量消息（按时间顺序）
 * @param anchor 锚点消息（用户点击的那条消息）
 * @returns 该回合内可预览资源列表（按消息时间 → 消息内顺序）
 */
export function collectTurnResources(
  messages: ChatMessage[],
  anchor: ChatMessage,
  getBlocks: MessageBlocksResolver = defaultBlocksResolver,
): PreviewResource[] {
  if (anchor.role === 'user') {
    return collectFromMessage(anchor, getBlocks)
  }
  const runId = anchor.agent_run_id
  if (!runId) {
    return collectFromMessage(anchor, getBlocks)
  }
  const out: PreviewResource[] = []
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    if (m.agent_run_id !== runId) continue
    out.push(...collectFromMessage(m, getBlocks))
  }
  return out
}

/**
 * 在资源列表中定位与 `(messageId, hint)` 匹配的索引；找不到返回 0。
 * `hint` 可以是 url 或资源 id 前缀，用于精确命中"用户点击的具体资源"。
 */
export function locateResourceIndex(
  resources: PreviewResource[],
  messageId: string,
  hint?: { url?: string; resourceId?: string },
): number {
  if (resources.length === 0) return 0
  for (let i = 0; i < resources.length; i++) {
    const r = resources[i]
    if (r.sourceMessageId !== messageId) continue
    if (hint?.resourceId && (r.id === hint.resourceId || r.widgetId === hint.resourceId)) return i
    if (hint?.url && r.url && r.url === hint.url) return i
  }
  // 退化：仅按 messageId 找第一个
  const fallback = resources.findIndex(r => r.sourceMessageId === messageId)
  return fallback >= 0 ? fallback : 0
}
