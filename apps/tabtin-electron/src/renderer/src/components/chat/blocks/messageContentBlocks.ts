/**
 * messageContentBlocks —— 对话消息内容块的**单一读入口（SSoT）**。
 *
 * ：读源就是 `ChatMessage.blocks`（前端内存 SSoT，`ContentBlockEntry[]`）。实时块由
 * runtime 引擎 rAF flush commit 进 message.blocks，历史块由入口反序列化
 * （`hydrateSessionBlocksFromJson`）一次性灌入 message.blocks——二者物理同处。
 * **读时不再回退读 / 反序列化 `content_blocks_json`**（那只是落库序列化字段）。
 */

import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'

const EMPTY: ContentBlockEntry[] = []

/**
 * 唯一读入口（纯函数）：直接读 `message.blocks`（运行时 SSoT）。
 *
 * 供派生器 / getState 路径用（画板聚合、轮次产物、定位反查、子代理派生等）。
 * 不依赖 sessionId / runtime store——message.blocks 已统一承载实时 + 历史。
 */
export function readMessageContentBlocks(message: ChatMessage): ContentBlockEntry[] {
  return (message.blocks ?? EMPTY) as ContentBlockEntry[]
}

/** 便捷版：只取 native block 主体数组（多数派生器只关心 block 内容）。 */
export function readMessageBlocks(message: ChatMessage): ContentBlockEntry['block'][] {
  return readMessageContentBlocks(message).map((e) => e.block)
}
