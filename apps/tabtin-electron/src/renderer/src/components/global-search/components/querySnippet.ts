const DEFAULT_MAX_SNIPPET_CHARS = 96
const DEFAULT_CONTEXT_BEFORE_CHARS = 28

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

function highlightAllOccurrences(text: string, query: string): string {
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const parts: string[] = []
  let cursor = 0

  while (cursor < text.length) {
    const index = lowerText.indexOf(lowerQuery, cursor)
    if (index < 0) {
      parts.push(text.slice(cursor))
      break
    }
    if (index > cursor) {
      parts.push(text.slice(cursor, index))
    }
    parts.push(`<em>${text.slice(index, index + query.length)}</em>`)
    cursor = index + query.length
  }

  return parts.join('')
}

export function buildQuerySnippetHighlight(
  text: string | null | undefined,
  query: string | null | undefined,
  options: {
    maxChars?: number
    contextBeforeChars?: number
  } = {},
): string {
  const source = normalizeInlineText(text ?? '')
  if (!source) return ''

  const normalizedQuery = normalizeInlineText(query ?? '')
  if (!normalizedQuery) {
    return truncateText(source, options.maxChars ?? DEFAULT_MAX_SNIPPET_CHARS)
  }

  const lowerSource = source.toLowerCase()
  const lowerQuery = normalizedQuery.toLowerCase()
  const firstMatch = lowerSource.indexOf(lowerQuery)
  if (firstMatch < 0) {
    return truncateText(source, options.maxChars ?? DEFAULT_MAX_SNIPPET_CHARS)
  }

  const maxChars = options.maxChars ?? DEFAULT_MAX_SNIPPET_CHARS
  const contextBeforeChars = options.contextBeforeChars ?? DEFAULT_CONTEXT_BEFORE_CHARS
  let start = Math.max(0, firstMatch - contextBeforeChars)
  let end = Math.min(source.length, start + maxChars)

  if (end - start < maxChars && start > 0) {
    start = Math.max(0, end - maxChars)
  }

  const prefix = start > 0 ? '…' : ''
  const suffix = end < source.length ? '…' : ''
  const excerpt = source.slice(start, end).trim()

  return `${prefix}${highlightAllOccurrences(excerpt, normalizedQuery)}${suffix}`
}
