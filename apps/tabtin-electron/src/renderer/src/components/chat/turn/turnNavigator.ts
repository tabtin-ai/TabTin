/**
 * turnNavigator — 对话轮次快捷导航的纯逻辑
 *
 * 「一轮」= 一条真实用户输入（正向 `isRegularUserMessage`）。
 * 专用 message_kind / push / skill_invoke 不进导航。
 *
 * index 基于 MessageList 物化后的时间线数组（与 virtualizer 行下标一一对应），
 * 点击导航直接 scrollToIndex(entry.index)。
 */
import type { ChatMessage } from '@tabtin/chat-client'
import { isRegularUserMessage } from '../../../stores/chat/messages/utils/semanticMessageCount'
import { deriveUserMessageDisplayContent } from '../message'

export interface TurnNavigatorEntry {
  /** 物化时间线数组中的下标（与 virtualizer 虚拟行 index 对齐） */
  index: number
  /** 消息 id（滚动定位后高亮用） */
  id: string
  /** hover 预览文本（空白折叠 + 截断；纯附件消息可能为空串） */
  preview: string
}

const PREVIEW_MAX_CHARS = 160

export function buildTurnNavigatorEntries(messages: readonly ChatMessage[]): TurnNavigatorEntry[] {
  const entries: TurnNavigatorEntry[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (!isRegularUserMessage(message)) continue
    // 物化拆段防御：同一条 user 消息被时间线物化拆成多段时只保留首段作轮次锚点
    if (entries.length > 0 && entries[entries.length - 1].id === message.id) continue
    const text = deriveUserMessageDisplayContent(message).replace(/\s+/g, ' ').trim()
    entries.push({
      index: i,
      id: message.id,
      preview: text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text,
    })
  }
  return entries
}

/**
 * 视口顶部第一条可见消息的下标 → 当前所处轮次（该下标之前最近的用户轮）。
 * 视口在第一轮之前（顶部 loadMore 区）时归到第 0 轮。空 entries 返回 -1。
 */
export function resolveActiveTurnIndex(
  entries: readonly TurnNavigatorEntry[],
  topVisibleMessageIndex: number,
): number {
  if (entries.length === 0) return -1
  let active = 0
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].index <= topVisibleMessageIndex) active = i
    else break
  }
  return active
}
