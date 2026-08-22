import type { ChatMessage } from '@tabtin/chat-client'
import { deserializeContentBlocks } from '@/components/chat/blocks/deserializeContentBlocks'
import { appendMissingUserAttachmentMediaBlocks } from '@/stores/chat/domain/userMediaMerge'
import { reconcileServerMessageBlocks } from '@/stores/chat/domain/blockMergePolicy'

/**
 * 单条消息：若尚无非空 runtime blocks，从 `content_blocks_json` 灌入。
 * 仅由 store 入口 `hydrateSessionBlocksFromJson` 调用（ 唯一灌块门）。
 *
 * **不可变**：需要灌块时返回新 message 对象，绝不原地改入参（ 方案 A：
 * 避免已入 store 的对象被静默 mutate 后 selector 不醒）。
 *
 * 用户消息额外守门：流式/本地 transcript 可能先只 commit 了 text 进 `blocks`，
 * 随后对账把 image/file 补进 `content_blocks_json`。若仍早退，时间线物化会用
 * 残缺 `blocks` 覆盖 `content_blocks_json`，附件气泡消失（OSS 私有图切会话）。
 */
export function ensureMessageRuntimeBlocks(message: ChatMessage): ChatMessage {
  const src = message.content_blocks_json
  const hasBlocks = Array.isArray(message.blocks) && message.blocks.length > 0

  if (hasBlocks && message.role === 'user' && Array.isArray(src) && src.length > 0) {
    const runtimeBodies = message.blocks!.map((entry) => entry.block as unknown)
    // 只探测附件 media 是否缺（或 file_id 待升级）；不把 preset/ContextRef 算进 added。
    const { added } = appendMissingUserAttachmentMediaBlocks(runtimeBodies, src)
    if (!added) return message
    // json 原样保留（含 preset / 引用）；从完整 json 重灌 blocks。
    return {
      ...message,
      blocks: deserializeContentBlocks(src, message.id, {
        stopReason: message.stop_reason,
        errorInfo: message.error_info_json,
        metadata: message.metadata,
      }),
    }
  }

  if (hasBlocks && message.role === 'assistant' && Array.isArray(src) && src.length > 0) {
    // Agent Runtime 持久化块是历史事实源；blocks 是 Renderer 唯一读模型。
    // 存量消息可能先带着非空但残缺的 runtime blocks 进 store，按稳定块键
    // 只补齐缺失块，不覆盖已存在的实时块。
    const reconciled = reconcileServerMessageBlocks(message, message)
    const reconciledBlocks = reconciled.blocks ?? []
    const blocksChanged = reconciledBlocks.length !== message.blocks!.length
      || reconciledBlocks.some((entry, index) => entry !== message.blocks![index])
    if (!blocksChanged) return message
    return { ...message, blocks: reconciledBlocks }
  }

  if (hasBlocks) return message
  if (!Array.isArray(src) || src.length === 0) return message
  return {
    ...message,
    blocks: deserializeContentBlocks(src, message.id, {
      stopReason: message.stop_reason,
      errorInfo: message.error_info_json,
      metadata: message.metadata,
    }),
  }
}
