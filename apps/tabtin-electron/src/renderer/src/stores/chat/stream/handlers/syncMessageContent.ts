/**
 * 把 store 内 finalize 后的 ContentBlock 派生成纯文本，回填到
 * `useChatStore.messagesBySessionId[sid][messageId].content` + `.content_blocks_json`。
 *
 * **入口有两条**——必须走同一个 helper 才能保证 footer 在所有终态下都显示：
 *   1. `contentBlockHandler.handleMessageStop` —— daemon 推 message_stop 走的
 *      正常路径（lifecycle.end）。
 *   2. `sessionCleanup.cleanupSessionOnTerminal` —— cancel / hard error 路径
 *      （daemon 没机会 emit message_stop 时，runtime 内部 force-finalize，
 *      但 ChatMessage.content 不会被自动写入）。
 *
 * 第二条入口缺失会让"用户主动 cancel" / "网络断" 后 footer 重新消失——
 * 第一轮 review 没发现的边角缺口（v2 三视角 review 揭出）。把 helper 抽到
 * 独立文件而不是放在 contentBlockHandler 里，是为了：
 *   - sessionCleanup 静态依赖 helper 时不会拉整个 contentBlockHandler 模块
 *     （后者间接 import useChatStore，会拖一大坨 store 依赖到测试环境）；
 *   - 单测 mock 这个 helper 单独跳过，不影响主清理路径其他断言。
 *
 * 设计要点：
 *   - **优先读 `meta.text_summary`**：store reducer 已经在 `messageStop` /
 *     `contentBlockStop(text)` 派生过；fallback 才走 `deriveTextSummary`
 *     兜底（譬如 store 已 finalize 但没经过 summary 派生路径的情况）。
 *     这避免同一份计算跑两次。
 *   - 仅 `role === 'assistant'`：user 消息的 content 由 sendMessageAction
 *     主路径设置，这里限定 scope 防止误覆盖。
 *   - `finalizedBlocks.length > 0` 守门：极端 case（assistant message_start
 *     后立即 message_stop，没有 content_block_*）保持初始 content=''，与
 *     测试 §4.11.4 断言一致。
 *   - 算法与 Django reassembler `derive_text_summary` 1:1 对齐——前后端
 *     落到 `ChatMessage.content` 的字面值完全一致，不会刷新前后漂移。
 */

import type { ChatMessage } from '@tabtin/chat-client'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import { getCommittedBlocks } from '@/stores/chat/messages/messageBlocks'
import { deriveTextSummary } from '@/utils/contentBlockSummary'

export function syncDerivedContentToChatMessage(sessionId: string, messageId: string): void {
  const runtime = useChatRuntimeStore.getState()
  //  阶段 6：finalize 后的块从 messages 层已提交存储读（flush 后可用），
  // 序列化回 content_blocks_json 作落库 / evict 重建快照。
  const finalizedBlocks = getCommittedBlocks(sessionId, messageId) ?? []
  const finalizedMeta = runtime.messageMetaBySessionId[sessionId]?.[messageId]
  if (finalizedMeta?.role !== 'assistant') return
  if (finalizedBlocks.length === 0) return

  const blocksJson = finalizedBlocks
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.block as Record<string, unknown>)

  // 优先用 store 已派生好的 text_summary（避免重复算）；fallback 才再派生一次
  const derivedContent = finalizedMeta.text_summary ?? deriveTextSummary(finalizedBlocks)

  useChatStore.getState().patchMessageById(sessionId, messageId, (m) => ({
    ...m,
    content_blocks_json: blocksJson as ChatMessage['content_blocks_json'],
    ...(derivedContent ? { content: derivedContent } : {}),
  }))
}
