import type { MessageBlock } from '@tabtin/chat-client'

/**
 * 构造用户可见消息的 content blocks。
 *
 * 乐观气泡与落库 / IPC `userMessageBlocks` 共用同一构造，避免「有 context 时
 * 只写引用块、漏写 text」导致正文被吞。UI 正文只读 text 块
 *（`deriveUserMessageDisplayContent`，见 ）。
 *
 * - 有 context：可选前置 text（trim 后非空）+ context 块
 * - 无 context：单 text 块（保留原文，与历史乐观路径一致）
 */
export function buildUserVisibleBlocks(
  text: string,
  contextBlocks?: readonly MessageBlock[] | null,
): MessageBlock[] {
  const contexts = contextBlocks && contextBlocks.length > 0
    ? [...contextBlocks]
    : null

  if (contexts) {
    const trimmed = text.trim()
    return trimmed
      ? [{ type: 'text', text: trimmed } as MessageBlock, ...contexts]
      : contexts
  }

  return [{ type: 'text', text } as MessageBlock]
}
