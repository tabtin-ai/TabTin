interface DisplayContentBlock {
  type?: string
  text?: unknown
}

interface UserMessageDisplayLike {
  /**
   * 用户正文的唯一权威来源：内容块里的 `text` 块（与附件卡的 image/file 块同源）。
   * 实时（发送即写）与历史（回灌反序列化）都汇入这份结构，读源单一、不分叉。
   */
  content_blocks_json?: DisplayContentBlock[] | null
  /**
   * 摘要字段（后端由 `content_blocks_json` 的 text 块前 200 字派生，供会话列表 /
   * 全文搜索）。纯图片消息里被派生成 `[富内容]` 占位符——**故意不作为正文来源**，
   * 仅保留在类型上说明「这些字段存在但不参与正文渲染」。
   */
  content?: string | null
  text_summary?: string | null
}

const USER_PRESET_HEADING_RE = /^##\s*用户预设请求:\s*`[^`]*`\s*\n?/m
const CONTEXT_WRAPPER_RE = /<context\b[^>]*>([\s\S]*?)<\/context>/i

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 从内容块拼出用户正文：仅取 `text` 块，按序 `\n` 连接。
 *
 * 无 text 块（纯图片 / 纯附件）→ 返回 `''`，即「无正文」，气泡不渲染。占位摘要
 * `[富内容]` 只存在于 content / text_summary，从不进 text 块，结构上进不到正文。
 */
function textFromContentBlocks(blocks: DisplayContentBlock[] | null | undefined): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block?.type !== 'text') continue
    const text = textValue(block.text)
    if (text) parts.push(text)
  }
  return parts.join('\n')
}

export function extractUserPresetRequestText(raw: string): string | null {
  const source = textValue(raw)
  if (!source) return null

  const contextMatch = source.match(CONTEXT_WRAPPER_RE)
  const body = (contextMatch?.[1] ?? source).trim()
  const headingMatch = body.match(USER_PRESET_HEADING_RE)
  if (!headingMatch || headingMatch.index == null) return null

  const requestText = body.slice(headingMatch.index + headingMatch[0].length).trim()
  return requestText || null
}

export function deriveUserMessageDisplayContent(message: UserMessageDisplayLike): string {
  const body = textFromContentBlocks(message.content_blocks_json)
  if (!body) return ''
  return extractUserPresetRequestText(body) ?? body
}
