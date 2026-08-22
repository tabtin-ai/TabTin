import { createLogger } from '@/utils/logger'

const log = createLogger('TabRestore')

const TRACE_STORAGE_KEY = '__tabtin_trace_tab_restore'

function readTraceOverride(): boolean | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(TRACE_STORAGE_KEY)
    if (raw === '0' || raw === 'false') return false
    if (raw === '1' || raw === 'true') return true
  } catch {
    // ignore storage access failures
  }
  return null
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(sanitizeTraceValue(value))
  } catch {
    return String(value)
  }
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return value
  }
}

function truncatePath(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 3) return value
  return `.../${parts.slice(-3).join('/')}`
}

function sanitizeTraceValue(value: unknown, keyHint = '', seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return sanitizeUrl(value)
    if (/(^|\/)(Users|home|var|tmp)\//.test(value) || /cwd|path|file/i.test(keyHint)) {
      return truncatePath(value)
    }
    return value
  }
  if (value == null || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const limit = 30
    const next = value.slice(0, limit).map(item => sanitizeTraceValue(item, keyHint, seen))
    if (value.length > limit) next.push(`...${value.length - limit} more`)
    seen.delete(value)
    return next
  }
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  const next: Record<string, unknown> = {}
  Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
    next[key] = sanitizeTraceValue(entry, key, seen)
  })
  seen.delete(value)
  return next
}

export function shouldTraceTabRestore(): boolean {
  const override = readTraceOverride()
  if (override !== null) return override
  if (typeof globalThis !== 'undefined' && Boolean((globalThis as Record<string, unknown>).__TABTIN_TRACE_TAB_RESTORE__)) {
    return true
  }
  return false
}

export function traceTabRestore(stage: string, payload?: Record<string, unknown>): void {
  if (!shouldTraceTabRestore()) return
  const suffix = payload ? ` ${safeStringify(payload)}` : ''
  log.info(`${new Date().toISOString()} ${stage}${suffix}`)
}
