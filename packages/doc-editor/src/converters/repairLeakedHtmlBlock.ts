import type { JSONContent } from '@tiptap/core'
import { markdownToPmJson } from './markdownToPmJson.js'

const HTMLBLOCK_OPEN_IN_TEXT_RE = /:::htmlblock\{/
const HTMLBLOCK_OPEN_LINE_RE = /^:::htmlblock\{(.+)\}\s*$/
const HTMLBLOCK_CLOSE_LINE_RE = /^:::\s*$/

function extractParagraphText(node: JSONContent): string {
  if (node.type !== 'paragraph' || !Array.isArray(node.content)) return ''
  return node.content
    .filter((child): child is JSONContent => !!child && child.type === 'text')
    .map((child) => String(child.text ?? ''))
    .join('')
}

/** tiptap-markdown 段落路径会把 URL 里的 `_` 转成 `\_`；repair 前先还原。 */
export function normalizeLeakedHtmlBlockMarkdown(text: string): string {
  let normalized = text.trim().replace(/\\_/g, '_')
  if (!HTMLBLOCK_OPEN_IN_TEXT_RE.test(normalized)) {
    return normalized
  }
  if (!normalized.startsWith(':::htmlblock{')) {
    const idx = normalized.indexOf(':::htmlblock{')
    if (idx >= 0) normalized = normalized.slice(idx)
  }
  // 单行闭合 `:::htmlblock{...} :::` → 标准两行
  normalized = normalized.replace(/\}\s+:::\s*$/, '}\n:::')
  if (!HTMLBLOCK_CLOSE_LINE_RE.test(normalized.split('\n').at(-1) ?? '')) {
    normalized = `${normalized.replace(/\s+$/, '')}\n:::`
  }
  return normalized
}

function tryParseLeakedHtmlBlockMarkdown(markdown: string): JSONContent | null {
  try {
    const doc = markdownToPmJson(normalizeLeakedHtmlBlockMarkdown(markdown))
    const rawNodes = doc.content
    if (!Array.isArray(rawNodes)) return null
    const nodes = rawNodes as JSONContent[]
    if (nodes.length === 1 && nodes[0]?.type === 'htmlBlock') {
      return nodes[0]
    }
    const htmlBlock = nodes.find((node) => node.type === 'htmlBlock')
    return htmlBlock ?? null
  } catch {
    return null
  }
}

function preserveBlockId(repaired: JSONContent, source: JSONContent): JSONContent {
  const sourceBlockId = source.attrs?.blockId
  if (typeof sourceBlockId !== 'string' || !sourceBlockId) return repaired
  return {
    ...repaired,
    attrs: {
      ...(repaired.attrs ?? {}),
      blockId: sourceBlockId,
    },
  }
}

/**
 * 将「段落里泄漏的 :::htmlblock{...} 原文」修回 htmlBlock 节点。
 *
 * 典型成因：tiptap-markdown 未实现 htmlBlock.parse，setContent(markdown) / paste
 * 把 directive 当普通段落；save 链路原样落库后，加载优先 pmJson 导致 NodeView 消失。
 */
export function repairLeakedHtmlBlockInPmJson(
  pmJson: JSONContent | Record<string, unknown> | null | undefined,
): { pmJson: JSONContent; repaired: boolean } {
  if (!pmJson || typeof pmJson !== 'object') {
    return { pmJson: { type: 'doc', content: [] }, repaired: false }
  }

  const root = pmJson as JSONContent
  const content = root.content
  if (!Array.isArray(content) || content.length === 0) {
    return { pmJson: root, repaired: false }
  }

  const nextContent: JSONContent[] = []
  let repaired = false

  for (let index = 0; index < content.length; index += 1) {
    const node = content[index]!
    if (node.type !== 'paragraph') {
      nextContent.push(node)
      continue
    }

    const text = extractParagraphText(node)
    const nextNode = content[index + 1]
    const nextText = nextNode?.type === 'paragraph' ? extractParagraphText(nextNode) : ''

    // 两行泄漏：:::htmlblock{...} + :::
    if (HTMLBLOCK_OPEN_LINE_RE.test(text.trim()) && HTMLBLOCK_CLOSE_LINE_RE.test(nextText.trim())) {
      const parsed = tryParseLeakedHtmlBlockMarkdown(`${text.trim()}\n:::`)
      if (parsed) {
        nextContent.push(preserveBlockId(parsed, node))
        repaired = true
        index += 1
        continue
      }
    }

    if (HTMLBLOCK_OPEN_IN_TEXT_RE.test(text)) {
      const parsed = tryParseLeakedHtmlBlockMarkdown(text)
      if (parsed) {
        nextContent.push(preserveBlockId(parsed, node))
        repaired = true
        continue
      }
    }

    nextContent.push(node)
  }

  if (!repaired) {
    return { pmJson: root, repaired: false }
  }

  return {
    pmJson: {
      ...root,
      content: nextContent,
    },
    repaired: true,
  }
}
