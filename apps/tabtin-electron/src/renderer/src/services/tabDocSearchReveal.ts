export interface TabDocSearchRevealInput {
  blockId?: string | null
  blockIds?: unknown
  blockPreview?: string | null
  snippet?: string | null
  highlightPreview?: unknown
  highlightContent?: unknown
}

export interface TabDocSearchRevealPayload {
  blockIds?: string[]
  fullText?: string
}

export function stripSearchHighlightTags(value: string): string {
  return value.replace(/<\/?em>/gi, '')
}

export function normalizeSearchRevealText(value: string): string {
  return stripSearchHighlightTags(value)
    .replace(/^\s*\.\.\./, '')
    .replace(/\.\.\.\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function firstSearchString(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const first = value.find((item): item is string => typeof item === 'string' && item.trim().length > 0)
    return first ?? ''
  }
  return ''
}

export function textContainsSearchQuery(text: string, query: string): boolean {
  const normalizedText = text.toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedText || !normalizedQuery) return false
  if (normalizedText.includes(normalizedQuery)) return true

  const terms = normalizedQuery.match(/[\w\u4e00-\u9fff]+/g) ?? []
  return terms.some(term => term.length >= 2 && normalizedText.includes(term))
}

function normalizeBlockIds(input: TabDocSearchRevealInput): string[] {
  const rawIds = [
    input.blockId,
    ...((Array.isArray(input.blockIds) ? input.blockIds : []) as unknown[]),
  ]

  return rawIds
    .map(firstSearchString)
    .map(id => id.trim())
    .filter((id, index, arr) => id.length > 0 && arr.indexOf(id) === index)
}

export function buildTabDocSearchReveal(input: TabDocSearchRevealInput): TabDocSearchRevealPayload | null {
  const blockIds = normalizeBlockIds(input)
  const fullText = normalizeSearchRevealText(
    firstSearchString(input.blockPreview)
      || firstSearchString(input.highlightPreview)
      || firstSearchString(input.snippet)
      || firstSearchString(input.highlightContent),
  )

  if (!blockIds.length && !fullText) return null
  return {
    ...(blockIds.length > 0 ? { blockIds } : {}),
    ...(fullText ? { fullText } : {}),
  }
}
