import type { ActionResultRequest } from '../types'

const DEFAULT_TARGET_BYTES = 700_000
const DEFAULT_RESULT_ROW_LIMIT = 12
const DEFAULT_RESULT_CONTENT_LIMIT = 2000

type AnyRecord = Record<string, any>

function utf8ByteLength(input: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(input).length
  }
  return input.length
}

export function estimatePayloadBytes(payload: unknown): number {
  try {
    return utf8ByteLength(JSON.stringify(payload))
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

function cloneResult(result: ActionResultRequest): ActionResultRequest {
  try {
    // Action result payloads should be plain JSON objects.
    return JSON.parse(JSON.stringify(result ?? {}))
  } catch {
    return { ...result }
  }
}

function truncateText(value: string, maxChars: number): { value: string; changed: boolean } {
  if (value.length <= maxChars) {
    return { value, changed: false }
  }
  const keep = Math.max(0, maxChars - 3)
  return { value: value.slice(0, keep) + '...', changed: true }
}

function trimStringField(container: AnyRecord, key: string, maxChars: number): boolean {
  const current = container?.[key]
  if (typeof current !== 'string') return false
  const { value, changed } = truncateText(current, maxChars)
  if (changed) {
    container[key] = value
  }
  return changed
}

function compactSemanticResults(data: AnyRecord): boolean {
  const rows = data?.results
  if (!Array.isArray(rows)) return false

  let changed = false
  if (rows.length > DEFAULT_RESULT_ROW_LIMIT) {
    data.results = rows.slice(0, DEFAULT_RESULT_ROW_LIMIT)
    changed = true
  }

  const nextRows = Array.isArray(data.results) ? data.results : []
  for (const row of nextRows) {
    if (!row || typeof row !== 'object') continue
    if (typeof row.content === 'string') {
      const { value, changed: rowChanged } = truncateText(row.content, DEFAULT_RESULT_CONTENT_LIMIT)
      if (rowChanged) {
        row.content = value
        row.content_truncated = true
        changed = true
      }
    }
  }

  if (changed) {
    data.results_truncated = true
  }
  return changed
}

function minimallyCompactSemanticResults(data: AnyRecord): boolean {
  const rows = data?.results
  if (!Array.isArray(rows)) return false

  data.results = rows.slice(0, 3).map((row: AnyRecord) => {
    const compactRow: AnyRecord = {
      path: row?.path,
      start_line: row?.start_line,
      end_line: row?.end_line,
      similarity: row?.similarity,
      content_truncated: true,
    }
    if (typeof row?.content === 'string') {
      compactRow.content = truncateText(row.content, 800).value
    }
    return compactRow
  })
  data.results_truncated = true
  return true
}

function isSemanticSearchPayload(data: AnyRecord): boolean {
  return (
    Array.isArray(data?.results)
    || typeof data?.index_ready === 'boolean'
    || typeof data?.total_indexed === 'number'
  )
}

function isMcpPayload(data: AnyRecord): boolean {
  return (
    Array.isArray(data?.content)
    || Array.isArray(data?.contents)
    || Array.isArray(data?.messages)
    || data?.structuredContent != null
    || data?.structured_content != null
    || typeof data?.toolName === 'string'
    || typeof data?.tool_name === 'string'
    || typeof data?.promptName === 'string'
    || typeof data?.prompt_name === 'string'
    || typeof data?.uri === 'string'
    || (data?.server != null && typeof data.server === 'object')
  )
}

function compactMcpEntries(entries: unknown, maxItems: number, maxTextChars: number): { value: unknown[]; changed: boolean } {
  if (!Array.isArray(entries)) {
    return { value: [], changed: false }
  }

  let changed = entries.length > maxItems
  const next = entries.slice(0, maxItems).map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') {
      return entry
    }

    const compactEntry: AnyRecord = { ...(entry as AnyRecord) }
    const textChanged = trimStringField(compactEntry, 'text', maxTextChars)
    const dataChanged = trimStringField(compactEntry, 'data', maxTextChars)
    if (textChanged || dataChanged) {
      compactEntry.content_truncated = true
      changed = true
    }
    return compactEntry
  })

  return { value: next, changed }
}

function compactPromptMessages(messages: unknown, maxItems: number, maxTextChars: number): { value: unknown[]; changed: boolean } {
  if (!Array.isArray(messages)) {
    return { value: [], changed: false }
  }

  let changed = messages.length > maxItems
  const next = messages.slice(0, maxItems).map((message: unknown) => {
    if (!message || typeof message !== 'object') {
      return message
    }

    const compactMessage: AnyRecord = { ...(message as AnyRecord) }
    const content = compactMessage.content
    if (Array.isArray(content)) {
      const compacted = compactMcpEntries(content, 4, maxTextChars)
      compactMessage.content = compacted.value
      if (compacted.changed) {
        compactMessage.content_truncated = true
        changed = true
      }
    }
    return compactMessage
  })

  return { value: next, changed }
}

function compactMcpPayload(data: AnyRecord): boolean {
  let changed = false

  for (const key of ['content', 'contents'] as const) {
    const current = data?.[key]
    if (!Array.isArray(current)) continue
    const compacted = compactMcpEntries(current, 6, DEFAULT_RESULT_CONTENT_LIMIT)
    if (compacted.changed) {
      data[key] = compacted.value
      data[`${key}_truncated`] = true
      changed = true
    }
  }

  if (Array.isArray(data.messages)) {
    const compacted = compactPromptMessages(data.messages, 6, DEFAULT_RESULT_CONTENT_LIMIT)
    if (compacted.changed) {
      data.messages = compacted.value
      data.messages_truncated = true
      changed = true
    }
  }

  return changed
}

function minimallyCompactMcpPayload(data: AnyRecord): boolean {
  if (!isMcpPayload(data)) return false

  const minimal: AnyRecord = {}
  if (data.server && typeof data.server === 'object') minimal.server = data.server
  if (typeof data.toolName === 'string') minimal.toolName = data.toolName
  if (typeof data.tool_name === 'string') minimal.tool_name = data.tool_name
  if (typeof data.promptName === 'string') minimal.promptName = data.promptName
  if (typeof data.prompt_name === 'string') minimal.prompt_name = data.prompt_name
  if (typeof data.uri === 'string') minimal.uri = data.uri
  if (typeof data.isError === 'boolean') minimal.isError = data.isError
  if (typeof data.is_error === 'boolean') minimal.is_error = data.is_error

  if (Array.isArray(data.content)) {
    const compacted = compactMcpEntries(data.content, 3, 800)
    minimal.content = compacted.value
    if (compacted.changed) minimal.content_truncated = true
  }
  if (Array.isArray(data.contents)) {
    const compacted = compactMcpEntries(data.contents, 3, 800)
    minimal.contents = compacted.value
    if (compacted.changed) minimal.contents_truncated = true
  }
  if (Array.isArray(data.messages)) {
    const compacted = compactPromptMessages(data.messages, 3, 800)
    minimal.messages = compacted.value
    if (compacted.changed) minimal.messages_truncated = true
  }
  if (data.structuredContent != null || data.structured_content != null) {
    minimal.structured_content_truncated = true
  }

  for (const key of Object.keys(data)) {
    delete data[key]
  }
  Object.assign(data, minimal)
  return true
}

export interface CompactActionResult {
  result: ActionResultRequest
  changed: boolean
  estimatedBytes: number
}

/**
 * Compact action result payload so it is likely to pass WS transport size limits.
 * This function prefers preserving essential semantic-search metadata first.
 */
export function compactActionResultForTransport(
  result: ActionResultRequest,
  targetBytes: number = DEFAULT_TARGET_BYTES,
): CompactActionResult {
  const compact = cloneResult(result)
  let changed = false

  // First pass: semantic-search aware compaction and obvious large blobs.
  if (compact.data && typeof compact.data === 'object') {
    changed = compactSemanticResults(compact.data as AnyRecord) || changed
    changed = compactMcpPayload(compact.data as AnyRecord) || changed
  }
  changed = trimStringField(compact as AnyRecord, 'clean_html', 120_000) || changed
  changed = trimStringField(compact as AnyRecord, 'skeleton_html', 120_000) || changed

  if (typeof compact.screenshot_base64 === 'string' && compact.screenshot_base64.length > 0) {
    delete compact.screenshot_base64
    changed = true
  }
  if (compact.snapshot && typeof compact.snapshot === 'object') {
    const snap = compact.snapshot as AnyRecord
    if (typeof snap.screenshot_base64 === 'string' && snap.screenshot_base64.length > 0) {
      delete snap.screenshot_base64
      changed = true
    }
  }

  let estimatedBytes = estimatePayloadBytes(compact)
  if (estimatedBytes <= targetBytes) {
    return { result: compact, changed, estimatedBytes }
  }

  // Progressive fallback: drop/trim optional heavyweight fields.
  const pruneSteps: Array<() => boolean> = [
    () => {
      const data = compact.data as AnyRecord
      if (data && Array.isArray(data.results) && data.results.length > 6) {
        data.results = data.results.slice(0, 6)
        data.results_truncated = true
        return true
      }
      return false
    },
    () => trimStringField(compact as AnyRecord, 'clean_html', 60_000),
    () => trimStringField(compact as AnyRecord, 'skeleton_html', 60_000),
    () => {
      if (compact.snapshot != null) {
        delete compact.snapshot
        return true
      }
      return false
    },
    () => {
      if (Array.isArray(compact.observed_elements) && compact.observed_elements.length > 20) {
        compact.observed_elements = compact.observed_elements.slice(0, 20)
        return true
      }
      return false
    },
    () => {
      if (Array.isArray(compact.executed_actions) && compact.executed_actions.length > 10) {
        compact.executed_actions = compact.executed_actions.slice(0, 10)
        return true
      }
      return false
    },
    () => {
      if (compact.data && typeof compact.data === 'object') {
        const data = compact.data as AnyRecord
        if (isSemanticSearchPayload(data)) {
          const minimal: AnyRecord = {}
          if (Array.isArray(data.results)) {
            minimal.results = data.results
            minimallyCompactSemanticResults(minimal)
          }
          if (typeof data.index_ready === 'boolean') minimal.index_ready = data.index_ready
          if (typeof data.total_indexed === 'number') minimal.total_indexed = data.total_indexed
          compact.data = minimal
          return true
        }
        if (isMcpPayload(data)) {
          return minimallyCompactMcpPayload(data)
        }
      }
      return false
    },
  ]

  for (const step of pruneSteps) {
    if (estimatedBytes <= targetBytes) break
    if (step()) {
      changed = true
      estimatedBytes = estimatePayloadBytes(compact)
    }
  }

  if (estimatedBytes > targetBytes) {
    const failedResult: ActionResultRequest = {
      success: false,
      trace_id: compact.trace_id,
      error: 'Frontend action result exceeded transport size limits and could not be safely compacted. Please retry with a narrower request.',
      data: {
        transport_truncated: true,
        original_success: compact.success === true,
      },
    }
    return {
      result: failedResult,
      changed: true,
      estimatedBytes: estimatePayloadBytes(failedResult),
    }
  }

  return { result: compact, changed, estimatedBytes }
}
