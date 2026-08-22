import type { ChatMessage } from '@tabtin/chat-client'
import type { LocalChatMessage } from '@stores/chat/shared/types'

/**
 * 列表时间线「壳 / 形状」指纹——用于 memo / useMemo 挡 token 级 blocks 正文刷新。
 *
 * 含：条数、每条壳字段、blocks **数量** 与是否全部 finalized（决定 materialize
 * passthrough vs 拆段）。不含 blocks 正文引用。
 */
export function computeMessageTimelineShellKey(
  messages: readonly ChatMessage[],
  includeSubagentMessages = false,
): string {
  let key = includeSubagentMessages ? '1' : '0'
  key += `|${messages.length}`
  for (let i = 0; i < messages.length; i += 1) {
    key += `|${messageShellKey(messages[i])}`
  }
  return key
}

function blocksTimelineShapeFingerprint(message: ChatMessage): number {
  const blocks = message.blocks
  if (!Array.isArray(blocks) || blocks.length === 0) return 0
  let allFinalized = 1
  let validCount = 0
  for (const entry of blocks) {
    if (!entry) continue
    validCount += 1
    if (!entry.finalized) {
      allFinalized = 0
    }
  }
  if (validCount === 0) return 0
  return (validCount << 1) | allFinalized
}

function messageShellKey(message: ChatMessage): string {
  const local = message as LocalChatMessage
  // assistant 正文在 blocks；content 多为 ≤200 text_summary，流式抖动不应打穿 shellKey。
  // user / 其它角色气泡仍可能以 content 为正文，必须纳入指纹。
  const contentFingerprint = message.role === 'assistant' ? '' : (message.content ?? '')
  return [
    message.id,
    message.role,
    contentFingerprint,
    message.intent ?? '',
    message.message_kind ?? '',
    message.error_code ?? '',
    message.stop_reason ?? '',
    message.agent_run_id ?? '',
    message.client_event_id ?? '',
    message.sender_user_id ?? '',
    message.sender_display_name ?? '',
    message.subagent_run_id ?? '',
    message.checkpoint_hash ?? '',
    local.sendStatus ?? '',
    String(blocksTimelineShapeFingerprint(message)),
    refTag(message.attachments_json),
    refTag(message.content_blocks_json),
    refTag(message.metadata),
    refTag(message.error_info_json),
    refTag(message.checkpoint_record),
    refTag(message.diff_summary),
  ].join('\x1f')
}

const objectRefIds = new WeakMap<object, number>()
let nextObjectRefId = 1

function refTag(value: unknown): string {
  if (value == null) return '0'
  if (typeof value === 'object') {
    const obj = value as object
    let id = objectRefIds.get(obj)
    if (id == null) {
      id = nextObjectRefId
      nextObjectRefId += 1
      objectRefIds.set(obj, id)
    }
    return `o${id}`
  }
  return String(value)
}
