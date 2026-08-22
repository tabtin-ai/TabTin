import type { ChatMessage } from '@tabtin/chat-client'

/**
 * 与 `packages/agent-runtime/src/prompts/compact/wrapper.ts` 的
 * SUMMARY_HEADER / SUMMARY_FOOTER 同文（该文件为 marker SSoT）。
 * Renderer 不直接依赖 agent-runtime prompts，故本地镜像；改文案须双边同步，勿漂移。
 */
const SUMMARY_HEADER_MARKER = '[对话摘要]'
const SUMMARY_END_MARKER = '[摘要结束]'

/**
 * ：压缩检查点是否应按「分隔 pill」展示（禁止渲染摘要正文）。
 *
 * Runtime persist 可能以 `role=user` 落库（本地 block / LLM 上下文需要 user 角色），
 * 但 UI 只认 `message_kind` / 正文 marker，不再用 role 决定是否当用户气泡。
 */
export function isCompactionSummaryPresentation(
  message: Pick<ChatMessage, 'message_kind' | 'content' | 'content_blocks_json'>,
): boolean {
  if (message.message_kind === 'compaction_summary') return true
  const text = messageText(message)
  return text.includes(SUMMARY_HEADER_MARKER) && text.includes(SUMMARY_END_MARKER)
}

function messageText(
  message: Pick<ChatMessage, 'content' | 'content_blocks_json'>,
): string {
  const direct = typeof message.content === 'string' ? message.content : ''
  if (direct.includes(SUMMARY_HEADER_MARKER)) return direct

  const blocks = message.content_blocks_json
  if (!Array.isArray(blocks)) return direct

  const fromBlocks = blocks
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const text = (block as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join('\n')
  return fromBlocks || direct
}
