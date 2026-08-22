/**
 * 将诊断内容拼成适合粘贴给 AI / 聊天的纯文本。
 *
 * 剪贴板路径默认只取「最近 5 分钟」现场：meta 全量 + 时间窗内的
 * errors / breadcrumbs / renderer.log / main.log。zip 导出仍走全量，不受此限。
 */

import type { LogEntry } from '@/services/logCollector'
import { formatLogEntries } from '@/services/logCollector'
import type { Breadcrumb } from '@/services/errorReporter'
import type { DiagnosticsMeta } from './collectContext'
import { redact, redactJson } from './redact'

/** 剪贴板时间窗：只保留门槛之后的日志（默认 5 分钟）。 */
export const CLIPBOARD_WINDOW_MS = 5 * 60 * 1000

/** 总长硬顶（5 分钟通常远小于此；防极端刷屏）。 */
export const MAX_DIAGNOSTICS_CLIPBOARD_CHARS = 200_000

/** electron-log 行首：`[2026-07-04 18:02:36.114]`（无时区，按本机本地时间解析） */
const MAIN_LOG_LINE_TS = /^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\]/

export function clipboardWindowSince(nowMs: number = Date.now()): number {
  return nowMs - CLIPBOARD_WINDOW_MS
}

function parseIsoLike(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

/** 解析 main.log 行首时间；无 Z/offset 时按本地墙钟（与 electron-log 落盘一致）。 */
export function parseMainLogLineTimestamp(raw: string): number | null {
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T')
  return parseIsoLike(normalized)
}

/** 过滤环形缓冲条目（`ts` 为 ISO）。 */
export function filterLogEntriesSince(entries: LogEntry[], sinceMs: number): LogEntry[] {
  return entries.filter((e) => {
    const t = parseIsoLike(e.ts)
    return t !== null && t >= sinceMs
  })
}

/** 过滤带 ISO 时间字段的对象数组。 */
export function filterTimedItemsSince<T>(
  items: T[],
  getTs: (item: T) => unknown,
  sinceMs: number,
): T[] {
  return items.filter((item) => {
    const t = parseIsoLike(getTs(item))
    return t !== null && t >= sinceMs
  })
}

/**
 * 按行过滤 main.log：识别 `[YYYY-MM-DD HH:mm:ss.SSS]`。
 * 无时间戳的续行：仅当上一行已在窗内时保留。
 */
export function filterMainLogTextSince(text: string, sinceMs: number): string {
  if (!text) return ''
  const kept: string[] = []
  let inWindow = false
  for (const line of text.split('\n')) {
    const m = MAIN_LOG_LINE_TS.exec(line)
    if (m) {
      const t = parseMainLogLineTimestamp(m[1])
      inWindow = t !== null && t >= sinceMs
      if (inWindow) kept.push(line)
    } else if (inWindow && line.length > 0) {
      kept.push(line)
    }
  }
  return kept.join('\n')
}

/**
 * 总长兜底：保留头部。
 */
export function truncateDiagnosticsClipboardText(
  text: string,
  maxChars: number = MAX_DIAGNOSTICS_CLIPBOARD_CHARS,
): string {
  if (text.length <= maxChars) return text
  const kb = Math.round(maxChars / 1024)
  const marker = `\n…[剪贴板内容已截断，已保留前 ${kb}KB]\n`
  const bodyBudget = Math.max(0, maxChars - marker.length)
  return `${text.slice(0, bodyBudget)}${marker}`
}

export interface DiagnosticsClipboardInput {
  meta: DiagnosticsMeta
  /** 已按时间窗过滤后的 renderer 文本；也可直接传原文本再由 builder 信任 caller */
  rendererLog: string
  breadcrumbs: unknown
  errors: unknown
  mainLog: string | null
  /** 剪贴板默认不带 old.log（上一轮归档几乎不在 5 分钟窗内） */
  mainLogNote?: string
  /** 时间窗下界（ISO），写入文案方便 AI 理解口径 */
  windowSinceIso: string
  windowMs: number
}

export function buildDiagnosticsClipboardText(input: DiagnosticsClipboardInput): string {
  const windowMin = Math.round(input.windowMs / 60_000)
  const sections: string[] = [
    'TabTin Client Diagnostics (clipboard)',
    '='.repeat(48),
    `window: last ${windowMin} minute(s) (since ${input.windowSinceIso})`,
    '',
    '## meta.json',
    redactJson(input.meta),
    '',
    '## recent-errors.json',
    redactJson(input.errors),
    '',
    '## breadcrumbs.json',
    redactJson(input.breadcrumbs),
    '',
    '## renderer.log',
    redact(input.rendererLog) || `(最近 ${windowMin} 分钟内界面层暂无日志)`,
  ]

  if (input.mainLog) {
    sections.push('', '## main.log', redact(input.mainLog))
  } else if (input.mainLogNote) {
    sections.push('', `## main.log (${input.mainLogNote})`)
  } else {
    sections.push('', `## main.log`, `(最近 ${windowMin} 分钟内主进程日志为空)`)
  }

  return truncateDiagnosticsClipboardText(sections.join('\n'))
}

/** 组装剪贴板用的时间窗过滤结果（纯函数，便于单测）。 */
export function prepareClipboardDiagnostics<ErrorItem extends { occurred_at?: string }>(args: {
  meta: DiagnosticsMeta
  logEntries: LogEntry[]
  breadcrumbs: Breadcrumb[]
  errors: ErrorItem[]
  mainLog: string | null
  mainLogNote?: string
  nowMs?: number
  windowMs?: number
}): DiagnosticsClipboardInput {
  const windowMs = args.windowMs ?? CLIPBOARD_WINDOW_MS
  const nowMs = args.nowMs ?? Date.now()
  const sinceMs = nowMs - windowMs
  const windowSinceIso = new Date(sinceMs).toISOString()

  const rendererEntries = filterLogEntriesSince(args.logEntries, sinceMs)
  const breadcrumbs = filterTimedItemsSince(args.breadcrumbs, (b) => b.timestamp, sinceMs)
  const errors = filterTimedItemsSince(args.errors, (e) => e.occurred_at, sinceMs)
  const mainFiltered = args.mainLog ? filterMainLogTextSince(args.mainLog, sinceMs) : ''

  let mainLogNote = args.mainLogNote
  if (args.mainLog && !mainFiltered) {
    mainLogNote = `最近 ${Math.round(windowMs / 60_000)} 分钟内无主进程日志行`
  }

  return {
    meta: args.meta,
    rendererLog: formatLogEntries(rendererEntries),
    breadcrumbs,
    errors,
    mainLog: mainFiltered || null,
    mainLogNote,
    windowSinceIso,
    windowMs,
  }
}
