/**
 * 从 assistant 正文提取 tabtin://resource 链接产物（画板 / 轮次产物卡共用）。
 */
import { parseResourcePointer } from '@tabtin/resource-router'

/**
 * URI 路径体禁止引号 / 反引号：避免正文 `…m4a"。` 把收尾 `"` 吞进产物路径。
 * 对齐 markdown-resource-autolink 的 PATH_BODY_DENY 对 `"` 的处理。
 */
const MD_RESOURCE_LINK_RE = /\[([^\]]+)\]\(((?:tabtin|tabtin-preprod|tabtin-dev):\/\/resource\/[^)\s"'`]+)\)/g
const BARE_RESOURCE_URI_RE = /(?:tabtin|tabtin-preprod|tabtin-dev):\/\/resource\/[^\s)\]"'`]+/g
const RESOURCE_LINK_MARKER_RE = /(?:tabtin|tabtin-preprod|tabtin-dev):\/\/resource\//
const FENCED_CODE_BLOCK_RE = /```[\s\S]*?(?:```|$)/g
const INLINE_CODE_RE = /`[^`\n]*`/g
/** 贪婪匹配后仍可能挂上的收尾西文/中文标点（防御）。 */
const TRAILING_URI_PUNCT_RE = /[.,;:!?。，、；：！？…]+$/u

function stripMarkdownInline(s: string): string {
  return s.replace(/[*`_~]/g, '').trim()
}

/**
 * 去掉代码块/行内代码后再提链接——模型在 ``` 示例里展示的 tabtin://
 * 字符串不是真实产物（bugbot ）。
 */
function stripCodeSegments(text: string): string {
  return text.replace(FENCED_CODE_BLOCK_RE, ' ').replace(INLINE_CODE_RE, ' ')
}

/**
 * 模型截断的 id 不是真实产物：Agent 会照抄 SKILL 样板风格输出
 * `tabtin://resource/document/02eda024-5f11-…` 这类省略号截断链接，收进产物卡
 * 后点击必失败（后端报「document_id 不是合法 UUID」）。含 `…` 的 id 一律丢弃；
 * `...` 只对云端资源丢弃——file 类 id 是文件路径，`...` 理论上可以是合法文件名。
 */
function isTruncatedResourceId(type: string, id: string): boolean {
  if (id.includes('\u2026')) return true
  return type !== 'file' && id.includes('...')
}

export interface ResourceLinkArtifactExtract {
  resourceKey: string
  title: string
  href: string
  resourceType: string
}

/** 去掉 URI 尾部误吞的标点；引号已由正则边界排除。 */
function sanitizeResourceHref(href: string): string {
  return href.replace(TRAILING_URI_PUNCT_RE, '')
}

/**
 * 从 assistant 正文抽出 tabtin://resource 链接。
 * 按 `<type>:<id>` 去重（同一轮内调用方再按 href 去重）。
 */
export function extractResourceLinkArtifacts(rawText: string): ResourceLinkArtifactExtract[] {
  if (!rawText || !RESOURCE_LINK_MARKER_RE.test(rawText)) return []
  const text = stripCodeSegments(rawText)
  if (!RESOURCE_LINK_MARKER_RE.test(text)) return []
  const labelByUrl = new Map<string, string>()
  for (const m of text.matchAll(MD_RESOURCE_LINK_RE)) {
    const label = stripMarkdownInline(m[1] ?? '')
    const url = sanitizeResourceHref(m[2] ?? '')
    if (url && label && !labelByUrl.has(url)) labelByUrl.set(url, label)
  }
  const out: ResourceLinkArtifactExtract[] = []
  const seenLocal = new Set<string>()
  for (const m of text.matchAll(BARE_RESOURCE_URI_RE)) {
    const href = sanitizeResourceHref(m[0])
    if (!href) continue
    const ptr = parseResourcePointer(href)
    if (ptr.scheme !== 'tabtin' || !ptr.type || !ptr.id) continue
    if (isTruncatedResourceId(ptr.type, ptr.id)) continue
    const resourceKey = `${ptr.type}:${ptr.id}`
    if (seenLocal.has(resourceKey)) continue
    seenLocal.add(resourceKey)
    out.push({
      resourceKey,
      title: labelByUrl.get(href) || ptr.id,
      href,
      resourceType: ptr.type,
    })
  }
  return out
}

/**
 * 合并 message.content 与 text block 正文。
 *
 * ：块从运行时 SSoT `message.blocks` 传入（调用方经 readMessageBlocks 解析），
 * 不再读落库字段 content_blocks_json。
 */
export function collectAssistantText(
  content: string | undefined,
  blocks: ReadonlyArray<{ type?: string; text?: string }>,
): string {
  const parts: string[] = []
  if (typeof content === 'string' && content.trim()) {
    parts.push(content)
  }
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}
