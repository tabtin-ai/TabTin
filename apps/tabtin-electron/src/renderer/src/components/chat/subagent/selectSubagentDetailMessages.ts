/**
 * selectSubagentDetailMessages — 子代理详情 transcript 源选择
 *
 * Runtime 本地归档是执行真相；live store 是实时投影。两边 message_id 体系不同，
 * 不能按 id merge（会重复）。按「可见执行步」完整度二选一：归档更完整则用归档，
 * 否则用 live（含 live 追平/领先时的流式正文）。
 */

import type { ChatMessage } from '@tabtin/chat-client'

const DETAIL_STEP_TYPES = new Set([
  'thinking',
  'redacted_thinking',
  'tool_use',
  'mcp_tool_use',
])

function blockTypeOf(block: unknown): string | undefined {
  if (!block || typeof block !== 'object') return undefined
  const direct = (block as { type?: unknown }).type
  if (typeof direct === 'string') return direct
  const nested = (block as { block?: { type?: unknown } }).block?.type
  return typeof nested === 'string' ? nested : undefined
}

/** 一条消息上可读的块列表：优先 ContentBlockEntry.blocks，否则 content_blocks_json。 */
function iterableBlocksOf(message: ChatMessage): readonly unknown[] {
  const entries = message.blocks
  if (Array.isArray(entries) && entries.length > 0) {
    return entries.map((entry) => {
      if (entry && typeof entry === 'object' && 'block' in entry) {
        return (entry as { block?: unknown }).block ?? entry
      }
      return entry
    })
  }
  const json = message.content_blocks_json
  return Array.isArray(json) ? json : []
}

/**
 * 详情可见步：thinking + tool_use（与 BlockTimeline「执行详情」计数同口径）。
 */
export function countSubagentDetailSteps(messages: readonly ChatMessage[]): number {
  let count = 0
  for (const message of messages) {
    for (const block of iterableBlocksOf(message)) {
      const type = blockTypeOf(block)
      if (type && DETAIL_STEP_TYPES.has(type)) count += 1
    }
  }
  return count
}

export function selectSubagentDetailMessages(
  live: readonly ChatMessage[],
  archive: readonly ChatMessage[],
): ChatMessage[] {
  const liveList = live as ChatMessage[]
  const archiveList = archive as ChatMessage[]
  if (archiveList.length === 0) return liveList
  if (liveList.length === 0) return archiveList

  const liveSteps = countSubagentDetailSteps(liveList)
  const archiveSteps = countSubagentDetailSteps(archiveList)
  // 归档严格更完整 → runtime 落盘胜出（修「有残缺 live 就丢掉磁盘」）。
  if (archiveSteps > liveSteps) return archiveList
  // 步数打平但归档消息更多（例如多轮空 thinking 边界）→ 仍偏归档。
  if (archiveSteps === liveSteps && archiveList.length > liveList.length) {
    return archiveList
  }
  return liveList
}
