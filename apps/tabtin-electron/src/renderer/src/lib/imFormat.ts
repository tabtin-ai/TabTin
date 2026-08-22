/**
 * TabChat 消息格式化工具 — 纯函数，无 store 依赖
 *
 * 从 useIMStore 提取的公共格式化逻辑，供 store / 组件 / 测试复用。
 * preview 格式与后端 `_build_preview` 保持严格一致。
 */

import type { Conversation, IMMessage } from '@/services/tabchatApi'
import {
  MESSAGE_TYPE_FILE,
  MESSAGE_TYPE_IMAGE,
} from '@/constants/tabchat'
import { prependPreviewSender } from '@/services/im/previewSender'

const MAX_PREVIEW_LEN = 200

function messagePreviewText(message: IMMessage): string {
  let preview: string
  if (message.message_type === MESSAGE_TYPE_FILE) {
    const card = message.metadata?.card
    const codexSessionName = card?.type === 'codex_session'
      && card.schema_version === 1
      && typeof card.codex_session_id === 'string'
      && Boolean(card.codex_session_id.trim())
      && typeof card.codex_session_name === 'string'
      && Boolean(card.codex_session_name.trim())
      ? card.codex_session_name.trim()
      : ''
    if (codexSessionName) {
      preview = `[Codex 会话] ${codexSessionName}`
    } else {
      const fileName = message.metadata?.file_name || ''
      preview = fileName ? `[文件] ${fileName}` : '[文件]'
    }
  } else if (message.message_type === MESSAGE_TYPE_IMAGE) {
    preview = '[图片]'
  } else {
    const card = message.metadata?.card
    if (card && (card.type === 'table' || card.type === 'document')) {
      const label = card.type === 'table' ? '表格' : '文档'
      preview = `[${label}] ${card.name || ''}`.trim()
    } else {
      preview = message.content?.slice(0, MAX_PREVIEW_LEN) || ''
    }
  }
  return preview
}

/** 构建消息 preview，格式与后端 _build_preview 严格一致。 */
export function buildPreview(message: IMMessage, isGroup: boolean): string {
  return prependPreviewSender(
    messagePreviewText(message),
    isGroup ? message.sender_name : undefined,
  )
}

/** 通知正文：群聊补发送人；单聊发送人已在通知标题中，正文不重复。 */
export function notificationBody(message: IMMessage, isGroup = false): string {
  return buildPreview(message, isGroup).slice(0, 100)
}

/** 会话列表排序：置顶优先，然后按最新消息时间降序。 */
export function sortConversations(convs: Conversation[]): Conversation[] {
  return [...convs].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    const ta = a.last_message_at || a.created_at
    const tb = b.last_message_at || b.created_at
    return tb.localeCompare(ta)
  })
}
