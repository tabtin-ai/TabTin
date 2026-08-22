import {
  formatMentionDisplayText,
  MENTION_COMPOSER_CLIPBOARD_MIME,
  MENTION_COMPOSER_MARKDOWN_ATTR,
  MENTION_HREF_ATTR,
  TEXT_PLAIN_CLIPBOARD_MIME,
  splitMentionMarkdownSegments,
} from './mentionMarkdown'
import { IM_MENTION_CHIP_CLASS } from './tabchatUi'

const BLOCK_TAGS = new Set(['DIV', 'P'])

export function serializeMentionComposerElement(root: HTMLElement): string {
  if (isComposerVisuallyEmpty(root)) return ''
  return serializeNodes(Array.from(root.childNodes))
}

export function renderMentionComposerValue(root: HTMLElement, value: string): void {
  root.replaceChildren()
  const segments = splitMentionMarkdownSegments(value)
  for (const segment of segments) {
    if (segment.type === 'text') {
      appendTextWithBreaks(root, segment.value)
      continue
    }
    const chip = document.createElement('span')
    chip.setAttribute(MENTION_COMPOSER_MARKDOWN_ATTR, segment.markdown)
    chip.setAttribute(MENTION_HREF_ATTR, segment.href)
    chip.setAttribute('contenteditable', 'false')
    chip.className = IM_MENTION_CHIP_CLASS
    chip.textContent = segment.label
    root.appendChild(chip)
  }
}

export function getMentionComposerMarkdownSelection(root: HTMLElement): { start: number; end: number } {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || !selection.anchorNode || !root.contains(selection.anchorNode)) {
    const length = serializeMentionComposerElement(root).length
    return { start: length, end: length }
  }
  const start = markdownOffsetFromPoint(root, selection.anchorNode, selection.anchorOffset)
  const focusNode = selection.focusNode ?? selection.anchorNode
  const end = markdownOffsetFromPoint(root, focusNode, selection.focusOffset)
  return start <= end ? { start, end } : { start: end, end: start }
}

export function mentionComposerClipboardFromSelection(
  root: HTMLElement,
): { markdown: string; display: string } | null {
  const serialized = serializeMentionComposerElement(root)
  const { start, end } = getMentionComposerMarkdownSelection(root)
  if (start === end) return null
  const markdown = serialized.slice(start, end)
  if (!markdown) return null
  return { markdown, display: formatMentionDisplayText(markdown) }
}

export function writeMentionComposerClipboard(
  clipboardData: DataTransfer,
  payload: { markdown: string; display: string },
): void {
  clipboardData.setData(MENTION_COMPOSER_CLIPBOARD_MIME, payload.markdown)
  clipboardData.setData(TEXT_PLAIN_CLIPBOARD_MIME, payload.display)
}

export function readMentionComposerClipboard(clipboardData: DataTransfer | null | undefined): string {
  if (!clipboardData) return ''
  return (
    clipboardData.getData(MENTION_COMPOSER_CLIPBOARD_MIME)
    || clipboardData.getData(TEXT_PLAIN_CLIPBOARD_MIME)
    || ''
  )
}

export function setMentionComposerCaret(root: HTMLElement, start: number, end: number = start): void {
  const startPoint = pointAtRenderedOffset(root, start)
  const endPoint = start === end ? startPoint : pointAtRenderedOffset(root, end)
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.setStart(startPoint.node, startPoint.offset)
  range.setEnd(endPoint.node, endPoint.offset)
  selection.removeAllRanges()
  selection.addRange(range)
}

function isComposerVisuallyEmpty(root: HTMLElement): boolean {
  const nodes = Array.from(root.childNodes)
  if (nodes.length === 0) return true
  if (nodes.length === 1 && nodes[0].nodeName === 'BR') return true
  return false
}

function serializeNodes(nodes: Node[]): string {
  return nodes.map((node, index) => serializeNode(node, index === nodes.length - 1)).join('')
}

function serializeNode(node: Node, isLast: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? ''
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const element = node as HTMLElement
  const markdown = element.getAttribute(MENTION_COMPOSER_MARKDOWN_ATTR)
  if (markdown) return markdown
  if (element.tagName === 'BR') return '\n'
  const inner = serializeNodes(Array.from(element.childNodes))
  if (BLOCK_TAGS.has(element.tagName) && !isLast) {
    return `${inner}\n`
  }
  return inner
}

function appendTextWithBreaks(parent: HTMLElement, text: string): void {
  if (!text) return
  const parts = text.split('\n')
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (part) parent.appendChild(document.createTextNode(part))
    if (index < parts.length - 1) {
      parent.appendChild(document.createElement('br'))
    }
  }
}

function markdownOffsetFromPoint(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange()
  range.selectNodeContents(root)
  try {
    range.setEnd(node, offset)
  } catch {
    return serializeMentionComposerElement(root).length
  }
  const probe = document.createElement('div')
  probe.appendChild(range.cloneContents())
  return serializeMentionComposerElement(probe).length
}

function pointAtRenderedOffset(root: HTMLElement, target: number): { node: Node; offset: number } {
  let acc = 0
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ''
      if (target <= acc + text.length) {
        return { node, offset: Math.max(0, target - acc) }
      }
      acc += text.length
      continue
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue
    const element = node as HTMLElement
    const markdown = element.getAttribute(MENTION_COMPOSER_MARKDOWN_ATTR)
    if (markdown) {
      if (target <= acc) {
        return { node: root, offset: indexInParent(element) }
      }
      acc += markdown.length
      if (target <= acc) {
        return { node: root, offset: indexInParent(element) + 1 }
      }
      continue
    }
    if (element.tagName === 'BR') {
      acc += 1
      if (target <= acc) {
        return { node: root, offset: indexInParent(element) + 1 }
      }
    }
  }
  return { node: root, offset: root.childNodes.length }
}

function indexInParent(node: HTMLElement): number {
  return node.parentNode ? Array.from(node.parentNode.childNodes).indexOf(node) : 0
}
