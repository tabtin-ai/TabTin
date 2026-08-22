/**
 * 从 Agent 最终回复提取通知用一句话（首行首句，非 LLM）。
 * 与后端 `compact_agent_notification_summary` 对齐。
 */

const SENTENCE_END = /[。！？!?；;]/
const MARKDOWN_BOLD = /\*\*(.+?)\*\*/g
const MARKDOWN_CODE = /`([^`]+)`/g
const MARKDOWN_HEADING = /^#{1,6}\s+/gm

export const NOTIFICATION_SUMMARY_MAX = 80

/** 铃铛 typeLabel 已表达状态时，这些历史 title 与 type 重复，应降级展示。 */
export const REDUNDANT_AGENT_NOTIFICATION_TITLES = new Set([
  'Agent 任务完成',
  'Agent 任务出错',
  'Agent 已终止',
  'Agent Task Completed',
  'Agent Task Failed',
  'Agent Task Interrupted',
  'Agent Waiting for Confirmation',
  'Agent 等待确认',
])

export function compactNotificationSummary(
  text: string | null | undefined,
  maxLen: number = NOTIFICATION_SUMMARY_MAX,
): string {
  if (!text) return ''
  let cleaned = text.trim()
  if (!cleaned) return ''
  if (maxLen <= 1) return '…'

  const fenceIdx = cleaned.indexOf('```')
  if (fenceIdx >= 0) {
    const before = cleaned.slice(0, fenceIdx).trim()
    if (before) cleaned = before
  }

  cleaned = cleaned
    .replace(MARKDOWN_HEADING, '')
    .replace(MARKDOWN_BOLD, '$1')
    .replace(MARKDOWN_CODE, '$1')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')

  const firstLine = cleaned.split('\n', 1)[0]?.trim().replace(/\s+/g, ' ').trim() ?? ''
  if (!firstLine) return ''

  const match = SENTENCE_END.exec(firstLine)
  const summary = match
    ? firstLine.slice(0, match.index + match[0].length).trim()
    : firstLine

  if (summary.length <= maxLen) return summary
  return `${summary.slice(0, maxLen - 1).trimEnd()}…`
}

export function resolveAgentNotificationDisplay(opts: {
  title: string
  body?: string | null
}): { headline: string; subline: string } {
  const title = (opts.title || '').trim()
  const body = (opts.body || '').trim()
  // 历史落库：title=「Agent 任务完成」+ body=回复截断 → 升格摘要作主标题，去掉重复状态行。
  if (REDUNDANT_AGENT_NOTIFICATION_TITLES.has(title) && body) {
    return {
      headline: compactNotificationSummary(body) || body,
      subline: '',
    }
  }
  return { headline: title, subline: body }
}
