import type { EditorInstance } from 'novel'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'

export interface RevealDocSelectionOptions {
  blockIds?: string[]
  fullText?: string
  highlightMs?: number
}

export interface RevealDocSelectionResult {
  matched: boolean
  strategy: 'blockId' | 'fullText' | 'none'
  blockId?: string
  duplicateTextMatches?: number
}

const REVEAL_HIGHLIGHT_CLASS = 'tabdoc-source-reveal-highlight'
const DEFAULT_HIGHLIGHT_MS = 1800

function getNodeStringAttr(node: ProseMirrorNode, key: string): string | null {
  const value = (node.attrs as Record<string, unknown> | null | undefined)?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeBlockIds(blockIds: string[] | undefined): string[] {
  return (blockIds ?? [])
    .map(id => id.trim())
    .filter((id, index, arr) => id.length > 0 && arr.indexOf(id) === index)
}

function findFirstBlockById(doc: ProseMirrorNode, blockIds: string[]): { node: ProseMirrorNode; pos: number; blockId: string } | null {
  if (blockIds.length === 0) return null
  const wanted = new Set(blockIds)
  let match: { node: ProseMirrorNode; pos: number; blockId: string } | null = null
  doc.descendants((node, pos) => {
    if (match) return false
    const blockId = getNodeStringAttr(node, 'blockId') ?? getNodeStringAttr(node, 'id')
    if (blockId && wanted.has(blockId)) {
      match = { node, pos, blockId }
      return false
    }
    return false
  })
  return match
}

function findFirstBlockByText(doc: ProseMirrorNode, fullText: string | undefined): { node: ProseMirrorNode; pos: number; matchCount: number } | null {
  const needle = normalizeText(fullText ?? '')
  if (!needle) return null

  let firstNode: ProseMirrorNode | null = null
  let firstPos = 0
  let matchCount = 0
  doc.descendants((node, pos) => {
    const haystack = normalizeText(node.textContent)
    if (haystack && (haystack.includes(needle) || needle.includes(haystack))) {
      matchCount += 1
      if (!firstNode) {
        firstNode = node
        firstPos = pos
      }
    }
    return false
  })

  if (!firstNode) return null
  return { node: firstNode, pos: firstPos, matchCount }
}

function asElement(value: unknown): HTMLElement | null {
  if (value instanceof HTMLElement) return value
  if (value instanceof Text) return value.parentElement
  return null
}

function resolveNodeElement(view: EditorView, pos: number): HTMLElement | null {
  const direct = asElement(view.nodeDOM(pos))
  if (direct) return direct

  const next = asElement(view.nodeDOM(pos + 1))
  if (next) return next

  try {
    const domAtPos = view.domAtPos(pos + 1)
    const element = asElement(domAtPos.node)
    return element?.closest('.ProseMirror > *') as HTMLElement | null
  } catch {
    return null
  }
}

function scrollToElement(container: HTMLElement, element: HTMLElement): void {
  const cRect = container.getBoundingClientRect()
  const eRect = element.getBoundingClientRect()
  container.scrollTo({
    top: eRect.top - cRect.top + container.scrollTop - 24,
    behavior: 'smooth',
  })
}

function highlightElement(element: HTMLElement, highlightMs: number): void {
  element.classList.add(REVEAL_HIGHLIGHT_CLASS)
  window.setTimeout(() => {
    element.classList.remove(REVEAL_HIGHLIGHT_CLASS)
  }, highlightMs)
}

export function revealDocSelection(
  editor: EditorInstance | null | undefined,
  scrollContainer: HTMLElement | null | undefined,
  options: RevealDocSelectionOptions,
): RevealDocSelectionResult {
  const view = editor?.view
  const doc = editor?.state?.doc
  if (!view || !doc || !scrollContainer) {
    return { matched: false, strategy: 'none' }
  }

  const blockIds = normalizeBlockIds(options.blockIds)
  const byId = findFirstBlockById(doc, blockIds)
  if (byId) {
    const element = resolveNodeElement(view, byId.pos)
    if (element) {
      scrollToElement(scrollContainer, element)
      highlightElement(element, options.highlightMs ?? DEFAULT_HIGHLIGHT_MS)
      return { matched: true, strategy: 'blockId', blockId: byId.blockId }
    }
  }

  const byText = findFirstBlockByText(doc, options.fullText)
  if (byText) {
    const element = resolveNodeElement(view, byText.pos)
    if (element) {
      scrollToElement(scrollContainer, element)
      highlightElement(element, options.highlightMs ?? DEFAULT_HIGHLIGHT_MS)
      return {
        matched: true,
        strategy: 'fullText',
        duplicateTextMatches: byText.matchCount,
      }
    }
  }

  return { matched: false, strategy: 'none' }
}
