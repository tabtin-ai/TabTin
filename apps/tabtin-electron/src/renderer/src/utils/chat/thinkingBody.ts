/**
 * Thinking 正文读取的 wire 兼容边界。
 *
 * 运行时协议使用 `thinking`；早期存档与少数 fixture 曾使用 `text`。
 * 所有 Thinking UI 和回合活动态必须走此函数，避免同一块被一方视为“有正文”、
 * 另一方视为空。
 */
export type ThinkingBodySource =
  | {
    type?: string
    thinking?: unknown
    text?: unknown
  }
  | null
  | undefined

export function getThinkingBody(block: ThinkingBodySource): string {
  if (typeof block?.thinking === 'string') return block.thinking
  if (typeof block?.text === 'string') return block.text
  return ''
}
